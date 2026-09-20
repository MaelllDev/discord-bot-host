import type { AppRecord, RuntimeKind } from "../types.ts";

export interface RuntimeDefinition {
  kind: RuntimeKind;
  label: string;
  /** Imagem Docker usada para rodar e instalar dependências. */
  image: string;
  /** Arquivo de dependências padrão. */
  depsFile: string;
  /** Arquivos alternativos aceitos como manifesto de dependências. */
  manifests: string[];
  /** Arquivos principais testados na detecção automática. */
  entryCandidates: string[];
  defaultEntry: string;
  installCommand: string;
  startTemplate: string;
  description: string;
}

export const RUNTIMES: RuntimeDefinition[] = [
  {
    kind: "node",
    label: "Node.js 22",
    image: "node:22-slim",
    depsFile: "package.json",
    manifests: ["package.json"],
    entryCandidates: [
      "index.js",
      "main.js",
      "bot.js",
      "app.js",
      "server.js",
      "index.mjs",
      "index.cjs",
      "src/index.js",
      "src/main.js",
      "src/bot.js",
      "src/index.mjs",
      "bot/index.js",
      "dist/index.js",
    ],
    defaultEntry: "index.js",
    installCommand: "npm install --no-audit --no-fund",
    startTemplate: "node {{entry}}",
    description: "Bots e aplicações em JavaScript/TypeScript (discord.js, eris, etc.).",
  },
  {
    kind: "python",
    label: "Python 3.12",
    image: "python:3.12-slim",
    depsFile: "requirements.txt",
    manifests: ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile"],
    entryCandidates: ["main.py", "bot.py", "app.py", "index.py", "run.py", "src/main.py", "src/bot.py"],
    defaultEntry: "main.py",
    // `--user` combinado com PYTHONUSERBASE (ver buildEnvironment) instala dentro
    // do release montado em /app, que é o único diretório que sobrevive ao
    // container descartável de instalação.
    installCommand: "pip install --no-cache-dir --user -r requirements.txt",
    startTemplate: "python {{entry}}",
    description: "Bots e aplicações em Python (discord.py, nextcord, etc.).",
  },
  {
    kind: "custom",
    label: "Comando livre (avançado)",
    image: "ubuntu:24.04",
    depsFile: "",
    manifests: [],
    entryCandidates: [],
    defaultEntry: "",
    installCommand: "",
    startTemplate: "{{entry}}",
    description: "Use qualquer imagem Docker e defina os comandos de instalação e start manualmente.",
  },
];

export function getRuntime(kind: RuntimeKind): RuntimeDefinition {
  const found = RUNTIMES.find((runtime) => runtime.kind === kind);
  if (!found) throw new Error(`Runtime desconhecido: ${kind}`);
  return found;
}

/** Escapa um trecho de comando para ser usado com segurança dentro de `sh -c`. */
export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[a-zA-Z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Comando final de execução da aplicação. */
export function renderStartCommand(app: Pick<AppRecord, "runtime" | "startCommand" | "entry">): string {
  const explicit = app.startCommand.trim();
  if (explicit.length > 0) return explicit;
  const runtime = getRuntime(app.runtime);
  const entry = app.entry.trim();
  if (runtime.kind === "custom") {
    throw new Error("Aplicações com runtime livre precisam de um comando de start definido.");
  }
  if (entry.length === 0) {
    throw new Error("Defina o arquivo principal ou um comando de start para a aplicação.");
  }
  return runtime.startTemplate.replace("{{entry}}", shellQuote(entry));
}

/**
 * Comando de instalação de dependências. Retorna string vazia quando não há
 * nada para instalar (nenhum manifesto presente no release).
 */
export function renderInstallCommand(
  app: Pick<AppRecord, "runtime" | "installCommand" | "depsFile">,
  presentFiles: string[],
): string {
  const explicit = app.installCommand.trim();
  if (explicit.length > 0) return explicit;
  const runtime = getRuntime(app.runtime);
  if (runtime.kind === "custom") return "";

  const depsFile = app.depsFile.trim() || runtime.depsFile;
  const hasManifest = presentFiles.includes(depsFile) || runtime.manifests.some((file) => presentFiles.includes(file));
  if (!hasManifest) return "";
  if (runtime.kind === "python" && depsFile !== "requirements.txt") {
    return "pip install --no-cache-dir --user .";
  }
  return runtime.installCommand;
}

export interface ParsedPort {
  hostPort: number;
  containerPort: number;
}

/** Converte entradas como "8080:3000" (ou apenas "3000") em portas válidas. */
export function parsePortMappings(ports: string[]): ParsedPort[] {
  const result: ParsedPort[] = [];
  for (const raw of ports) {
    const value = raw.trim();
    if (value.length === 0) continue;
    const [left, right] = value.split(":");
    if (right === undefined) {
      const port = Number.parseInt(left ?? "", 10);
      if (isPort(port)) result.push({ hostPort: port, containerPort: port });
      continue;
    }
    const hostPort = Number.parseInt(left ?? "", 10);
    const containerPort = Number.parseInt(right, 10);
    if (isPort(hostPort) && isPort(containerPort)) result.push({ hostPort, containerPort });
  }
  return result;
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

/** Verifica se a imagem está na allowlist (quando configurada). */
export function isImageAllowed(image: string, allowedImages: string[] | null): boolean {
  if (!allowedImages || allowedImages.length === 0) return true;
  return allowedImages.includes(image.trim());
}

export function findManifests(presentFiles: string[]): string[] {
  const manifestNames = new Set(RUNTIMES.flatMap((runtime) => runtime.manifests));
  return presentFiles.filter((file) => manifestNames.has(file));
}
