export function humanBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

/** "512 MB", "1 GB" — usado nos limites de RAM mostrados ao usuário. */
export function humanRam(megabytes: number | null | undefined): string {
  if (megabytes === null || megabytes === undefined || !Number.isFinite(megabytes) || megabytes <= 0) return "—";
  if (megabytes < 1024) return `${megabytes} MB`;
  const gigabytes = megabytes / 1024;
  return `${gigabytes % 1 === 0 ? gigabytes : gigabytes.toFixed(1)} GB`;
}

/** "0.5 CPU", "1 CPU", "1.5 CPU" — limites de CPU em vCPU. */
export function humanCpu(cpu: number | null | undefined): string {
  if (cpu === null || cpu === undefined || !Number.isFinite(cpu) || cpu <= 0) return "—";
  return `${Number.isInteger(cpu) ? cpu : cpu.toFixed(2).replace(/0$/, "")} CPU`;
}

export function humanPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function humanDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds)}s`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  return new Date(time).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  const diff = Math.round((Date.now() - time) / 1000);
  if (Math.abs(diff) < 60) return "agora";
  if (diff > 0) return `há ${humanDuration(diff)}`;
  return `em ${humanDuration(-diff)}`;
}

const SENSITIVE = /(token|secret|password|senha|key|api[_-]?key|webhook|dsn)/i;

export function isSensitive(key: string): boolean {
  return SENSITIVE.test(key);
}

export function maskSecret(value: string): string {
  if (value.length === 0) return "";
  if (value.length <= 4) return "••••";
  return `${value.slice(0, 2)}${"•".repeat(Math.min(14, Math.max(4, value.length - 4)))}${value.slice(-2)}`;
}

export function statusLabel(status: string): string {
  switch (status) {
    case "running":
      return "Em execução";
    case "starting":
      return "Iniciando";
    case "restarting":
      return "Reiniciando";
    case "stopped":
      return "Parado";
    case "crashed":
      return "Falhou";
    case "paused":
      return "Pausado";
    case "deploying":
      return "Publicando";
    case "unknown":
      return "Desconhecido";
    default:
      return "Desconhecido";
  }
}

export function runtimeLabel(runtime: string): string {
  switch (runtime) {
    case "node":
      return "Node.js";
    case "python":
      return "Python";
    case "custom":
      return "Comando livre";
    default:
      return runtime;
  }
}

/** Quantas casas decimais um número precisa para ser legível. */
export function compactNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}
