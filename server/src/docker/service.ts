import { Agent } from "node:http";
import { Readable, Writable } from "node:stream";
import Docker from "dockerode";
import { LineBuffer, mapContainerState, parseDockerTime, parseStats, secondsSince } from "./parse.ts";
import type { RawStats } from "./parse.ts";
import type { AppStatus, ContainerResources, RestartPolicy } from "../types.ts";

export type LogStreamName = "stdout" | "stderr";
export type LogHandler = (line: string, stream: LogStreamName) => void;

export interface FollowLogsOptions {
  /**
   * Ignora as linhas anteriores a este instante (formato do Docker, ex.
   * `2026-09-20T03:23:05.938209809Z` — o `StartedAt` do container). Serve para
   * que uma (re)conexão não ressuscite os logs de execuções anteriores: o
   * JSON-file guarda tudo, inclusive o que rodou antes dos restarts.
   */
  since?: string;
}

/** Separa o carimbo de tempo que o Docker prefixa em cada linha. */
const LINE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\S+)\s([\s\S]*)$/;

export interface RunOnceOptions {
  image: string;
  cmd: string[];
  binds: string[];
  env: string[];
  workdir: string;
  user: string;
  memoryMb?: number;
  nanoCpus?: number;
  onLog?: (line: string) => void;
  timeoutMs?: number;
}

export interface RunOnceResult {
  exitCode: number;
  log: string;
}

export interface DockerInfoSummary {
  available: boolean;
  version: string | null;
  apiVersion: string | null;
  containers: number;
  images: number;
}

/** Erro com o código de status devolvido pelo daemon do Docker. */
export class DockerRequestError extends Error {
  readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "DockerRequestError";
    this.statusCode = statusCode;
  }
}

function statusCodeOf(error: unknown): number | undefined {
  const candidate = (error as { statusCode?: number }).statusCode;
  return typeof candidate === "number" ? candidate : undefined;
}

/** Códigos de erro de socket que indicam daemon reiniciando/indisponível. */
const TRANSIENT_ERROR_CODES = new Set([
  "EPIPE",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOENT",
  "EAI_AGAIN",
  "ENOTFOUND",
]);

/**
 * O daemon do Docker pode ser reiniciado (ou ficar momentaneamente fora) e o
 * socket unix morre junto: a conexão em pool devolve EPIPE/ECONNRESET. Isso é
 * transitório e não pode virar "aplicação parada" na interface.
 */
export function isTransientDockerError(error: unknown): boolean {
  if (isDockerUnavailable(error)) return true;
  const statusCode = statusCodeOf(error);
  // 500/503 do daemon durante o restart, e corpo vazio: respostas que não
  // descrevem um erro real da requisição. Vale para o retry, mas não para
  // dizer ao usuário que o daemon está fora (um 500 pode ser erro da chamada).
  return statusCode === 500 || statusCode === 503;
}

/**
 * Falha de comunicação com o daemon (socket morto, conexão recusada). É o que
 * a API traduz em 503 com mensagem clara em vez de vazar ECONNREFUSED.
 */
export function isDockerUnavailable(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  if (code && TRANSIENT_ERROR_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /socket hang up|hang up|ECONNRESET|ECONNREFUSED|EPIPE|ENOENT/i.test(message);
}

/** Escreve linhas completas em um callback, acumulando pedaços de chunk. */
class LineWriter extends Writable {
  private readonly buffer: LineBuffer;

  constructor(onLine: (line: string) => void) {
    super();
    this.buffer = new LineBuffer(onLine);
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.buffer.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.buffer.flush();
    callback();
  }
}

export class DockerService {
  private readonly socketPath: string;
  /** Identificador desta instância do painel (label em containers e redes). */
  readonly instanceId: string;
  private docker: Docker;
  private agent: Agent;

  constructor(socketPath: string, instanceId = "botpanel") {
    this.socketPath = socketPath;
    this.instanceId = instanceId;
    this.agent = new Agent({ keepAlive: true, maxSockets: 32 });
    this.docker = this.createClient();
  }

  /**
   * Recria o cliente HTTP do Docker com um pool de conexões novo. É o que
   * permite o painel voltar a funcionar sozinho depois de um restart do daemon
   * (sem reiniciar o serviço do painel).
   */
  private createClient(): Docker {
    // `agent` é aceito em runtime pelo docker-modem (vai para o http.request),
    // mas não existe nas typings do @types/dockerode.
    const options = { socketPath: this.socketPath, agent: this.agent } as Docker.DockerOptions & {
      agent: Agent;
    };
    return new Docker(options);
  }

  private reconnect(): void {
    try {
      this.agent.destroy();
    } catch {
      // pool já destruído
    }
    this.agent = new Agent({ keepAlive: true, maxSockets: 32 });
    this.docker = this.createClient();
  }

  /**
   * Executa uma operação no daemon, repetindo uma vez em erros transitórios de
   * socket (com reconexão). Erros reais (404, 409, ...) sobem imediatamente.
   */
  private async request<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
    let last: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isTransientDockerError(error) || attempt === attempts) throw error;
        last = error;
        this.reconnect();
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
    throw last;
  }

  /** Verifica se o daemon está acessível e devolve informações gerais. */
  async info(): Promise<DockerInfoSummary> {
    try {
      const info = await this.request(() => this.docker.info());
      // `ApiVersion` não existe em `/info`: ela só vem de `/version`. Sem esta
      // chamada a página Sistema mostraria "desconhecida" para sempre.
      const version = await this.request(() => this.docker.version()).catch(() => undefined);
      return {
        available: true,
        version: (info as { ServerVersion?: string }).ServerVersion ?? null,
        apiVersion: (version as { ApiVersion?: string } | undefined)?.ApiVersion ?? null,
        containers: (info as { Containers?: number }).Containers ?? 0,
        images: (info as { Images?: number }).Images ?? 0,
      };
    } catch {
      return { available: false, version: null, apiVersion: null, containers: 0, images: 0 };
    }
  }

  /**
   * Confere se a imagem é utilizável. Primeiro no daemon local (imagens já
   * baixadas ou buildadas na própria VPS valem sempre); se não há cópia local,
   * pergunta ao registry (`GET /distribution/{ref}/json`). É o que permite o
   * painel dizer na hora da criação "essa imagem não existe" — em vez de deixar
   * criar e a aplicação falhar depois no deploy, com um pull que nunca converge.
   *
   * Resultados:
   * - `"ok"` — existe localmente, ou o registry confirmou o manifesto.
   * - `"missing"` — sem cópia local e o registry respondeu que não conhece a
   *   referência.
   * - `"indeterminate"` — não foi possível checar (Docker fora, registry
   *   inacessível, rate limit, rede). NÃO bloqueia: criar segue permitido.
   */
  async imageExists(image: string): Promise<"ok" | "missing" | "indeterminate"> {
    try {
      await this.request(() => this.docker.getImage(image).inspect());
      return "ok";
    } catch (error) {
      if (isDockerUnavailable(error)) return "indeterminate";
      if (statusCodeOf(error) !== 404) return "indeterminate";
      // 404 local: pode ser uma imagem que só existe no registry.
    }
    try {
      await this.request(() => this.docker.getImage(image).distribution());
      return "ok";
    } catch (error) {
      if (isDockerUnavailable(error)) return "indeterminate";
      const statusCode = statusCodeOf(error);
      // Docker Hub responde 401/403 ("denied") para repositório inexistente OU
      // privado — e o painel puxa imagens sem credenciais, então nos dois casos
      // o `docker pull` do deploy falharia do mesmo jeito. 404 acontece em
      // outros registries. 429 (rate limit) e 5xx são inconclusivos: não
      // bloqueiam a criação.
      if (statusCode === 404 || statusCode === 401 || statusCode === 403) return "missing";
      return "indeterminate";
    }
  }

  async listImages(): Promise<string[]> {
    try {
      const images = await this.request(() => this.docker.listImages());
      return images.flatMap((image) => (image.RepoTags ?? []).filter((tag) => tag && tag !== "<none>:<none>"));
    } catch {
      return [];
    }
  }

  /** Garante que a imagem está presente localmente, baixando quando necessário. */
  async ensureImage(image: string, onLog?: (line: string) => void): Promise<void> {
    try {
      await this.request(() => this.docker.getImage(image).inspect());
      return;
    } catch {
      // precisa baixar
    }
    onLog?.(`Baixando imagem Docker ${image}...\n`);
    const stream = await this.request(() => this.docker.pull(image));
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (error: Error | null) => {
          if (error) reject(error);
          else resolve();
        },
        (event: { status?: string; progress?: string; error?: string }) => {
          if (event.error) reject(new Error(event.error));
          else if (event.status && !event.progress) onLog?.(`  ${event.status}\n`);
        },
      );
    });
    onLog?.(`Imagem ${image} pronta.\n`);
  }

  /**
   * Inspeciona o container. Devolve `null` apenas quando ele realmente não
   * existe (404); falhas de comunicação com o daemon sobem como erro — dizer
   * "parado" quando o Docker está fora seria mentir para o usuário.
   */
  async inspect(name: string): Promise<Docker.ContainerInspectInfo | null> {
    try {
      return await this.request(() => this.docker.getContainer(name).inspect());
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      throw error;
    }
  }

  async status(name: string): Promise<AppStatus> {
    try {
      const inspected = await this.inspect(name);
      if (!inspected) return "stopped";
      return mapContainerState(inspected.State);
    } catch {
      // Daemon inacessível: não sabemos o estado — nunca reportar como parado.
      return "unknown";
    }
  }

  async resources(name: string): Promise<ContainerResources | null> {
    const inspected = await this.inspect(name);
    if (!inspected) return null;
    const status = mapContainerState(inspected.State);
    // "Em execução" de verdade: só nesses estados existe um uptime correndo.
    // Num container parado o Docker mantém o `StartedAt` da última execução, e
    // calcular a diferença a partir dele fazia o cronômetro continuar subindo
    // depois de desligar o bot.
    const live = status === "running" || status === "starting" || status === "restarting";
    const startedAt = parseDockerTime(inspected.State?.StartedAt);
    const base: ContainerResources = {
      cpuPercent: 0,
      memoryBytes: 0,
      memoryLimitBytes: 0,
      memoryPercent: 0,
      pids: 0,
      uptimeSeconds: live ? secondsSince(startedAt) : 0,
      startedAt: live ? startedAt : null,
      exitCode: inspected.State?.ExitCode ?? null,
      status,
    };

    if (status === "running" || status === "starting") {
      try {
        const raw = (await this.request(() =>
          this.docker.getContainer(name).stats({ stream: false }),
        )) as unknown as RawStats;
        const parsed = parseStats(raw);
        base.cpuPercent = parsed.cpuPercent;
        base.memoryBytes = parsed.memoryBytes;
        base.memoryLimitBytes = parsed.memoryLimitBytes;
        base.memoryPercent = parsed.memoryPercent;
        base.pids = parsed.pids;
      } catch {
        // métricas indisponíveis neste instante
      }
    }

    return base;
  }

  async start(name: string): Promise<void> {
    await this.request(() => this.docker.getContainer(name).start());
  }

  async stop(name: string, timeoutSeconds = 10): Promise<void> {
    try {
      await this.request(() => this.docker.getContainer(name).stop({ t: timeoutSeconds }));
    } catch (error) {
      if (statusCodeOf(error) === 304 || statusCodeOf(error) === 404) return;
      throw error;
    }
  }

  async restart(name: string, timeoutSeconds = 10): Promise<void> {
    await this.request(() => this.docker.getContainer(name).restart({ t: timeoutSeconds }));
  }

  /**
   * Ajusta a política de reinício de um container existente **sem recriá-lo**
   * (não há downtime). Usado quando os interruptores de "iniciar com o sistema"
   * e "reiniciar automaticamente" mudam sem alterar mais nada no container.
   */
  async updateRestartPolicy(name: string, policy: RestartPolicy): Promise<void> {
    const current = await this.inspect(name);
    if (!current) return;
    if (current.HostConfig?.RestartPolicy?.Name === policy) return;
    try {
      await this.request(() =>
        this.docker.getContainer(name).update({ RestartPolicy: { Name: policy, MaximumRetryCount: 0 } }),
      );
    } catch (error) {
      if (statusCodeOf(error) === 404) return;
      throw error;
    }
  }

  /** Política de reinício configurada no container (null quando ele não existe). */
  async restartPolicyOf(name: string): Promise<string | null> {
    const inspected = await this.inspect(name);
    return inspected?.HostConfig?.RestartPolicy?.Name ?? null;
  }

  async remove(name: string, force = true): Promise<void> {
    try {
      await this.request(() => this.docker.getContainer(name).remove({ force, v: false }));
    } catch (error) {
      if (statusCodeOf(error) === 404) return;
      throw error;
    }
  }

  async createContainer(options: Docker.ContainerCreateOptions): Promise<Docker.Container> {
    return this.request(() => this.docker.createContainer(options));
  }

  /**
   * Garante uma rede bridge dedicada para a aplicação. Sem isso, todos os
   * containers ficam na bridge padrão e conseguem alcançar as portas uns dos
   * outros — o isolamento entre aplicações não estaria completo.
   */
  async ensureNetwork(name: string, slug: string, onLog?: (line: string) => void): Promise<string> {
    try {
      await this.request(() => this.docker.getNetwork(name).inspect());
      return name;
    } catch {
      // ainda não existe
    }
    onLog?.(`Criando rede isolada ${name}...\n`);
    await this.request(() =>
      this.docker.createNetwork({
        Name: name,
        Driver: "bridge",
        CheckDuplicate: true,
        Labels: { "botpanel.app": slug, "botpanel.managed": "1", "botpanel.instance": this.instanceId },
      }),
    );
    return name;
  }

  async removeNetwork(name: string): Promise<void> {
    try {
      await this.request(() => this.docker.getNetwork(name).remove());
    } catch {
      // rede inexistente ou ainda em uso
    }
  }

  /**
   * Redes criadas por ESTA instância do painel. O filtro por instância é o que
   * impede um painel de apagar as redes de outro que compartilhe o mesmo daemon.
   */
  async listManagedNetworks(): Promise<{ name: string; slug: string }[]> {
    try {
      const networks = await this.request(() =>
        this.docker.listNetworks({
          filters: { label: ["botpanel.managed", `botpanel.instance=${this.instanceId}`] },
        }),
      );
      return networks.map((network) => ({
        name: network.Name,
        slug: (network.Labels as Record<string, string> | undefined)?.["botpanel.app"] ?? "",
      }));
    } catch {
      return [];
    }
  }

  /** Lê as últimas linhas de log do container (sem seguir). */
  async readLogs(name: string, tail = 400): Promise<string> {
    const container = this.docker.getContainer(name);
    let buffer: Buffer;
    try {
      buffer = (await container.logs({ stdout: true, stderr: true, tail, timestamps: false })) as unknown as Buffer;
    } catch {
      return "";
    }
    const lines: string[] = [];
    await this.demux(Readable.from(buffer), (line) => lines.push(line));
    return lines.join("\n");
  }

  /**
   * Acompanha os logs em tempo real. Retorna uma função para encerrar o stream.
   * `tail: "all"` envia todo o histórico disponível (usado em containers novos).
   */
  async followLogs(
    name: string,
    tail: number | "all",
    onLine: LogHandler,
    options: FollowLogsOptions = {},
  ): Promise<() => void> {
    const container = this.docker.getContainer(name);
    const sinceTime = options.since ? Date.parse(options.since) : Number.NaN;
    const precise = Number.isFinite(sinceTime);
    // A API só aceita `since` em epoch de segundos (a forma textual devolve 500)
    // e isso trunca o instante: use-o apenas para não puxar histórico gigante e
    // corte com precisão pelo carimbo de cada linha (que vem em nanossegundos).
    const sinceSeconds = precise ? Math.floor(sinceTime / 1000) : null;

    let stream: NodeJS.ReadableStream;
    try {
      stream = (await container.logs({
        stdout: true,
        stderr: true,
        follow: true,
        timestamps: precise,
        ...(tail === "all" ? {} : { tail }),
        ...(sinceSeconds === null ? {} : { since: sinceSeconds }),
      })) as unknown as NodeJS.ReadableStream;
    } catch {
      onLine("<não foi possível ler os logs deste container>", "stderr");
      return () => undefined;
    }

    const emit = (line: string, streamName: LogStreamName): void => {
      if (!precise) {
        onLine(line, streamName);
        return;
      }
      const match = LINE_TIMESTAMP.exec(line);
      const stamp = match?.[1];
      const text = match?.[2];
      // Linha anterior ao início da execução atual: pertence a uma tentativa
      // antiga (crash-loop, restart) e não deve reaparecer na tela.
      if (stamp !== undefined && text !== undefined && Date.parse(stamp) < sinceTime) return;
      onLine(text ?? line, streamName);
    };

    let closed = false;
    const stdout = new LineWriter((line) => emit(line, "stdout"));
    const stderr = new LineWriter((line) => emit(line, "stderr"));
    this.docker.modem.demuxStream(stream, stdout, stderr);

    stream.on("error", () => {
      /* stream encerrado */
    });

    return () => {
      if (closed) return;
      closed = true;
      try {
        (stream as unknown as { destroy?: () => void }).destroy?.();
      } catch {
        // ignora
      }
      stdout.end();
      stderr.end();
    };
  }

  /** Envia texto para o stdin do processo principal do container. */
  async attachStdin(name: string): Promise<Writable> {
    const container = this.docker.getContainer(name);
    const stream = (await container.attach({
      stream: true,
      stdin: true,
      stdout: false,
      stderr: false,
      hijack: true,
    })) as unknown as Writable;
    return stream;
  }

  /**
   * Executa um container descartável até o fim (usado para instalar dependências),
   * devolvendo o código de saída e a saída consolidada.
   */
  async runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
    const memoryMb = options.memoryMb ?? 1024;
    const container = await this.createContainer({
      name: `botpanel-job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      Image: options.image,
      Cmd: options.cmd,
      WorkingDir: options.workdir,
      User: options.user,
      Env: options.env,
      Tty: false,
      AttachStdin: false,
      Labels: { "botpanel.job": "1", "botpanel.instance": this.instanceId },
      HostConfig: {
        Binds: options.binds,
        AutoRemove: false,
        Memory: memoryMb * 1024 * 1024,
        NanoCpus: options.nanoCpus ?? 1_000_000_000,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        NetworkMode: "bridge",
        LogConfig: { Type: "json-file", Config: { "max-size": "5m", "max-file": "1" } },
      },
    });

    const lines: string[] = [];
    let stopFollowing: (() => void) | null = null;

    try {
      await container.start();
      // "all" evita perder linhas emitidas entre o start e o attach do stream.
      stopFollowing = await this.followLogs(container.id, "all", (line) => {
        lines.push(line);
        options.onLog?.(`${line}\n`);
      });

      const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;
      const waitResult = await Promise.race([
        container.wait(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("Tempo limite excedido durante a instalação.")), timeoutMs).unref?.();
        }),
      ]);
      const exitCode = (waitResult as { StatusCode?: number }).StatusCode ?? 0;
      return { exitCode, log: lines.join("\n") };
    } finally {
      stopFollowing?.();
      await this.remove(container.id, true).catch(() => undefined);
    }
  }

  /** Lista containers desta instância do painel (para reconciliar estado). */
  async listManaged(): Promise<{ name: string; slug: string; status: string }[]> {
    try {
      const containers = await this.request(() =>
        this.docker.listContainers({
          all: true,
          filters: { label: ["botpanel.app", `botpanel.instance=${this.instanceId}`] },
        }),
      );
      return containers.map((container) => ({
        name: (container.Names?.[0] ?? "").replace(/^\//, ""),
        slug: container.Labels?.["botpanel.app"] ?? "",
        status: container.State ?? "unknown",
      }));
    } catch {
      return [];
    }
  }

  private demux(stream: NodeJS.ReadableStream, onLine: (line: string) => void): Promise<void> {
    return new Promise((resolve) => {
      const stdout = new LineWriter((line) => onLine(line));
      const stderr = new LineWriter((line) => onLine(line));
      let pending = 2;
      const done = (): void => {
        pending -= 1;
        if (pending <= 0) resolve();
      };
      stdout.on("finish", done);
      stderr.on("finish", done);
      this.docker.modem.demuxStream(stream, stdout, stderr);
      stream.on("end", () => {
        stdout.end();
        stderr.end();
      });
      stream.on("error", () => {
        stdout.end();
        stderr.end();
      });
    });
  }
}
