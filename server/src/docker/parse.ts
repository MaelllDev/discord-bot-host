import type { AppStatus } from "../types.ts";

export interface RawCpuUsage {
  total_usage?: number;
}

export interface RawStats {
  cpu_stats?: {
    cpu_usage?: RawCpuUsage;
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: RawCpuUsage;
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: Record<string, number>;
  };
  pids_stats?: { current?: number };
}

export interface ParsedStats {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  pids: number;
}

/**
 * Calcula o uso de CPU a partir de duas amostras do cgroup, seguindo a mesma
 * fórmula usada pelo `docker stats`.
 */
export function computeCpuPercent(raw: RawStats): number {
  const cpuTotal = raw.cpu_stats?.cpu_usage?.total_usage ?? 0;
  const preCpuTotal = raw.precpu_stats?.cpu_usage?.total_usage ?? 0;
  const systemTotal = raw.cpu_stats?.system_cpu_usage ?? 0;
  const preSystemTotal = raw.precpu_stats?.system_cpu_usage ?? 0;
  const onlineCpus = raw.cpu_stats?.online_cpus ?? 1;

  const cpuDelta = cpuTotal - preCpuTotal;
  const systemDelta = systemTotal - preSystemTotal;
  if (cpuDelta <= 0 || systemDelta <= 0) return 0;

  const percent = (cpuDelta / systemDelta) * onlineCpus * 100;
  return Math.max(0, Math.round(percent * 10) / 10);
}

/** Extrai memória usada/limite e quantidade de processos. */
export function parseStats(raw: RawStats): ParsedStats {
  const usage = raw.memory_stats?.usage ?? 0;
  // Desconta page cache, como faz o docker stats, para não inflar o consumo.
  const cache = raw.memory_stats?.stats?.["inactive_file"] ?? raw.memory_stats?.stats?.["cache"] ?? 0;
  const memoryBytes = Math.max(0, usage - cache);
  const memoryLimitBytes = raw.memory_stats?.limit ?? 0;
  const memoryPercent = memoryLimitBytes > 0 ? Math.round((memoryBytes / memoryLimitBytes) * 1000) / 10 : 0;

  return {
    cpuPercent: computeCpuPercent(raw),
    memoryBytes,
    memoryLimitBytes,
    memoryPercent,
    pids: raw.pids_stats?.current ?? 0,
  };
}

export interface RawContainerState {
  Status?: string;
  Running?: boolean;
  Paused?: boolean;
  Restarting?: boolean;
  Dead?: boolean;
  ExitCode?: number;
  StartedAt?: string;
  FinishedAt?: string;
  OOMKilled?: boolean;
}

/**
 * Traduz o estado bruto do Docker em um status simples para a interface.
 * Um container parado com código diferente de 0 é tratado como "crashed".
 */
export function mapContainerState(state: RawContainerState | null | undefined): AppStatus {
  if (!state || !state.Status) return "stopped";
  if (state.Restarting) return "restarting";
  if (state.Paused) return "paused";
  if (state.Dead) return "crashed";
  if (state.Running) {
    const startedAt = state.StartedAt ? Date.parse(state.StartedAt) : Number.NaN;
    // O Docker reporta "running" nos primeiros milissegundos; tratamos como starting.
    if (Number.isFinite(startedAt) && Date.now() - startedAt < 1200) return "starting";
    return "running";
  }
  const status = state.Status.toLowerCase();
  if (status === "created") return "stopped";
  if (status === "exited" || status === "removing") {
    if (state.OOMKilled) return "crashed";
    return (state.ExitCode ?? 0) !== 0 ? "crashed" : "stopped";
  }
  return "stopped";
}

/** Converte o status do Docker em um dos status aceitos pela interface. */
export function normalizeStatus(value: string | undefined): AppStatus {
  switch (value) {
    case "running":
    case "starting":
    case "restarting":
    case "paused":
    case "stopped":
    case "crashed":
    case "deploying":
      return value;
    default:
      return "unknown";
  }
}

/**
 * Timestamp devolvido pelo Docker. O daemon responde
 * `0001-01-01T00:00:00Z` quando o campo nunca foi definido (container que ainda
 * não subiu). Tratar esse "zero" como data real produzia uptimes absurdos —
 * mais de 700 mil dias na tela.
 */
export function parseDockerTime(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  // Anos 1000-2999: `0001-01-01` (o vazio do Docker) é rejeitado aqui.
  if (!/^[12]\d{3}-/.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/** Segundos desde a data informada, nunca negativo. */
export function secondsSince(iso: string | null | undefined): number {
  if (!iso) return 0;
  const time = Date.parse(iso);
  if (!Number.isFinite(time) || time <= 0) return 0;
  return Math.max(0, Math.floor((Date.now() - time) / 1000));
}

/**
 * Acumula pedaços de saída e emite linhas completas. A última linha sem `\n`
 * fica retida até o próximo pedaço (ou até `flush`).
 */
export class LineBuffer {
  private pending = "";
  private readonly emit: (line: string) => void;
  private readonly maxLineLength: number;

  constructor(emit: (line: string) => void, maxLineLength = 8192) {
    this.emit = emit;
    this.maxLineLength = maxLineLength;
  }

  push(chunk: string): void {
    this.pending += chunk;
    const parts = this.pending.split(/\r?\n/);
    this.pending = parts.pop() ?? "";
    for (const part of parts) this.emit(part);
    if (this.pending.length > this.maxLineLength) {
      this.emit(this.pending.slice(0, this.maxLineLength));
      this.pending = this.pending.slice(this.maxLineLength);
    }
  }

  flush(): void {
    if (this.pending.length > 0) {
      this.emit(this.pending);
      this.pending = "";
    }
  }
}
