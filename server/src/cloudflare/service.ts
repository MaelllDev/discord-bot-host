import type Docker from "dockerode";
import type { Store } from "../db.ts";
import { nowIso } from "../db.ts";
import { mapContainerState, parseDockerTime, secondsSince } from "../docker/parse.ts";
import type { DockerService } from "../docker/service.ts";
import { isDockerUnavailable } from "../docker/service.ts";
import { AppError, ConflictError, ValidationError, errorMessage } from "../errors.ts";
import type { AppStatus } from "../types.ts";
import {
  CLOUDFLARE_COMPONENT_LABEL,
  CLOUDFLARE_CONTAINER_NAME,
  CLOUDFLARE_IMAGE,
  maskToken,
  readConfig,
  redactToken,
  validateTokenShape,
  writeConfig,
} from "./config.ts";
import type { CloudflareConfig } from "./config.ts";

/**
 * Estados possíveis do túnel. Deliberadamente separados: "container rodando"
 * NÃO é o mesmo que "túnel conectado", e o painel só afirma conexão quando há
 * evidência nos logs do `cloudflared`.
 */
export type TunnelState =
  | "not_configured"
  | "stopped"
  | "starting"
  | "connected"
  | "disconnected"
  | "error"
  | "unknown";

/** Estado seguro da integração — o que a API pode devolver. Nunca tem o token. */
export interface TunnelView {
  configured: boolean;
  enabled: boolean;
  tokenSet: boolean;
  tokenHint: string;
  state: TunnelState;
  containerName: string;
  containerId: string | null;
  image: string;
  restartPolicy: string | null;
  containerStatus: AppStatus | null;
  uptimeSeconds: number | null;
  startedAt: string | null;
  exitCode: number | null;
  dockerAvailable: boolean;
  /** Mensagem já redigida (fallback em português). */
  lastError: string | null;
  /** Código estável do problema atual, para a interface traduzir. */
  lastErrorCode: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastConnectedAt: string | null;
}

/** Evidência lida dos logs do cloudflared. */
interface LogEvidence {
  connected: boolean;
  failure: boolean;
  /** Última linha relevante (já redigida). */
  line: string | null;
}

const NO_EVIDENCE: LogEvidence = { connected: false, failure: false, line: null };

const CONNECTED_PATTERN = /Registered tunnel connection|Connection[^\n]*registered|Registered tunnel\b/i;
const FAILURE_PATTERN =
  /(?:^|\s)(?:ERR|FTL)\s|\bFailed to dial\b|\bFailed to (?:connect|serve|authenticate)\b|\bUnable to (?:connect|authenticate|reach)\b|invalid (?:tunnel )?(?:token|credentials)|Unauthorized|no more connections active/i;

/** Quanto tempo esperar o estado inicial depois de subir o container. */
const INITIAL_STATE_TIMEOUT_MS = 6_000;
/** Janela em que um container recém-iniciado é "starting" e não "disconnected". */
const STARTING_WINDOW_MS = 30_000;

/**
 * Integração do Cloudflare Tunnel: mantém um container `cloudflared` que expõe
 * o painel pela Cloudflare Zero Trust.
 *
 * Regras que valem em todos os caminhos:
 * - o token do túnel nunca sai daqui (só `tokenSet`/`tokenHint` chegam à API);
 * - nenhum texto devolvido, registrado ou guardado passa sem `redactToken`;
 * - o container é identificado por labels próprios; um container alheio com o
 *   mesmo nome nunca é assumido, parado ou removido;
 * - Docker indisponível nunca derruba a página nem o painel: vira estado.
 */
export class CloudflareService {
  private readonly store: Store;
  private readonly docker: DockerService;

  constructor(store: Store, docker: DockerService) {
    this.store = store;
    this.docker = docker;
  }

  /** Configuração completa (com o token). Uso interno — nunca sai pela API. */
  private config(): CloudflareConfig {
    return readConfig(this.store);
  }

  // ------------------------------------------------------------------ leitura

  /**
   * Estado seguro da integração. É uma leitura pura: nada é escrito no banco
   * (o `GET` da API não pode ter efeito colateral).
   */
  async view(): Promise<TunnelView> {
    const config = this.config();
    const tokenSet = config.token.length > 0;
    const base: TunnelView = {
      configured: tokenSet,
      enabled: config.enabled,
      tokenSet,
      tokenHint: maskToken(config.token),
      state: tokenSet ? "stopped" : "not_configured",
      containerName: config.containerName,
      containerId: config.containerId,
      image: config.image,
      restartPolicy: null,
      containerStatus: null,
      uptimeSeconds: null,
      startedAt: null,
      exitCode: null,
      dockerAvailable: true,
      lastError: config.lastError,
      lastErrorCode: null,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
      lastConnectedAt: config.lastConnectedAt,
    };

    if (!(await this.docker.info()).available) {
      return {
        ...base,
        dockerAvailable: false,
        state: tokenSet ? "unknown" : "not_configured",
        lastErrorCode: "cloudflare.dockerUnavailable",
      };
    }

    let inspected: Docker.ContainerInspectInfo | null;
    try {
      inspected = await this.docker.inspect(config.containerName);
    } catch (error) {
      if (isDockerUnavailable(error)) {
        return {
          ...base,
          dockerAvailable: false,
          state: tokenSet ? "unknown" : "not_configured",
          lastErrorCode: "cloudflare.dockerUnavailable",
        };
      }
      throw error;
    }

    if (!inspected) {
      // Sem container: com o túnel habilitado isso é um problema (o painel
      // deveria tê-lo de pé); sem ele, é simplesmente "parado".
      const enabledProblem = tokenSet && config.enabled;
      return {
        ...base,
        state: tokenSet ? (enabledProblem ? "error" : "stopped") : "not_configured",
        lastErrorCode: enabledProblem ? "cloudflare.containerMissing" : null,
      };
    }

    if (!this.isOurs(inspected)) {
      return {
        ...base,
        containerId: inspected.Id ?? config.containerId,
        state: tokenSet ? "error" : "not_configured",
        lastErrorCode: "cloudflare.containerNameTaken",
      };
    }

    const status = mapContainerState(inspected.State);
    const startedAt = parseDockerTime(inspected.State?.StartedAt);
    const live = status === "running" || status === "starting" || status === "restarting";
    const uptimeSeconds = live ? secondsSince(startedAt) : null;
    // A evidência vem dos logs, que existem tanto para container rodando quanto
    // para container que já morreu (é onde o motivo do erro aparece).
    const evidence = await this.readEvidence(config.token);

    const view: TunnelView = {
      ...base,
      containerId: inspected.Id ?? config.containerId,
      containerStatus: status,
      restartPolicy: inspected.HostConfig?.RestartPolicy?.Name ?? null,
      uptimeSeconds,
      startedAt: live ? startedAt : null,
      exitCode: inspected.State?.ExitCode ?? null,
      lastError: evidence.failure && evidence.line ? evidence.line : config.lastError,
      lastErrorCode: evidence.failure ? "cloudflare.connectionFailed" : null,
    };

    view.state = deriveState({
      status,
      tokenSet,
      enabled: config.enabled,
      evidence,
      uptimeMs: uptimeSeconds === null ? null : uptimeSeconds * 1000,
    });
    if (view.state === "error" && !view.lastErrorCode) view.lastErrorCode = "cloudflare.connectionFailed";
    return view;
  }

  /** Últimos logs do container, já sem o token. */
  async logs(limit = 120): Promise<string[]> {
    const config = this.config();
    const capped = Math.min(Math.max(limit, 1), 300);
    try {
      const text = await this.docker.readLogs(config.containerName, capped);
      if (text.length === 0) return [];
      return redactToken(text, config.token)
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .slice(-capped);
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------ escrita

  /**
   * Salva a configuração. Sem um token novo, o token existente é preservado: a
   * interface nunca o recebe de volta, então reenviar em branco apagaria o
   * segredo sem querer (mesma regra da chave de IA).
   */
  async save(input: { token?: string; enabled?: boolean }): Promise<TunnelView> {
    const current = this.config();
    let token = current.token;
    let tokenChanged = false;

    if (input.token !== undefined) {
      const trimmed = input.token.trim();
      // Campo vazio = "não mexi no token".
      if (trimmed.length > 0 && trimmed !== current.token) {
        const validation = validateTokenShape(trimmed);
        if (!validation.ok) {
          throw new ValidationError(validation.message ?? "Token do túnel inválido.", undefined, validation.code);
        }
        token = trimmed;
        tokenChanged = true;
      }
    }

    const config: CloudflareConfig = {
      ...current,
      token,
      enabled: input.enabled ?? current.enabled,
      createdAt: current.createdAt ?? (token.length > 0 ? nowIso() : null),
      lastError: null,
      lastConnectedAt: tokenChanged ? null : current.lastConnectedAt,
    };
    writeConfig(this.store, config);

    // O token vive no `Cmd` do container (é assim que o cloudflared o recebe),
    // então trocá-lo exige recriar o container para valer. Isso só é feito se o
    // container existente for realmente desta integração.
    if (tokenChanged && token.length > 0) {
      const existing = await this.docker.inspect(config.containerName).catch(() => null);
      if (existing && this.isOurs(existing)) {
        await this.docker.remove(config.containerName, true);
        writeConfig(this.store, { ...config, containerId: null });
        if (config.enabled) return this.connect();
      }
    }
    return this.view();
  }

  /**
   * Sobe o túnel: valida, garante a imagem, cria o container quando necessário
   * (nunca em duplicidade) e aguarda o estado inicial.
   */
  async connect(): Promise<TunnelView> {
    const config = this.config();
    if (config.token.length === 0) {
      throw new ValidationError("Informe o token do túnel antes de conectar.", undefined, "cloudflare.tokenRequired");
    }
    if (!(await this.docker.info()).available) {
      await this.recordError("O Docker não está respondendo — não é possível subir o túnel.");
      // 503 (e não 400): o pedido é válido, quem está fora é a dependência —
      // mesmo tratamento que o painel já dá ao Docker ausente nas aplicações.
      throw new AppError("O Docker não está respondendo.", 503, undefined, "cloudflare.dockerUnavailable");
    }

    // Intenção explícita: daqui para frente o painel mantém o túnel de pé.
    writeConfig(this.store, { ...config, enabled: true, lastError: null });

    const existing = await this.docker.inspect(config.containerName);
    if (existing && !this.isOurs(existing)) {
      await this.recordError(`Já existe um container "${config.containerName}" que não pertence a esta integração.`);
      throw new ConflictError(
        `O container "${config.containerName}" já existe e não pertence à integração do painel. Renomeie ou remova esse container antes de conectar.`,
        "cloudflare.containerNameTaken",
      );
    }

    try {
      await this.ensureImage();
    } catch (error) {
      const message = redactToken(errorMessage(error), config.token);
      await this.recordError(`Falha ao preparar a imagem ${CLOUDFLARE_IMAGE}: ${message}`);
      throw new ValidationError(
        `Não foi possível baixar a imagem do cloudflared: ${message}`,
        undefined,
        "cloudflare.imagePullFailed",
      );
    }

    try {
      if (!existing) await this.createContainer(config.token);
      else await this.alignExisting(existing);
    } catch (error) {
      const message = redactToken(errorMessage(error), config.token);
      await this.recordError(`Falha ao iniciar o container do túnel: ${message}`);
      throw new ValidationError(
        `Não foi possível iniciar o container do túnel: ${message}`,
        undefined,
        "cloudflare.containerStartFailed",
      );
    }

    return this.settle();
  }

  /**
   * Para o container e desliga a intenção de mantê-lo no ar. O token e a
   * configuração continuam guardados — desconectar não é remover, e o boot do
   * painel não ressuscita o túnel depois disso.
   */
  async disconnect(): Promise<TunnelView> {
    const config = this.config();
    writeConfig(this.store, { ...config, enabled: false, lastError: null });
    try {
      await this.docker.stop(config.containerName, 10);
    } catch (error) {
      if (!isDockerUnavailable(error)) throw error;
      await this.recordError("O Docker não está respondendo — não foi possível parar o container do túnel.");
    }
    return this.view();
  }

  /** Reinicia o container (criando-o se ainda não existir) sem perder nada. */
  async restart(): Promise<TunnelView> {
    const config = this.config();
    if (config.token.length === 0) {
      throw new ValidationError("Informe o token do túnel antes de reiniciar.", undefined, "cloudflare.tokenRequired");
    }
    if (!(await this.docker.info()).available) {
      throw new AppError("O Docker não está respondendo.", 503, undefined, "cloudflare.dockerUnavailable");
    }

    const existing = await this.docker.inspect(config.containerName);
    if (!existing) return this.connect();
    if (!this.isOurs(existing)) {
      throw new ConflictError(
        `O container "${config.containerName}" já existe e não pertence à integração do painel.`,
        "cloudflare.containerNameTaken",
      );
    }

    writeConfig(this.store, { ...config, enabled: true, lastError: null });
    try {
      await this.docker.updateRestartPolicy(config.containerName, "unless-stopped");
      await this.docker.restart(config.containerName, 10);
    } catch (error) {
      const message = redactToken(errorMessage(error), config.token);
      await this.recordError(`Falha ao reiniciar o container do túnel: ${message}`);
      throw new ValidationError(
        `Não foi possível reiniciar o container do túnel: ${message}`,
        undefined,
        "cloudflare.containerStartFailed",
      );
    }
    return this.settle();
  }

  /**
   * Diagnóstico do túnel. Não cria, não recria e não reinicia nada: só observa
   * o container e a evidência de conexão nos logs.
   */
  async test(): Promise<TunnelView> {
    const config = this.config();
    if (config.token.length === 0) {
      throw new ValidationError("Configure o token do túnel antes de testar.", undefined, "cloudflare.tokenRequired");
    }
    if (!(await this.docker.info()).available) {
      throw new AppError("O Docker não está respondendo.", 503, undefined, "cloudflare.dockerUnavailable");
    }

    const existing = await this.docker.inspect(config.containerName);
    if (!existing) {
      throw new ValidationError(
        "O container do túnel ainda não existe — conecte o túnel antes de testar.",
        undefined,
        "cloudflare.containerNotFound",
      );
    }
    if (!this.isOurs(existing)) {
      throw new ConflictError(
        `O container "${config.containerName}" não pertence à integração do painel.`,
        "cloudflare.containerNameTaken",
      );
    }

    const view = await this.view();
    if (view.state !== "connected") {
      throw new ValidationError(
        view.lastError ?? "O container está no ar, mas nenhuma conexão foi registrada com a Cloudflare.",
        undefined,
        view.lastErrorCode ?? "cloudflare.notConnected",
      );
    }
    return view;
  }

  /** Remove o container e a configuração (token incluído). */
  async remove(): Promise<TunnelView> {
    const config = this.config();
    const existing = await this.docker.inspect(config.containerName).catch((error: unknown) => {
      if (isDockerUnavailable(error)) return null;
      throw error;
    });

    if (existing) {
      if (!this.isOurs(existing)) {
        // Container alheio com o nosso nome: não é nosso para remover, e a
        // configuração fica intacta para o usuário decidir.
        throw new ConflictError(
          `O container "${config.containerName}" não pertence à integração do painel e não foi removido.`,
          "cloudflare.containerNameTaken",
        );
      }
      await this.docker.remove(config.containerName, true);
    }

    writeConfig(this.store, {
      enabled: false,
      token: "",
      containerName: CLOUDFLARE_CONTAINER_NAME,
      containerId: null,
      image: CLOUDFLARE_IMAGE,
      createdAt: null,
      updatedAt: null,
      lastError: null,
      lastConnectedAt: null,
    });
    return this.view();
  }

  /**
   * Reconcilição no boot do painel. Só age quando o túnel está configurado E
   * habilitado — nunca ressuscita um túnel que o usuário desconectou.
   */
  async reconcileOnStartup(): Promise<void> {
    try {
      const config = this.config();
      if (config.token.length === 0 || !config.enabled) return;

      if (!(await this.docker.info()).available) {
        await this.recordError("Docker indisponível no start do painel — o túnel não pôde ser reconciliado.");
        return;
      }

      const existing = await this.docker.inspect(config.containerName);
      if (existing && !this.isOurs(existing)) {
        await this.recordError(`Já existe um container "${config.containerName}" que não pertence à integração.`);
        return;
      }

      if (!existing) {
        await this.ensureImage();
        await this.createContainer(config.token);
      } else {
        // Realinha a política de reinício e sobe se estiver parado.
        await this.docker.updateRestartPolicy(config.containerName, "unless-stopped");
        const status = mapContainerState(existing.State);
        if (status !== "running" && status !== "starting" && status !== "restarting") {
          await this.docker.start(config.containerName);
        }
      }

      const inspected = await this.docker.inspect(config.containerName);
      writeConfig(this.store, { ...this.config(), containerId: inspected?.Id ?? null, lastError: null });
      const view = await this.view();
      if (view.state === "connected") this.noteConnected();
    } catch (error) {
      // O boot do painel nunca pode falhar por causa da integração.
      const message = redactToken(errorMessage(error), this.config().token);
      await this.recordError(`Falha ao reconciliar o túnel no start: ${message}`);
    }
  }

  // ------------------------------------------------------------------ interno

  /**
   * Cria o container do túnel. Labels próprios da integração — de propósito
   * SEM `botpanel.app`, que é o label pelo qual a reconciliação de aplicações
   * classifica containers como órfãos de uma app.
   */
  private async createContainer(token: string): Promise<void> {
    await this.docker.createContainer({
      name: CLOUDFLARE_CONTAINER_NAME,
      Image: CLOUDFLARE_IMAGE,
      // Mesmo comando usado hoje em produção:
      // `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token <TOKEN>`
      Cmd: ["tunnel", "--no-autoupdate", "run", "--token", token],
      Tty: false,
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      Labels: {
        "botpanel.managed": "1",
        "botpanel.component": CLOUDFLARE_COMPONENT_LABEL,
        "botpanel.instance": this.docker.instanceId,
      },
      HostConfig: {
        // O túnel é outbound: sai para a Cloudflare e não publica porta alguma.
        NetworkMode: "bridge",
        // Permite usar `http://host.docker.internal:<porta>` como serviço do
        // túnel no Cloudflare, sem precisar de host networking.
        ExtraHosts: ["host.docker.internal:host-gateway"],
        // Exigência da integração: sobrevive a reinício do host/daemon e a
        // reinício manual, mas continua parado se o usuário parar.
        RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
        AutoRemove: false,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        LogConfig: { Type: "json-file", Config: { "max-size": "5m", "max-file": "1" } },
      },
    });
    await this.docker.start(CLOUDFLARE_CONTAINER_NAME);
  }

  /** Container já existente e nosso: realinha política e garante que rode. */
  private async alignExisting(inspected: Docker.ContainerInspectInfo): Promise<void> {
    await this.docker.updateRestartPolicy(CLOUDFLARE_CONTAINER_NAME, "unless-stopped");
    const status = mapContainerState(inspected.State);
    if (status !== "running" && status !== "starting" && status !== "restarting") {
      await this.docker.start(CLOUDFLARE_CONTAINER_NAME);
    }
  }

  private async ensureImage(): Promise<void> {
    // Só o nome da imagem é registrado — nunca argumentos do container, que
    // carregam o token.
    await this.docker.ensureImage(CLOUDFLARE_IMAGE, (line) => console.log(`[cloudflare] ${line.trim()}`));
  }

  /** O container é desta integração? (label do componente + instância do painel) */
  private isOurs(inspected: Docker.ContainerInspectInfo): boolean {
    const labels = (inspected.Config?.Labels ?? {}) as Record<string, string>;
    return (
      labels["botpanel.component"] === CLOUDFLARE_COMPONENT_LABEL &&
      labels["botpanel.instance"] === this.docker.instanceId
    );
  }

  /**
   * Evidência nos logs do cloudflared. A ordem importa: vale a ocorrência mais
   * RECENTE, então um túnel que conectou e depois falhou aparece como erro (e
   * não como "conectado" para sempre).
   */
  private async readEvidence(token: string): Promise<LogEvidence> {
    let text = "";
    try {
      text = await this.docker.readLogs(CLOUDFLARE_CONTAINER_NAME, 200);
    } catch {
      return NO_EVIDENCE;
    }
    if (text.length === 0) return NO_EVIDENCE;

    const lines = redactToken(text, token)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index] ?? "";
      if (CONNECTED_PATTERN.test(line)) return { connected: true, failure: false, line };
      if (FAILURE_PATTERN.test(line)) return { connected: false, failure: true, line };
    }
    return NO_EVIDENCE;
  }

  /** Espera o container assumir um estado estável depois de (re)subir, grava containerId e conexão. */
  private async settle(): Promise<TunnelView> {
    const deadline = Date.now() + INITIAL_STATE_TIMEOUT_MS;
    let view = await this.view();
    while (Date.now() < deadline && (view.state === "starting" || view.state === "stopped")) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      view = await this.view();
    }
    // Uma conexão confirmada aqui é registrada de forma explícita — a leitura
    // (GET) permanece sem efeito colateral.
    if (view.state === "connected") {
      this.noteConnected();
      return this.view();
    }
    return view;
  }

  /** Persiste o instante da última conexão confirmada (e limpa o último erro). */
  private noteConnected(): void {
    const config = this.config();
    writeConfig(this.store, { ...config, lastConnectedAt: nowIso(), lastError: null });
  }

  /** Guarda o último erro (sempre redigido) para a página de diagnóstico. */
  private async recordError(message: string): Promise<void> {
    const config = this.config();
    const safe = redactToken(message, config.token);
    this.store.addEvent(null, "error", `Cloudflare Tunnel: ${safe}`);
    writeConfig(this.store, { ...config, lastError: safe });
  }
}

/**
 * Estado do túnel a partir do container + evidência. `containerStatus` descreve
 * o container; `state` descreve o túnel — e só vira "connected" com evidência
 * de conexão registrada nos logs.
 */
function deriveState(input: {
  status: AppStatus;
  tokenSet: boolean;
  enabled: boolean;
  evidence: LogEvidence;
  uptimeMs: number | null;
}): TunnelState {
  if (!input.tokenSet) return "not_configured";
  const live = input.status === "running" || input.status === "starting" || input.status === "restarting";
  if (live) {
    if (input.evidence.connected) return "connected";
    if (input.evidence.failure) return "error";
    // Sem evidência ainda: recém-iniciado é "starting"; depois disso, dizer
    // "conectado" seria invenção — o container está de pé e o túnel não.
    if (input.uptimeMs !== null && input.uptimeMs < STARTING_WINDOW_MS) return "starting";
    return "disconnected";
  }
  if (input.status === "crashed") return "error";
  // Parado: é erro se o usuário quer o túnel no ar; senão, é a intenção dele.
  return input.enabled ? "error" : "stopped";
}

