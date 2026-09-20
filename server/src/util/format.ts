export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function humanDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(seconds)}s`;
}

const SENSITIVE_KEY = /(token|secret|password|senha|key|api[_-]?key|webhook|dsn)/i;

/** Mascara valores sensíveis antes de exibir variáveis de ambiente na interface. */
export function maskValue(key: string, value: string): string {
  if (!SENSITIVE_KEY.test(key)) return value;
  if (value.length <= 4) return "••••";
  return `${value.slice(0, 2)}${"•".repeat(Math.min(12, Math.max(4, value.length - 4)))}${value.slice(-2)}`;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}
