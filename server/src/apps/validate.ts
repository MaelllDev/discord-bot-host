import type { EnvVar, RuntimeKind } from "../types.ts";
import { ValidationError } from "../errors.ts";
import { getRuntime, isImageAllowed } from "../docker/templates.ts";
import type { DockerService } from "../docker/service.ts";

/**
 * Validadores de domínio das configurações de aplicação.
 *
 * Cada problema vira um "issue" com código estável e parâmetros: a interface
 * traduz `errors.<code>` (pt/en) e usa os parâmetros na mensagem. O texto em
 * português continua existindo como fallback para quem consome a API sem ser o
 * painel — e o backend continua sendo a autoridade: o que chega aqui é o mesmo
 * que o frontend valida antes.
 */
export interface ValidationIssue {
  code: string;
  message: string;
  params?: Record<string, string | number>;
  /** Campo ao qual o problema se refere (para o painel apontar no formulário). */
  field?: "image" | "env" | "ports" | "name" | "slug" | "startCommand" | "installCommand";
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Definidas pelo painel em toda execução — a aplicação não pode sobrescrevê-las. */
export const RESERVED_ENV_KEYS = new Set(["DATA_DIR", "HOME", "APP_SLUG", "APP_NAME"]);
const MIN_MEMORY_MB = 64;
const MAX_MEMORY_MB = 32_768;
const MIN_CPU = 0.1;
const MAX_CPU = 16;
const MIN_PIDS = 32;
const MAX_PIDS = 4096;

/**
 * Nome de imagem Docker como referência local (`nome:tag`, `usuario/nome:tag`,
 * `registry.host:porta/nome`). Aceita o que `docker pull` aceita e rejeita
 * string vazia, espaços e espaços no meio — os erros mais comuns de digitação.
 */
export function imageProblem(rawImage: string): ValidationIssue | null {
  const image = rawImage.trim();
  if (image.length === 0) {
    return { code: "image.empty", message: "Informe a imagem Docker da aplicação.", field: "image" };
  }
  if (/\s/.test(image)) {
    return {
      code: "image.containsSpaces",
      message: `A imagem "${image}" contém espaços — confira se o nome foi digitado corretamente.`,
      params: { image },
      field: "image",
    };
  }
  if (image.length > 200) {
    return {
      code: "image.tooLong",
      message: "O nome da imagem Docker deve ter no máximo 200 caracteres.",
      field: "image",
    };
  }
  // registry opcional (com porta opcional), repositório obrigatório, tag/digest opcionais.
  const pattern =
    /^(?:[a-z0-9]+(?:[-_.][a-z0-9]+)*:(?:\d+)?\/)?[a-z0-9]+(?:[-_.][a-z0-9]+)*(?:\/[a-z0-9]+(?:[-_.][a-z0-9]+)*)*(?::[\w.-]+)?(?:@sha256:[a-f0-9]{64})?$/;
  if (!pattern.test(image.toLowerCase())) {
    return {
      code: "image.invalidFormat",
      message: `A imagem "${image}" não parece um nome Docker válido. Exemplos: node:22-slim, python:3.12-slim, usuario/meubot:latest.`,
      params: { image },
      field: "image",
    };
  }
  return null;
}

export function imageIssues(
  image: string,
  allowedImages: string[] | null,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const problem = imageProblem(image);
  if (problem) return [problem];
  const trimmed = image.trim();
  if (!isImageAllowed(trimmed, allowedImages)) {
    issues.push({
      code: "image.notAllowed",
      message: `A imagem "${trimmed}" não está na lista de imagens permitidas deste painel (BOTPANEL_ALLOWED_IMAGES).`,
      params: { image: trimmed },
      field: "image",
    });
  }
  return issues;
}

/**
 * Checa no registry (via daemon) se a imagem realmente existe. Devolve um
 * problema só quando o registry RESPONDEU que a referência não existe — é o
 * caso clássico de "imagem toda errada" que antes passava na criação e só
 * falhava depois, no deploy. Dúvida (Docker fora, rede, rate limit) não
 * bloqueia: o painel nunca deve recusar uma criação por culpa dele mesmo.
 */
export async function imageExistenceIssue(
  docker: DockerService,
  image: string,
): Promise<ValidationIssue | null> {
  const result = await docker.imageExists(image.trim());
  if (result === "missing") {
    return {
      code: "image.notFound",
      message: `A imagem "${image.trim()}" não existe no Docker Hub/registry. Confira o nome e a tag — ex.: node:22-slim, python:3.12-slim.`,
      params: { image: image.trim() },
      field: "image",
    };
  }
  return null;
}

export function memoryProblem(value: number): ValidationIssue | null {
  if (!Number.isFinite(value) || value < MIN_MEMORY_MB || value > MAX_MEMORY_MB) {
    return {
      code: "memory.outOfRange",
      message: `A memória deve estar entre ${MIN_MEMORY_MB} MB e ${MAX_MEMORY_MB} MB.`,
      params: { min: MIN_MEMORY_MB, max: MAX_MEMORY_MB },
    };
  }
  return null;
}

export function cpuProblem(value: number): ValidationIssue | null {
  if (!Number.isFinite(value) || value < MIN_CPU || value > MAX_CPU) {
    return {
      code: "cpu.outOfRange",
      message: `A CPU deve estar entre ${MIN_CPU} e ${MAX_CPU} núcleos.`,
      params: { min: MIN_CPU, max: MAX_CPU },
    };
  }
  return null;
}

export function pidsProblem(value: number): ValidationIssue | null {
  if (!Number.isFinite(value) || value < MIN_PIDS || value > MAX_PIDS) {
    return {
      code: "pids.outOfRange",
      message: `O limite de processos deve estar entre ${MIN_PIDS} e ${MAX_PIDS}.`,
      params: { min: MIN_PIDS, max: MAX_PIDS },
    };
  }
  return null;
}

export function envIssues(env: EnvVar[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const item of env) {
    const key = (item.key ?? "").trim();
    if (key.length === 0) continue;
    if (!ENV_KEY_PATTERN.test(key)) {
      issues.push({
        code: "env.invalidKey",
        message: `Nome de variável inválido: "${key}". Use letras, números e _ (não pode começar com número).`,
        params: { key },
        field: "env",
      });
      continue;
    }
    if (RESERVED_ENV_KEYS.has(key.toUpperCase())) {
      issues.push({
        code: "env.reservedKey",
        message: `A variável "${key}" é definida pelo painel e não pode ser sobrescrita.`,
        params: { key },
        field: "env",
      });
      continue;
    }
    if (seen.has(key.toUpperCase())) {
      issues.push({
        code: "env.duplicateKey",
        message: `A variável "${key}" aparece mais de uma vez.`,
        params: { key },
        field: "env",
      });
      continue;
    }
    seen.add(key.toUpperCase());
  }
  return issues;
}

const PORT_PATTERN = /^\d{1,5}(:\d{1,5})?$/;

export function portsIssues(ports: string[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const raw of ports) {
    const value = raw.trim();
    if (value.length === 0) continue;
    if (!PORT_PATTERN.test(value)) {
      issues.push({
        code: "ports.invalidMapping",
        message: `Mapeamento de porta inválido: "${value}". Use "portaHost:portaContainer" (ex.: 8080:3000).`,
        params: { port: value },
        field: "ports",
      });
      continue;
    }
    const [left, right] = value.split(":");
    const hostPort = Number.parseInt(left ?? "", 10);
    const containerPort = right === undefined ? hostPort : Number.parseInt(right, 10);
    const valid = (port: number): boolean => Number.isInteger(port) && port > 0 && port <= 65535;
    if (!valid(hostPort) || !valid(containerPort)) {
      issues.push({
        code: "ports.outOfRange",
        message: `A porta "${value}" está fora do intervalo válido (1 a 65535).`,
        params: { port: value },
        field: "ports",
      });
      continue;
    }
    if (seen.has(value)) {
      issues.push({
        code: "ports.duplicate",
        message: `A porta "${value}" aparece mais de uma vez.`,
        params: { port: value },
        field: "ports",
      });
      continue;
    }
    seen.add(value);
  }
  return issues;
}

/**
 * Problemas de execução que impedem a aplicação de iniciar: no runtime livre
 * falta quem defina o start; nos demais, precisa haver arquivo principal ou
 * comando de start.
 */
export function commandIssues(
  runtime: RuntimeKind,
  entry: string,
  startCommand: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const definition = getRuntime(runtime);
  if (definition.kind === "custom" && startCommand.trim().length === 0) {
    issues.push({
      code: "startCommand.requiredForCustom",
      message:
        "No runtime livre é obrigatório definir o comando de start — o painel não tem como adivinhar como iniciar a aplicação.",
      field: "startCommand",
    });
  }
  if (definition.kind !== "custom" && entry.trim().length === 0 && startCommand.trim().length === 0) {
    issues.push({
      code: "startCommand.missing",
      message:
        "Informe o arquivo principal (ex.: index.js) ou um comando de start — sem um dos dois a aplicação não sobe.",
      field: "startCommand",
    });
  }
  return issues;
}

/**
 * Agrupa os problemas e lança um único ValidationError com todos eles: a
 * interface mostra a lista completa de uma vez, em vez de um erro por tentativa.
 */
export function throwIfInvalid(issues: ValidationIssue[], headline: string): void {
  if (issues.length === 0) return;
  const details = issues.map(({ code, message, params, field }) => ({ code, message, params, field }));
  throw new ValidationError(headline, { issues: details }, "validation.composite");
}
