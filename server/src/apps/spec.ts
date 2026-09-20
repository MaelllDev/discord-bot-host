import Docker from "dockerode";
import { parsePortMappings, renderStartCommand } from "../docker/templates.ts";
import type { AppRecord, RestartPolicy } from "../types.ts";
import { CONTAINER_APP_DIR, CONTAINER_DATA_DIR, CONTAINER_PYTHON_PACKAGES } from "./paths.ts";

export interface ContainerSpecInput {
  app: AppRecord;
  /** Caminho absoluto do release ativo no host. */
  releasePath: string;
  /** Caminho absoluto do diretório persistente no host. */
  sharedPath: string;
  runUid: number;
  runGid: number;
  /** Nome da rede isolada da aplicação (uma por app). */
  networkName?: string;
  /** Identificador da instância do painel (label `botpanel.instance`). */
  instanceId?: string;
  restartPolicy?: RestartPolicy;
}

export interface ContainerSpec {
  name: string;
  image: string;
  cmd: string[];
  env: string[];
  workdir: string;
  user: string;
  openStdin: boolean;
  labels: Record<string, string>;
  hostConfig: Docker.HostConfig;
  exposedPorts: Record<string, Record<string, never>>;
}

export const STDOUT_LIMITS = { "max-size": "5m", "max-file": "3" };

/**
 * Traduz os dois interruptores da aplicação para a política de reinício do
 * Docker. A combinação "sobe com o sistema, mas não reinicia ao cair" não
 * existe no Docker (`always`/`unless-stopped` reiniciam nos dois casos), então
 * nesse caso a política é `no` e quem sobe a aplicação é o painel, no boot.
 */
export function restartPolicyFor(app: Pick<AppRecord, "autoStart" | "autoRestart">): RestartPolicy {
  if (!app.autoRestart) return "no";
  return app.autoStart ? "unless-stopped" : "on-failure";
}

export function containerNameFor(slug: string): string {
  return `botpanel-${slug}`;
}

/** Nome da rede Docker dedicada da aplicação (isolamento entre apps). */
export function networkNameFor(slug: string): string {
  return `botpanel-net-${slug}`;
}

export function jobContainerName(kind: string): string {
  return `botpanel-job-${kind}-${Date.now().toString(36)}`;
}

/** Variáveis de ambiente fixas injetadas pelo painel. */
export function baseEnvironment(app: AppRecord): Record<string, string> {
  return {
    DATA_DIR: CONTAINER_DATA_DIR,
    APP_NAME: app.name,
    APP_SLUG: app.slug,
    TZ: process.env["TZ"] ?? "UTC",
  };
}

export function buildEnvironment(app: AppRecord): string[] {
  const merged = new Map<string, string>();
  for (const envVar of app.env) {
    const key = envVar.key.trim();
    if (key.length === 0 || key.includes("=")) continue;
    merged.set(key, envVar.value);
  }

  // As variáveis reservadas do painel entram por último e têm precedência: o
  // contrato de persistência (DATA_DIR=/data, HOME=/data) não pode ser quebrado
  // por uma variável da aplicação com o mesmo nome.
  const reserved: Record<string, string> = baseEnvironment(app);
  if (app.runtime === "python") {
    reserved["PYTHONUNBUFFERED"] = "1";
    // Precisa bater com o diretório usado na instalação: é o que faz o Python
    // encontrar os pacotes gravados dentro do release.
    reserved["PYTHONUSERBASE"] = CONTAINER_PYTHON_PACKAGES;
  }
  reserved["HOME"] = CONTAINER_DATA_DIR;
  for (const [key, value] of Object.entries(reserved)) merged.set(key, value);

  return [...merged.entries()].map(([key, value]) => `${key}=${value}`);
}

/**
 * Monta a especificação completa do container de uma aplicação, com isolamento
 * (usuário sem privilégios, capabilities removidas) e limites de CPU/RAM.
 */
export function buildContainerSpec(input: ContainerSpecInput): ContainerSpec {
  const { app, releasePath, sharedPath, runUid, runGid } = input;
  const ports = parsePortMappings(app.ports);

  const exposedPorts: Record<string, Record<string, never>> = {};
  const portBindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
  for (const port of ports) {
    const key = `${port.containerPort}/tcp`;
    exposedPorts[key] = {};
    portBindings[key] = [...(portBindings[key] ?? []), { HostIp: "0.0.0.0", HostPort: String(port.hostPort) }];
  }

  const hostConfig: Docker.HostConfig = {
    Binds: [`${releasePath}:${CONTAINER_APP_DIR}:rw`, `${sharedPath}:${CONTAINER_DATA_DIR}:rw`],
    Memory: Math.round(app.memoryMb * 1024 * 1024),
    MemorySwap: Math.round(app.memoryMb * 1024 * 1024),
    NanoCpus: Math.round(app.cpu * 1_000_000_000),
    PidsLimit: app.pidsLimit,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges"],
    // A política vem dos dois interruptores da aplicação (ver
    // `restartPolicyFor`). Se a aplicação for parada manualmente, ela permanece
    // parada — nenhuma das políticas a ressuscita por conta própria.
    RestartPolicy: {
      Name: input.restartPolicy ?? restartPolicyFor(input.app),
      MaximumRetryCount: 0,
    },
    LogConfig: { Type: "json-file", Config: STDOUT_LIMITS },
    NetworkMode: input.networkName ?? "bridge",
    OomKillDisable: false,
  };
  if (Object.keys(portBindings).length > 0) hostConfig.PortBindings = portBindings;

  return {
    name: containerNameFor(app.slug),
    image: app.image,
    cmd: ["sh", "-c", `exec ${renderStartCommand(app)}`],
    env: buildEnvironment(app),
    workdir: CONTAINER_APP_DIR,
    user: `${runUid}:${runGid}`,
    openStdin: true,
    labels: {
      "botpanel.app": app.slug,
      "botpanel.release": String(app.activeRelease),
      "botpanel.runtime": app.runtime,
      // A instância é o que garante que o reconcile de um painel nunca remova
      // containers de outro painel que aponte para o mesmo daemon Docker.
      "botpanel.instance": input.instanceId ?? "botpanel",
    },
    hostConfig,
    exposedPorts,
  };
}

/** Converte a especificação para o formato aceito pela API do Docker. */
export function toCreateOptions(spec: ContainerSpec): Docker.ContainerCreateOptions {
  return {
    name: spec.name,
    Image: spec.image,
    Cmd: spec.cmd,
    Env: spec.env,
    WorkingDir: spec.workdir,
    User: spec.user,
    OpenStdin: spec.openStdin,
    StdinOnce: false,
    Tty: false,
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Labels: spec.labels,
    ExposedPorts: spec.exposedPorts,
    HostConfig: spec.hostConfig,
  };
}
