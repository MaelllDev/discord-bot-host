import fsp from "node:fs/promises";
import path from "node:path";
import type { RuntimeKind } from "../types.ts";
import { getRuntime } from "../docker/templates.ts";

export interface ProjectDetection {
  runtime: RuntimeKind;
  entry: string;
  depsFile: string;
  installCommand: string;
  startCommand: string;
  /** Arquivos relevantes encontrados na raiz do projeto. */
  presentFiles: string[];
  notes: string[];
}

interface PackageJson {
  main?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

/** Fontes TypeScript testadas quando não há JavaScript compilado. */
const TYPESCRIPT_ENTRIES = ["src/index.ts", "index.ts", "src/main.ts", "main.ts", "src/bot.ts", "bot.ts"];

async function readJson(target: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await fsp.readFile(target, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function listNames(target: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(target, { withFileTypes: true });
    return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  } catch {
    return [];
  }
}

async function firstExisting(root: string, candidates: string[]): Promise<string | null> {
  const present: string[] = [];
  for (const candidate of candidates) {
    if (await exists(path.join(root, candidate))) present.push(candidate);
  }
  return present[0] ?? null;
}

/**
 * Inspeciona o release extraído e sugere runtime, arquivo principal, manifesto de
 * dependências, comando de instalação e comando de start.
 */
export async function detectProject(root: string): Promise<ProjectDetection> {
  const names = await listNames(root);
  const notes: string[] = [];

  if (names.includes("package.json")) {
    return detectNodeProject(root, names, notes);
  }

  // Bot Node.js simples, sem manifesto: apenas o arquivo de entrada na raiz
  // (ex.: index.js). Sem este atalho um projeto perfeitamente válido cairia em
  // "custom" e o usuário não receberia nenhuma sugestão de runtime.
  if (names.some((name) => /\.(?:c|m)?js$/.test(name))) {
    return detectNodeProject(root, names, notes, { hasManifest: false });
  }

  const pythonMarkers = ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile", "main.py", "bot.py"];
  const hasPython =
    pythonMarkers.some((marker) => names.includes(marker)) || names.some((name) => name.endsWith(".py"));

  if (hasPython) {
    const runtime = getRuntime("python");
    const entry = (await firstExisting(root, runtime.entryCandidates)) ?? "";

    if (!entry) {
      const topLevel = names.filter((name) => name.endsWith(".py"));
      notes.push(
        topLevel.length > 0
          ? `Nenhum arquivo principal padrão encontrado; candidatos: ${topLevel.join(", ")}.`
          : "Nenhum arquivo .py encontrado na raiz; confirme o arquivo principal.",
      );
    }

    let depsFile = "requirements.txt";
    if (!names.includes("requirements.txt")) {
      if (names.includes("pyproject.toml")) {
        depsFile = "pyproject.toml";
        notes.push("Sem requirements.txt: as dependências serão instaladas a partir do pyproject.toml.");
      } else if (names.includes("setup.py")) {
        depsFile = "setup.py";
        notes.push("Sem requirements.txt: as dependências serão instaladas a partir do setup.py.");
      } else {
        depsFile = "";
        notes.push("Nenhum arquivo de dependências encontrado (requirements.txt/pyproject.toml).");
      }
    }

    return {
      runtime: "python",
      entry: entry || "",
      depsFile,
      installCommand: "",
      startCommand: "",
      presentFiles: names,
      notes,
    };
  }

  notes.push("Nenhum projeto Node.js ou Python reconhecido na raiz do ZIP; revise as configurações.");
  return {
    runtime: "custom",
    entry: "",
    depsFile: "",
    installCommand: "",
    startCommand: "",
    presentFiles: names,
    notes,
  };
}

async function detectNodeProject(
  root: string,
  names: string[],
  notes: string[],
  { hasManifest = true }: { hasManifest?: boolean } = {},
): Promise<ProjectDetection> {
  const runtime = getRuntime("node");
  const pkg = hasManifest ? await readJson(path.join(root, "package.json")) : null;

  // Sem package.json não existe build npm para executar, então também não
  // tratamos o projeto como TypeScript compilado.
  const hasTsconfig = hasManifest && names.includes("tsconfig.json");
  const hasBuildScript = typeof pkg?.scripts?.["build"] === "string";
  const hasStartScript = typeof pkg?.scripts?.["start"] === "string";
  const typescriptSource = hasTsconfig ? await firstExisting(root, TYPESCRIPT_ENTRIES) : null;

  let entry = "";
  let startCommand = "";
  let installCommand = hasManifest ? runtime.installCommand : "";
  let needsBuild = false;

  const declaredMain = typeof pkg?.main === "string" ? pkg.main : "";
  if (declaredMain && (await exists(path.join(root, declaredMain)))) {
    entry = declaredMain;
  } else {
    entry = (await firstExisting(root, runtime.entryCandidates)) ?? "";
  }

  if (entry) {
    // Projeto TypeScript já compilado: recompila na instalação para não rodar código velho.
    if (hasTsconfig && (hasBuildScript || typescriptSource) && entry.startsWith("dist/")) {
      needsBuild = true;
      notes.push("Projeto TypeScript: o build será executado na instalação antes de iniciar.");
    }
  } else if (typescriptSource && (hasBuildScript || hasTsconfig)) {
    needsBuild = true;
    notes.push("Projeto TypeScript sem JavaScript compilado: o build será executado na instalação.");
    if (hasStartScript) {
      startCommand = "npm start";
      notes.push("O start foi delegado ao script `start` do package.json.");
    } else {
      entry = "dist/index.js";
      notes.push("Sem script `start`: assumindo a saída do build em `dist/index.js` — confirme o arquivo principal.");
    }
  } else if (hasStartScript) {
    startCommand = "npm start";
    notes.push("Nenhum arquivo principal encontrado; usando o script `start` do package.json.");
  } else {
    entry = runtime.defaultEntry;
    notes.push("Nenhum arquivo principal encontrado; confirme o campo “Arquivo principal”.");
  }

  if (needsBuild) installCommand = `${runtime.installCommand} && npm run build`;

  if (hasManifest) {
    if (!names.includes("package-lock.json")) {
      notes.push("Sem `package-lock.json`: a instalação usa `npm install` e as versões podem variar entre deploys.");
    }
  } else {
    notes.push(
      "Sem `package.json`: nenhuma dependência será instalada — inclua um manifesto se o bot precisar de bibliotecas.",
    );
  }

  return {
    runtime: "node",
    entry,
    depsFile: hasManifest ? "package.json" : "",
    installCommand,
    startCommand,
    presentFiles: names,
    notes,
  };
}
