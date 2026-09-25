import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PanelConfig } from "../config.ts";
import { nowIso, Store } from "../db.ts";
import type {
  AppRecord,
  AppStatus,
  AppSummary,
  ContainerResources,
  EnvVar,
  ReleaseRecord,
  RuntimeKind,
} from "../types.ts";
import { DockerService } from "../docker/service.ts";
import { getRuntime, parsePortMappings, renderInstallCommand, renderStartCommand } from "../docker/templates.ts";
import { extractZip } from "../util/archive.ts";
import { chownRecursive, dirSize, ensureDir, listDirectory, pathExists, rmrf } from "../util/fsx.ts";
import { humanBytes } from "../util/format.ts";
import { KeyedMutex } from "../util/mutex.ts";
import { isValidSlug, uniqueSlug } from "../util/slug.ts";
import { ConflictError, NotFoundError, ValidationError, errorMessage } from "../errors.ts";
import type { NotifyKind } from "../notify/webhooks.ts";
import { detectProject } from "./detect.ts";
import {
  commandIssues,
  cpuProblem,
  envIssues,
  imageExistenceIssue,
  imageIssues,
  memoryProblem,
  pidsProblem,
  portsIssues,
  throwIfInvalid,
  type ValidationIssue,
} from "./validate.ts";
import { buildContainerSpec, containerNameFor, networkNameFor, restartPolicyFor, toCreateOptions } from "./spec.ts";
import { applyStopIntent } from "./status.ts";
import {
  CONTAINER_APP_DIR,
  CONTAINER_DATA_DIR,
  CONTAINER_PYTHON_PACKAGES,
  appRoot,
  releaseDir,
  releasesDir,
  sharedDir,
  tmpDir,
} from "./paths.ts";

export interface CreateAppInput {
  name: string;
  description?: string;
  /** URL (http/https) do ícone exibido no painel. */
  iconUrl?: string;
  runtime: RuntimeKind;
  image?: string;
  entry?: string;
  startCommand?: string;
  installCommand?: string;
  depsFile?: string;
  memoryMb?: number;
  cpu?: number;
  pidsLimit?: number;
  env?: EnvVar[];
  ports?: string[];
  autoStart?: boolean;
  autoRestart?: boolean;
  slug?: string;
}

export type UpdateAppInput = Partial<CreateAppInput>;

export interface DeployResult {
  deploymentId: number;
  releaseSeq: number;
}

export interface StartedDeploy extends DeployResult {
  /** Resolve quando o deploy (assíncrono) terminar. */
  finished: Promise<void>;
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

/** Acumula o log do deployment e grava em lote no banco. */
export class DeploymentLog {
  private readonly store: Store;
  private readonly id: number;
  private buffer: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(store: Store, id: number) {
    this.store = store;
    this.id = id;
  }

  write = (text: string): void => {
    this.buffer.push(text);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 150);
      this.timer.unref?.();
    }
  };

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const chunkText = this.buffer.join("");
    this.buffer = [];
    this.store.appendDeploymentLog(this.id, chunkText);
  }
}

/** Gancho de ciclo de vida — conectado ao NotifyService em server.ts. */
export type LifecycleHook = (kind: NotifyKind, app: { name: string; slug: string; autoRestart: boolean }) => void;

export class AppService {
  private readonly config: PanelConfig;
  private readonly store: Store;
  private readonly docker: DockerService;
  private readonly locks = new KeyedMutex();
  /** Cache do uso de disco (varrer node_modules a cada poll seria caro). */
  private readonly diskCache = new Map<string, { bytes: number; at: number }>();
  /** Avisos (webhooks): preenchido pelo server.ts após a construção. */
  onLifecycle: LifecycleHook | null = null;
  /** Marca intenção de ação manual (o observador de status se cala). */
  onIntent: ((slug: string) => void) | null = null;

  constructor(config: PanelConfig, store: Store, docker: DockerService) {
    this.config = config;
    this.store = store;
    this.docker = docker;
  }

  /** Notifica o gancho de ciclo de vida sem nunca bloquear a ação. */
  private emit(kind: NotifyKind, app: AppRecord): void {
    try {
      this.onLifecycle?.(kind, { name: app.name, slug: app.slug, autoRestart: app.autoRestart });
    } catch {
      // aviso nunca derruba a operação que o causou
    }
  }

  // ------------------------------------------------------------ consultas

  async list(): Promise<AppSummary[]> {
    const apps = this.store.listApps();
    const summaries: AppSummary[] = [];
    for (const group of chunk(apps, 8)) {
      const resolved = await Promise.all(group.map((app) => this.summarize(app)));
      summaries.push(...resolved);
    }
    return summaries;
  }

  async get(slug: string): Promise<AppSummary> {
    const app = this.mustGet(slug);
    const summary = await this.summarize(app);
    summary.diskBytes = await this.diskUsage(slug);
    return summary;
  }

  private async summarize(app: AppRecord): Promise<AppSummary> {
    let status: AppStatus = "stopped";
    let resources: ContainerResources | null = null;
    if (app.activeRelease > 0) {
      const name = containerNameFor(app.slug);
      // Nunca derruba a listagem inteira por causa de uma aplicação: se o daemon
      // estiver inacessível, o status fica "unknown" (e não "parado").
      status = await this.docker.status(name).catch(() => "unknown" as AppStatus);
      status = applyStopIntent(status, app.stoppedByUser);
      if (status === "running" || status === "starting") {
        resources = await this.docker.resources(name).catch(() => null);
      }
    }
    return {
      ...app,
      status,
      resources,
      releaseCount: this.store.countReleases(app.id),
      diskBytes: 0,
    };
  }

  mustGet(slug: string): AppRecord {
    const app = this.store.getApp(slug);
    if (!app) throw new NotFoundError(`Aplicação "${slug}" não encontrada.`);
    return app;
  }

  /** Comandos que serão realmente executados, calculados a partir da configuração. */
  effectiveCommands(app: AppRecord, presentFiles: string[] = []): { startCommand: string | null; installCommand: string | null; error: string | null } {
    try {
      return {
        startCommand: renderStartCommand(app),
        installCommand: renderInstallCommand(app, presentFiles) || null,
        error: null,
      };
    } catch (error) {
      return { startCommand: null, installCommand: null, error: errorMessage(error) };
    }
  }

  // ------------------------------------------------------------ criação

  async create(input: CreateAppInput): Promise<AppRecord> {
    const name = (input.name ?? "").trim();
    if (name.length < 2 || name.length > 48) {
      throw new ValidationError("O nome deve ter entre 2 e 48 caracteres.", undefined, "name.length");
    }

    const runtime = getRuntime(input.runtime);
    const issues: ValidationIssue[] = [];
    const slug = input.slug ? this.validateSlug(input.slug) : uniqueSlug(name, (candidate) => this.store.slugTaken(candidate));
    const image = (input.image ?? runtime.image).trim();
    issues.push(...imageIssues(image, this.config.allowedImages));
    issues.push(...envIssues(input.env ?? []));
    issues.push(...portsIssues(input.ports ?? []));
    const memory = memoryProblem(input.memoryMb ?? 512);
    if (memory) issues.push(memory);
    const cpu = cpuProblem(input.cpu ?? 1);
    if (cpu) issues.push(cpu);
    const pids = pidsProblem(input.pidsLimit ?? 256);
    if (pids) issues.push(pids);
    // Na criação ainda não há ZIP: a detecção de dependências vem depois, no
    // deploy. O comando de start é validado aqui (runtime livre, etc.).
    issues.push(...commandIssues(runtime.kind, input.entry ?? "", input.startCommand ?? ""));
    // Imagem inexistente é recusada na criação: é o erro de digitação clássico
    // que antes só aparecia depois, como deploy falho. Registry indisponível
    // não bloqueia (indeterminate → null).
    const existence = await imageExistenceIssue(this.docker, image);
    if (existence) issues.push(existence);
    throwIfInvalid(issues, "Não foi possível criar a aplicação.");

    const app: AppRecord = {
      id: randomUUID(),
      slug,
      name,
      description: (input.description ?? "").trim().slice(0, 280),
      iconUrl: this.validateIconUrl(input.iconUrl ?? ""),
      runtime: runtime.kind,
      image,
      entry: (input.entry ?? "").trim(),
      startCommand: (input.startCommand ?? "").trim(),
      installCommand: (input.installCommand ?? "").trim(),
      depsFile: (input.depsFile ?? "").trim(),
      memoryMb: this.validateMemory(input.memoryMb ?? 512),
      cpu: this.validateCpu(input.cpu ?? 1),
      pidsLimit: this.validatePids(input.pidsLimit ?? 256),
      env: this.validateEnv(input.env ?? []),
      ports: this.validatePorts(input.ports ?? []),
      autoStart: input.autoStart ?? true,
      autoRestart: input.autoRestart ?? true,
      stoppedByUser: false,
      activeRelease: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    await this.ensureLayout(app);
    this.store.insertApp(app);
    this.store.addEvent(app.id, "info", `Aplicação "${app.name}" criada`);
    return app;
  }

  async update(slug: string, patch: UpdateAppInput, options: { recreate?: boolean } = {}): Promise<AppRecord> {
    const app = this.mustGet(slug);
    const changes: Partial<AppRecord> = {};

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name.length < 2 || name.length > 48) {
        throw new ValidationError("O nome deve ter entre 2 e 48 caracteres.", undefined, "name.length");
      }
      changes.name = name;
    }
    if (patch.description !== undefined) changes.description = patch.description.trim().slice(0, 280);
    if (patch.iconUrl !== undefined) changes.iconUrl = this.validateIconUrl(patch.iconUrl);
    if (patch.runtime !== undefined) changes.runtime = getRuntime(patch.runtime).kind;
    if (patch.image !== undefined) {
      const image = patch.image.trim();
      const imageProblems = imageIssues(image, this.config.allowedImages);
      const existence = await imageExistenceIssue(this.docker, image);
      if (existence) imageProblems.push(existence);
      throwIfInvalid(imageProblems, "Imagem Docker inválida.");
      changes.image = image;
    }
    if (patch.entry !== undefined) changes.entry = patch.entry.trim();
    if (patch.startCommand !== undefined) changes.startCommand = patch.startCommand.trim();
    if (patch.installCommand !== undefined) changes.installCommand = patch.installCommand.trim();
    if (patch.depsFile !== undefined) changes.depsFile = patch.depsFile.trim();
    if (patch.memoryMb !== undefined || patch.cpu !== undefined || patch.pidsLimit !== undefined || patch.env !== undefined || patch.ports !== undefined) {
      // Revalida sobre a configuração resultante: um patch parcial combina com o
      // estado atual, então os problemas são sempre da configuração completa.
      const merged = { ...app, ...patch } as AppRecord;
      const updateIssues: ValidationIssue[] = [];
      if (patch.memoryMb !== undefined) {
        const memory = memoryProblem(merged.memoryMb);
        if (memory) updateIssues.push(memory);
        changes.memoryMb = merged.memoryMb;
      }
      if (patch.cpu !== undefined) {
        const cpuIssue = cpuProblem(merged.cpu);
        if (cpuIssue) updateIssues.push(cpuIssue);
        changes.cpu = merged.cpu;
      }
      if (patch.pidsLimit !== undefined) {
        const pids = pidsProblem(merged.pidsLimit);
        if (pids) updateIssues.push(pids);
        changes.pidsLimit = merged.pidsLimit;
      }
      if (patch.env !== undefined) {
        updateIssues.push(...envIssues(merged.env));
        changes.env = merged.env;
      }
      if (patch.ports !== undefined) {
        updateIssues.push(...portsIssues(merged.ports));
        changes.ports = merged.ports;
      }
      if (patch.entry !== undefined || patch.startCommand !== undefined || patch.runtime !== undefined) {
        updateIssues.push(...commandIssues(merged.runtime, merged.entry, merged.startCommand));
      }
      throwIfInvalid(updateIssues, "Não foi possível salvar a configuração.");
    }
    if (patch.autoStart !== undefined) changes.autoStart = patch.autoStart;
    if (patch.autoRestart !== undefined) changes.autoRestart = patch.autoRestart;

    if (Object.keys(changes).length > 0) this.store.updateApp(app.id, changes);
    const updated = this.store.getAppById(app.id);
    if (!updated) throw new NotFoundError();

    if ((options.recreate ?? true) && updated.activeRelease > 0) {
      const name = containerNameFor(updated.slug);
      const status = await this.docker.status(name);
      const exists = (await this.docker.inspect(name)) !== null;
      if (exists) {
        const shouldRun = status === "running" || status === "starting" || status === "restarting";
        await this.locks.run(updated.slug, () => this.applyContainer(updated, shouldRun));
      }
    }
    return updated;
  }

  async remove(slug: string, deleteFiles: boolean): Promise<void> {
    const app = this.mustGet(slug);
    await this.locks.run(slug, async () => {
      // Container inexistente é 404 e já é tolerado dentro de `docker.remove`.
      // Com o daemon inacessível não dá para garantir que o container saia do
      // ar: engolir essa falha apagaria a aplicação da interface enquanto o bot
      // continuaria rodando — e a política `unless-stopped` o traria de volta
      // sozinho, sem nenhuma forma de administrá-lo pelo painel. Aplicações sem
      // release publicado nunca tiveram container, então a exclusão segue.
      await this.docker.remove(containerNameFor(app.slug), true).catch((error: unknown) => {
        if (app.activeRelease > 0) throw error;
      });
      await this.docker.removeNetwork(networkNameFor(app.slug));
      this.store.deleteApp(app.id);
      this.diskCache.delete(slug);
      if (deleteFiles) await rmrf(appRoot(this.config.dataDir, app.slug));
    });
    this.store.addEvent(null, "info", `Aplicação "${app.name}" removida`);
  }

  // ------------------------------------------------------------ execução

  /** Sobe o container da aplicação (recriando-o se ele não existir mais). */
  private async startContainer(app: AppRecord): Promise<void> {
    const name = containerNameFor(app.slug);
    const inspected = await this.docker.inspect(name);
    if (!inspected) {
      await this.applyContainer(app, true);
      return;
    }
    const status = await this.docker.status(name);
    if (status === "running" || status === "starting") return;
    await this.docker.start(name);
  }

  async start(slug: string): Promise<void> {
    const app = this.mustGet(slug);
    if (app.activeRelease <= 0) throw new ValidationError("Publique um release antes de iniciar a aplicação.");
    await this.locks.run(slug, () => this.startContainer(app));
    this.store.updateApp(app.id, { stoppedByUser: false });
    this.store.addEvent(app.id, "info", "Aplicação iniciada");
    this.emit("started", app);
  }

  /**
   * Sobe, na inicialização do painel, as aplicações marcadas com "iniciar junto
   * com o sistema" — e mantém a política de reinício de cada container alinhada
   * com os dois interruptores (o `autoRestart` pode ter mudado enquanto o painel
   * estava fora do ar, por exemplo).
   *
   * O que o usuário parou de propósito é respeitado: aplicação com
   * `stoppedByUser` nunca é ressuscitada por aqui.
   */
  async startAutoApps(): Promise<{ started: string[]; policies: string[]; failed: { slug: string; error: string }[] }> {
    const started: string[] = [];
    const policies: string[] = [];
    const failed: { slug: string; error: string }[] = [];

    for (const app of this.store.listApps()) {
      if (app.activeRelease <= 0) continue;
      try {
        const container = containerNameFor(app.slug);
        const policy = restartPolicyFor(app);
        if ((await this.docker.restartPolicyOf(container)) !== policy) {
          await this.docker.updateRestartPolicy(container, policy);
          policies.push(app.slug);
        }
        if (!app.autoStart || app.stoppedByUser) continue;
        const status = await this.docker.status(container);
        // `unknown` = daemon inacessível (não dá para agir com segurança) e
        // `running`/`starting` = já está no ar, nada a fazer.
        if (status === "unknown" || status === "running" || status === "starting") continue;
        await this.locks.run(app.slug, () => this.startContainer(app));
        this.store.updateApp(app.id, { stoppedByUser: false });
        this.store.addEvent(app.id, "info", "Aplicação iniciada junto com o sistema");
        this.emit("started", app);
        started.push(app.slug);
      } catch (error) {
        failed.push({ slug: app.slug, error: errorMessage(error) });
      }
    }

    return { started, policies, failed };
  }

  async stop(slug: string): Promise<void> {
    const app = this.mustGet(slug);
    // Registra a intenção ANTES de parar: assim o instante entre o comando e o
    // container encerrar já é lido como "parado pelo usuário", e não como falha.
    this.store.updateApp(app.id, { stoppedByUser: true });
    this.onIntent?.(slug);
    try {
      await this.locks.run(slug, async () => {
        await this.docker.stop(containerNameFor(app.slug), 10);
      });
    } catch (error) {
      // Se parar falhou, o container pode continuar de pé — e um status
      // "running" tem precedência sobre a intenção, então nada é mascarado.
      throw error;
    }
    this.store.addEvent(app.id, "info", "Aplicação parada");
    this.emit("stopped", app);
  }

  async restart(slug: string): Promise<void> {
    const app = this.mustGet(slug);
    if (app.activeRelease <= 0) throw new ValidationError("Publique um release antes de reiniciar a aplicação.");
    await this.locks.run(slug, async () => {
      const name = containerNameFor(app.slug);
      const inspected = await this.docker.inspect(name);
      if (!inspected) {
        await this.applyContainer(app, true);
        return;
      }
      const status = await this.docker.status(name);
      if (status === "running" || status === "starting" || status === "restarting") {
        await this.docker.restart(name, 10);
      } else {
        await this.applyContainer(app, true);
      }
    });
    this.onIntent?.(slug);
    // Reiniciar é uma intenção explícita de manter rodando: se o container
    // voltar a morrer sozinho, isso deve aparecer como falha.
    this.store.updateApp(app.id, { stoppedByUser: false });
    this.store.addEvent(app.id, "info", "Aplicação reiniciada");
    this.emit("restarted", app);
  }

  async logs(slug: string, tail = 400): Promise<string> {
    const app = this.mustGet(slug);
    if (app.activeRelease <= 0) return "";
    return this.docker.readLogs(containerNameFor(app.slug), tail);
  }

  // ------------------------------------------------------------ releases

  listReleases(slug: string): ReleaseRecord[] {
    const app = this.mustGet(slug);
    return this.store.listReleases(app.id);
  }

  /**
   * Publica uma nova versão a partir de um ZIP: extrai, instala dependências e
   * ativa o release. Roda em background; o progresso é acompanhado pela API.
   */
  async startDeploy(slug: string, zipPath: string, notes = ""): Promise<StartedDeploy> {
    const app = this.mustGet(slug);
    const releaseSeq = this.store.nextReleaseSeq(app.id);
    const deploymentId = this.store.startDeployment(app.id, "deploy", releaseSeq);
    const finished = this.locks.run(slug, () =>
      this.runDeploy(app, releaseSeq, deploymentId, zipPath, notes),
    );
    // Erros já ficam registrados no log do deployment.
    const guarded = finished.catch(() => undefined);
    return { deploymentId, releaseSeq, finished: guarded };
  }

  /** Executa o deploy de ponta a ponta (usado também pelos testes). */
  async runDeploy(
    app: AppRecord,
    releaseSeq: number,
    deploymentId: number,
    zipPath: string,
    notes: string,
  ): Promise<void> {
    const log = new DeploymentLog(this.store, deploymentId);
    const target = releaseDir(this.config.dataDir, app.slug, releaseSeq);

    try {
      log.write(`# Release ${releaseSeq} — ${new Date().toLocaleString("pt-BR")}\n`);
      log.write(`Aplicação: ${app.name} (${app.runtime}, imagem ${app.image})\n`);

      await rmrf(target);
      await ensureDir(target, 0o750);
      log.write("Extraindo pacote...\n");
      const extraction = await extractZip(zipPath, target);
      log.write(
        `✓ ${extraction.files} arquivo(s), ${humanBytes(extraction.bytes)}` +
          (extraction.strippedRoot ? ` (pasta "${extraction.strippedRoot}" removida do pacote)\n` : "\n"),
      );

      const detection = await detectProject(target);
      // Marcador explícito do fim da detecção: sem ele, o painel só conseguiria
      // inferir "runtime detectado" de linhas que aparecem em outra etapa.
      log.write(
        `✓ Runtime detectado: ${detection.runtime} — entrada "${detection.entry || "não definida"}", ` +
          `dependências "${detection.depsFile || "nenhuma"}"\n`,
      );
      for (const note of detection.notes) log.write(`• ${note}\n`);

      const autoFill: Partial<AppRecord> = {};
      if (!app.entry.trim() && detection.entry) autoFill.entry = detection.entry;
      if (!app.depsFile.trim() && detection.depsFile) autoFill.depsFile = detection.depsFile;
      if (!app.installCommand.trim() && detection.installCommand) autoFill.installCommand = detection.installCommand;
      if (!app.startCommand.trim() && detection.startCommand) autoFill.startCommand = detection.startCommand;
      if (Object.keys(autoFill).length > 0) {
        this.store.updateApp(app.id, autoFill);
        log.write(`• Configuração completada automaticamente: ${Object.keys(autoFill).join(", ")}\n`);
      }
      const effective = this.store.getAppById(app.id);
      if (!effective) throw new NotFoundError();

      await chownRecursive(target, this.config.runUid, this.config.runGid);

      const installCommand = renderInstallCommand(effective, detection.presentFiles);
      if (installCommand.length > 0) {
        log.write(`Instalando dependências: ${installCommand}\n`);
        await this.docker.ensureImage(effective.image, log.write);
        const result = await this.docker.runOnce({
          image: effective.image,
          cmd: ["sh", "-c", installCommand],
          binds: [`${target}:${CONTAINER_APP_DIR}`],
          env: [
            ...effective.env.filter((item) => item.key.trim()).map((item) => `${item.key}=${item.value}`),
            "HOME=/tmp",
            "NPM_CONFIG_CACHE=/tmp/.npm",
            "PIP_NO_CACHE_DIR=1",
            "PYTHONUNBUFFERED=1",
            // O job de instalação é descartável: sem isto o pip escreveria em
            // $HOME/.local (efêmero) e o container de execução não acharia nada.
            `PYTHONUSERBASE=${CONTAINER_PYTHON_PACKAGES}`,
            "CI=1",
          ],
          workdir: CONTAINER_APP_DIR,
          user: `${this.config.runUid}:${this.config.runGid}`,
          memoryMb: Math.max(effective.memoryMb, 1024),
          nanoCpus: Math.max(effective.cpu, 1) * 1_000_000_000,
          onLog: log.write,
        });
        if (result.exitCode !== 0) {
          throw new Error(`A instalação de dependências falhou (código de saída ${result.exitCode}).`);
        }
        log.write("✓ Dependências instaladas\n");
      } else {
        log.write("• Nenhum arquivo de dependências detectado — instalação ignorada\n");
      }

      // Falha cedo se a aplicação não tem como iniciar.
      renderStartCommand(effective);

      const sizeBytes = await dirSize(target);
      this.store.insertRelease({
        appId: app.id,
        seq: releaseSeq,
        dir: target,
        image: effective.image,
        entry: effective.entry,
        startCommand: effective.startCommand,
        installCommand,
        notes,
        sizeBytes,
        createdAt: nowIso(),
      });
      this.store.updateApp(app.id, { activeRelease: releaseSeq });
      this.diskCache.delete(app.slug);
      const activated = this.store.getAppById(app.id);
      if (!activated) throw new NotFoundError();

      log.write(`Ativando release ${releaseSeq} e (re)iniciando o container...\n`);
      await this.applyContainer(activated, true, log.write);
      log.write(`✓ Release ${releaseSeq} publicado e em execução\n`);
      log.flush();
      this.store.finishDeployment(deploymentId, "success");
      this.store.addEvent(app.id, "info", `Release ${releaseSeq} publicado (${humanBytes(sizeBytes)})`);
      await this.pruneReleases(activated);
    } catch (error) {
      log.write(`\n✗ Falha no deploy: ${errorMessage(error)}\n`);
      log.flush();
      this.store.finishDeployment(deploymentId, "failed");
      this.store.addEvent(app.id, "error", `Deploy do release ${releaseSeq} falhou: ${errorMessage(error)}`);
    }
  }

  /**
   * Ativa um release já publicado (rollback). Restaura também como a versão era
   * executada (arquivo principal/start/imagem), mas preserva recursos, env e portas.
   */
  async activate(slug: string, seq: number): Promise<void> {
    const app = this.mustGet(slug);
    const release = this.store.getRelease(app.id, seq);
    if (!release) throw new NotFoundError(`Release ${seq} não encontrado.`);
    if (!(await pathExists(release.dir))) {
      throw new ValidationError(`Os arquivos do release ${seq} não estão mais no disco.`);
    }

    await this.locks.run(slug, async () => {
      await chownRecursive(release.dir, this.config.runUid, this.config.runGid);
      this.store.updateApp(app.id, {
        activeRelease: seq,
        entry: release.entry || app.entry,
        startCommand: release.startCommand,
        installCommand: release.installCommand,
        image: release.image,
      });
      const updated = this.store.getAppById(app.id);
      if (!updated) throw new NotFoundError();
      await this.applyContainer(updated, true);
    });
    this.store.addEvent(app.id, "info", `Rollback para o release ${seq}`);
  }

  async deleteRelease(slug: string, seq: number): Promise<void> {
    const app = this.mustGet(slug);
    if (app.activeRelease === seq) {
      throw new ConflictError("Não é possível remover o release ativo. Ative outro release antes.");
    }
    const release = this.store.getRelease(app.id, seq);
    if (!release) throw new NotFoundError(`Release ${seq} não encontrado.`);
    await this.locks.run(slug, async () => {
      await rmrf(release.dir);
      this.store.deleteRelease(app.id, seq);
      this.diskCache.delete(slug);
    });
  }

  /** Mantém apenas os N releases mais recentes (configurável). */
  async pruneReleases(app: AppRecord): Promise<void> {
    const keep = this.config.keepReleases;
    if (keep <= 0) return;
    const releases = this.store.listReleases(app.id);
    const doomed = releases.filter((release, index) => index >= keep && release.seq !== app.activeRelease);
    if (doomed.length > 0) this.diskCache.delete(app.slug);
    for (const release of doomed) {
      await rmrf(release.dir);
      this.store.deleteRelease(app.id, release.seq);
      this.store.addEvent(app.id, "info", `Release ${release.seq} removido pela política de retenção`);
    }
  }

  // ------------------------------------------------------- docker interno

  /** (Re)cria o container da aplicação com a configuração atual. */
  async applyContainer(app: AppRecord, start: boolean, onLog?: (line: string) => void): Promise<void> {
    if (app.activeRelease <= 0) throw new ValidationError("Nenhum release publicado para esta aplicação.");
    const releasePath = releaseDir(this.config.dataDir, app.slug, app.activeRelease);
    if (!(await pathExists(releasePath))) {
      throw new ValidationError(`Arquivos do release ${app.activeRelease} não encontrados no disco.`);
    }
    const sharedPath = sharedDir(this.config.dataDir, app.slug);
    await ensureDir(sharedPath, 0o770);
    await chownRecursive(sharedPath, this.config.runUid, this.config.runGid);

    await this.docker.ensureImage(app.image, onLog);
    const networkName = await this.docker.ensureNetwork(networkNameFor(app.slug), app.slug, onLog);
    const spec = buildContainerSpec({
      app,
      releasePath,
      sharedPath,
      runUid: this.config.runUid,
      runGid: this.config.runGid,
      networkName,
      instanceId: this.config.instanceId,
      // A política de reinício sempre sai dos interruptores atuais da aplicação.
      restartPolicy: restartPolicyFor(app),
    });
    await this.docker.remove(containerNameFor(app.slug), true);
    const container = await this.docker.createContainer(toCreateOptions(spec));
    onLog?.(`Container ${spec.name} criado (RAM ${app.memoryMb} MB, CPU ${app.cpu}).\n`);
    if (start) {
      await container.start();
      this.store.updateApp(app.id, { stoppedByUser: false });
      onLog?.(`Container iniciado.\n`);
    }
  }

  /**
   * Remove containers e redes órfãos (apps deletadas fora do painel) e limpa
   * temporários. Só age sobre recursos criados por ESTA instância do painel
   * (label `botpanel.instance`), para nunca apagar os de outro painel que use o
   * mesmo daemon Docker.
   */
  async reconcile(): Promise<{ containers: string[]; networks: string[] }> {
    const removed = { containers: [] as string[], networks: [] as string[] };
    const managed = await this.docker.listManaged();
    for (const item of managed) {
      if (!item.slug) continue;
      if (!this.store.getApp(item.slug)) {
        const deleted = await this.docker
          .remove(item.name, true)
          .then(() => true)
          .catch(() => false);
        if (deleted) removed.containers.push(item.name);
      }
    }
    const networks = await this.docker.listManagedNetworks();
    for (const network of networks) {
      if (!network.slug || !this.store.getApp(network.slug)) {
        await this.docker.removeNetwork(network.name);
        removed.networks.push(network.name);
      }
    }
    await rmrf(tmpDir(this.config.dataDir));
    await ensureDir(tmpDir(this.config.dataDir), 0o750);
    return removed;
  }

  async ensureLayout(app: AppRecord): Promise<void> {
    const root = appRoot(this.config.dataDir, app.slug);
    await ensureDir(root, 0o750);
    await ensureDir(releasesDir(this.config.dataDir, app.slug), 0o750);
    await ensureDir(sharedDir(this.config.dataDir, app.slug), 0o770);
    await chownRecursive(root, this.config.runUid, this.config.runGid);
  }

  async ensureTmp(): Promise<string> {
    const dir = tmpDir(this.config.dataDir);
    await ensureDir(dir, 0o750);
    return dir;
  }

  // --------------------------------------------------------- validações

  private validateSlug(slug: string): string {
    const value = slug.trim().toLowerCase();
    if (!isValidSlug(value)) {
      throw new ValidationError(
        "Identificador inválido: use de 2 a 32 caracteres (a-z, 0-9 e -).",
        undefined,
        "slug.invalid",
      );
    }
    if (this.store.slugTaken(value)) {
      throw new ConflictError(`Já existe uma aplicação com o identificador "${value}".`, "slug.taken");
    }
    return value;
  }

  /**
   * O ícone é carregado direto pelo navegador (`<img src>`), então só http/https
   * são aceitos — `javascript:` e afins nunca entram na interface.
   */
  private validateIconUrl(value: string): string {
    const url = value.trim();
    if (url.length === 0) return "";
    if (url.length > 500) throw new ValidationError("A URL do ícone deve ter no máximo 500 caracteres.");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ValidationError("Informe uma URL válida (http ou https) para o ícone.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ValidationError("O ícone precisa ser uma URL http ou https.");
    }
    return url;
  }

  private validateMemory(value: number): number {
    throwIfInvalid(memoryProblem(value) ? [memoryProblem(value)!] : [], "Configuração inválida.");
    return Math.round(value);
  }

  private validateCpu(value: number): number {
    throwIfInvalid(cpuProblem(value) ? [cpuProblem(value)!] : [], "Configuração inválida.");
    return Math.round(value * 100) / 100;
  }

  private validatePids(value: number): number {
    throwIfInvalid(pidsProblem(value) ? [pidsProblem(value)!] : [], "Configuração inválida.");
    return Math.round(value);
  }

  private validateEnv(env: EnvVar[]): EnvVar[] {
    throwIfInvalid(envIssues(env), "Configuração inválida.");
    const result: EnvVar[] = [];
    for (const item of env) {
      const key = (item.key ?? "").trim();
      if (key.length === 0) continue;
      result.push({ key, value: item.value ?? "", secret: item.secret === true });
    }
    return result;
  }

  private validatePorts(ports: string[]): string[] {
    throwIfInvalid(portsIssues(ports), "Configuração inválida.");
    const result: string[] = [];
    for (const raw of ports) {
      const value = raw.trim();
      if (value.length === 0) continue;
      result.push(value);
    }
    return result;
  }

  /** Caminhos expostos para outras camadas (arquivos, logs). */
  pathsFor(slug: string): { root: string; shared: string; releases: string; current: number } {
    const app = this.mustGet(slug);
    return {
      root: appRoot(this.config.dataDir, slug),
      shared: sharedDir(this.config.dataDir, slug),
      releases: releasesDir(this.config.dataDir, slug),
      current: app.activeRelease,
    };
  }

  releaseDirectory(slug: string, seq: number): string {
    return releaseDir(this.config.dataDir, slug, seq);
  }

  /** Pastas disponíveis para o navegador de arquivos. */
  async browsableRoots(slug: string): Promise<{ code: string | null; data: string }> {
    const app = this.mustGet(slug);
    const code = app.activeRelease > 0 ? releaseDir(this.config.dataDir, slug, app.activeRelease) : null;
    const data = sharedDir(this.config.dataDir, slug);
    await ensureDir(data, 0o770);
    return { code: code && (await pathExists(code)) ? code : null, data };
  }

  /** Lista os arquivos da raiz de um release (usado para detectar dependências). */
  async listReleaseFiles(slug: string, seq: number): Promise<string[]> {
    const dir = releaseDir(this.config.dataDir, slug, seq);
    if (!(await pathExists(dir))) return [];
    const entries = await listDirectory(dir);
    return entries.map((entry) => (entry.type === "directory" ? `${entry.name}/` : entry.name));
  }

  async diskUsage(slug: string, maxAgeMs = 60_000): Promise<number> {
    this.mustGet(slug);
    const cached = this.diskCache.get(slug);
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.bytes;
    const bytes = await dirSize(appRoot(this.config.dataDir, slug));
    this.diskCache.set(slug, { bytes, at: Date.now() });
    return bytes;
  }

  containerName(slug: string): string {
    return containerNameFor(slug);
  }

  get containerDataDir(): string {
    return CONTAINER_DATA_DIR;
  }

  get appDirInContainer(): string {
    return CONTAINER_APP_DIR;
  }

  /** Caminho absoluto de um arquivo dentro de um release (uso interno). */
  releaseFilePath(slug: string, seq: number, relative: string): string {
    return path.join(releaseDir(this.config.dataDir, slug, seq), relative);
  }

  get dataDir(): string {
    return this.config.dataDir;
  }
}
