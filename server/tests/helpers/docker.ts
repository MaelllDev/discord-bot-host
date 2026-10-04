import type Docker from "dockerode";
import type { DockerService } from "../../src/docker/service.ts";

/**
 * Docker falso para os testes da integração do Cloudflare Tunnel. Ele guarda
 * containers em memória e responde exatamente aos métodos que a integração usa,
 * de modo que os testes exercitem a lógica real (labels, política de reinício,
 * evidência nos logs) sem depender de um daemon.
 *
 * Só os métodos usados pelo serviço estão implementados: é deliberado não
 * reimplementar a `DockerService` inteira, para o duplo não virar uma segunda
 * fonte de verdade que precise ser mantida.
 */
export interface FakeContainer {
  Id: string;
  name: string;
  State: {
    Status: string;
    Running: boolean;
    Paused: boolean;
    Restarting: boolean;
    OOMKilled: boolean;
    Dead: boolean;
    ExitCode: number;
    StartedAt: string;
    FinishedAt: string;
  };
  Config: { Image: string; Cmd: string[]; Labels: Record<string, string> };
  HostConfig: { RestartPolicy: { Name: string; MaximumRetryCount: number } };
}

export interface SeedContainerOptions {
  id?: string;
  labels?: Record<string, string>;
  /** Status do Docker: `running`, `exited`, `created`… */
  status?: string;
  exitCode?: number;
  startedAt?: string;
  restartPolicy?: string;
  image?: string;
  cmd?: string[];
}

const RUNNING_STARTED_AT = "2026-01-01T00:00:00.000Z";

export class FakeDocker {
  readonly instanceId: string;
  /** `false` simula o daemon fora do ar (mesmo sintoma de `info()` indisponível). */
  available = true;
  readonly containers = new Map<string, FakeContainer>();
  readonly created: Docker.ContainerCreateOptions[] = [];
  readonly pulled: string[] = [];
  readonly removed: string[] = [];
  readonly started: string[] = [];
  readonly stopped: string[] = [];
  readonly restarted: string[] = [];
  readonly policies: { name: string; policy: string }[] = [];
  logs = "";
  /** Erros injetados, por operação. `null` = operação bem-sucedida. */
  ensureImageError: Error | null = null;
  createError: Error | null = null;
  startError: Error | null = null;
  stopError: Error | null = null;
  restartError: Error | null = null;
  removeError: Error | null = null;
  inspectError: Error | null = null;

  constructor(instanceId = "test-instance") {
    this.instanceId = instanceId;
  }

  /** Coloca um container no "daemon" falso antes da operação. */
  seedContainer(name: string, options: SeedContainerOptions = {}): FakeContainer {
    const status = options.status ?? "running";
    const container: FakeContainer = {
      Id: options.id ?? `id-${name}`,
      name,
      State: {
        Status: status,
        Running: status === "running",
        Paused: false,
        Restarting: status === "restarting",
        OOMKilled: false,
        Dead: false,
        ExitCode: options.exitCode ?? 0,
        StartedAt: options.startedAt ?? (status === "running" ? RUNNING_STARTED_AT : "0001-01-01T00:00:00Z"),
        FinishedAt: "0001-01-01T00:00:00Z",
      },
      Config: {
        Image: options.image ?? "cloudflare/cloudflared:latest",
        Cmd: options.cmd ?? [],
        Labels: options.labels ?? {},
      },
      HostConfig: { RestartPolicy: { Name: options.restartPolicy ?? "no", MaximumRetryCount: 0 } },
    };
    this.containers.set(name, container);
    return container;
  }

  async info(): Promise<{ available: boolean; version: string | null; apiVersion: string | null; containers: number; images: number }> {
    return {
      available: this.available,
      version: "27.0.0",
      apiVersion: "1.45",
      containers: this.containers.size,
      images: this.pulled.length,
    };
  }

  async inspect(name: string): Promise<Docker.ContainerInspectInfo | null> {
    if (this.inspectError) throw this.inspectError;
    const container = this.containers.get(name);
    return (container as unknown as Docker.ContainerInspectInfo | undefined) ?? null;
  }

  async ensureImage(image: string): Promise<void> {
    if (this.ensureImageError) throw this.ensureImageError;
    this.pulled.push(image);
  }

  async createContainer(options: Docker.ContainerCreateOptions): Promise<Docker.Container> {
    if (this.createError) throw this.createError;
    this.created.push(options);
    const labels = (options.Labels ?? {}) as Record<string, string>;
    this.seedContainer(options.name ?? "", {
      id: `id-${options.name ?? "novo"}`,
      labels,
      status: "created",
      image: options.Image,
      cmd: options.Cmd as string[],
      restartPolicy: options.HostConfig?.RestartPolicy?.Name ?? "no",
    });
    return {} as Docker.Container;
  }

  async start(name: string): Promise<void> {
    if (this.startError) throw this.startError;
    this.started.push(name);
    const container = this.containers.get(name);
    if (!container) throw new Error(`container ${name} não existe`);
    container.State = {
      ...container.State,
      Status: "running",
      Running: true,
      StartedAt: RUNNING_STARTED_AT,
    };
  }

  async stop(name: string): Promise<void> {
    if (this.stopError) throw this.stopError;
    this.stopped.push(name);
    const container = this.containers.get(name);
    if (!container) throw new Error(`container ${name} não existe`);
    container.State = { ...container.State, Status: "exited", Running: false, ExitCode: 0 };
  }

  async restart(name: string): Promise<void> {
    if (this.restartError) throw this.restartError;
    this.restarted.push(name);
  }

  async remove(name: string): Promise<void> {
    if (this.removeError) throw this.removeError;
    this.removed.push(name);
    this.containers.delete(name);
  }

  async updateRestartPolicy(name: string, policy: string): Promise<void> {
    this.policies.push({ name, policy });
    const container = this.containers.get(name);
    if (container) container.HostConfig.RestartPolicy = { Name: policy, MaximumRetryCount: 0 };
  }

  async readLogs(): Promise<string> {
    return this.logs;
  }

  /** O serviço só usa os métodos acima; o restante da `DockerService` fica fora. */
  asService(): DockerService {
    return this as unknown as DockerService;
  }
}
