/**
 * Espelho frontend das validações do backend (`server/src/apps/validate.ts`).
 *
 * Cada problema tem o MESMO código estável do backend — a tradução é única
 * (`errors.<code>`), então o painel explica tanto os erros que previne quanto os
 * que chegam pela API. O backend continua sendo a autoridade: esta camada só
 * antecipa o feedback, nunca substitui a checagem do servidor.
 */
export interface ValidationIssue {
  code: string;
  params?: Record<string, string | number>;
  field?: "image" | "env" | "ports" | "name" | "slug" | "startCommand" | "installCommand";
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RESERVED_ENV_KEYS = new Set(["DATA_DIR", "HOME", "APP_SLUG", "APP_NAME"]);

export function imageProblem(rawImage: string): ValidationIssue | null {
  const image = rawImage.trim();
  if (image.length === 0) return { code: "image.empty", field: "image" };
  if (/\s/.test(image)) return { code: "image.containsSpaces", params: { image }, field: "image" };
  if (image.length > 200) return { code: "image.tooLong", field: "image" };
  const pattern =
    /^(?:[a-z0-9]+(?:[-_.][a-z0-9]+)*:(?:\d+)?\/)?[a-z0-9]+(?:[-_.][a-z0-9]+)*(?:\/[a-z0-9]+(?:[-_.][a-z0-9]+)*)*(?::[\w.-]+)?(?:@sha256:[a-f0-9]{64})?$/;
  if (!pattern.test(image.toLowerCase())) {
    return { code: "image.invalidFormat", params: { image }, field: "image" };
  }
  return null;
}

export function memoryProblem(value: number): ValidationIssue | null {
  if (!Number.isFinite(value) || value < 64 || value > 32_768) {
    return { code: "memory.outOfRange", params: { min: 64, max: 32_768 } };
  }
  return null;
}

export function cpuProblem(value: number): ValidationIssue | null {
  if (!Number.isFinite(value) || value < 0.1 || value > 16) {
    return { code: "cpu.outOfRange", params: { min: 0.1, max: 16 } };
  }
  return null;
}

export function pidsProblem(value: number): ValidationIssue | null {
  if (!Number.isFinite(value) || value < 32 || value > 4096) {
    return { code: "pids.outOfRange", params: { min: 32, max: 4096 } };
  }
  return null;
}

export function envIssues(
  env: { key: string; value: string }[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const item of env) {
    const key = (item.key ?? "").trim();
    if (key.length === 0) continue;
    if (!ENV_KEY_PATTERN.test(key)) {
      issues.push({ code: "env.invalidKey", params: { key }, field: "env" });
      continue;
    }
    if (RESERVED_ENV_KEYS.has(key.toUpperCase())) {
      issues.push({ code: "env.reservedKey", params: { key }, field: "env" });
      continue;
    }
    if (seen.has(key.toUpperCase())) {
      issues.push({ code: "env.duplicateKey", params: { key }, field: "env" });
      continue;
    }
    seen.add(key.toUpperCase());
  }
  return issues;
}

export function portsIssues(ports: string[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const raw of ports) {
    const value = raw.trim();
    if (value.length === 0) continue;
    if (!/^\d{1,5}(:\d{1,5})?$/.test(value)) {
      issues.push({ code: "ports.invalidMapping", params: { port: value }, field: "ports" });
      continue;
    }
    const [left, right] = value.split(":");
    const hostPort = Number.parseInt(left ?? "", 10);
    const containerPort = right === undefined ? hostPort : Number.parseInt(right, 10);
    const valid = (port: number): boolean => Number.isInteger(port) && port > 0 && port <= 65535;
    if (!valid(hostPort) || !valid(containerPort)) {
      issues.push({ code: "ports.outOfRange", params: { port: value }, field: "ports" });
      continue;
    }
    if (seen.has(value)) {
      issues.push({ code: "ports.duplicate", params: { port: value }, field: "ports" });
      continue;
    }
    seen.add(value);
  }
  return issues;
}

export function commandIssues(
  runtime: "node" | "python" | "custom",
  entry: string,
  startCommand: string,
): ValidationIssue[] {
  if (runtime === "custom" && startCommand.trim().length === 0) {
    return [{ code: "startCommand.requiredForCustom", field: "startCommand" }];
  }
  if (runtime !== "custom" && entry.trim().length === 0 && startCommand.trim().length === 0) {
    return [{ code: "startCommand.missing", field: "startCommand" }];
  }
  return [];
}

export function nameProblem(name: string): ValidationIssue | null {
  if (name.trim().length < 2 || name.trim().length > 48) {
    return { code: "name.length", field: "name" };
  }
  return null;
}

/** Junta os problemas numa lista de textos já traduzidos (ordem estável). */
export function translateIssues(
  issues: ValidationIssue[],
  translate: (key: string, vars?: Record<string, string | number>) => string,
): string[] {
  return issues.map((issue) => translate(`errors.${issue.code}`, issue.params));
}
