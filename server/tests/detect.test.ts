import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectProject } from "../src/apps/detect.ts";

let workDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "botpanel-detect-"));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(workDir, "projeto-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  return root;
}

describe("detectProject", () => {
  it("detecta projeto Node.js pelo index.js", async () => {
    const root = await project({
      "package.json": JSON.stringify({ dependencies: { "discord.js": "^14.0.0" } }),
      "index.js": "require('discord.js');",
    });

    const result = await detectProject(root);

    expect(result.runtime).toBe("node");
    expect(result.entry).toBe("index.js");
    expect(result.depsFile).toBe("package.json");
    expect(result.presentFiles).toContain("package.json");
  });

  it("usa o campo main do package.json", async () => {
    const root = await project({
      "package.json": JSON.stringify({ main: "src/start.js" }),
      "src/start.js": "// bot",
    });

    const result = await detectProject(root);

    expect(result.entry).toBe("src/start.js");
  });

  it("usa o script start quando não há arquivo principal óbvio", async () => {
    const root = await project({
      "package.json": JSON.stringify({ scripts: { start: "node ./dist/bot.js" } }),
      "dist/bot.js": "// compilado",
    });

    const result = await detectProject(root);

    expect(result.startCommand).toBe("npm start");
    expect(result.notes.join(" ")).toContain("script");
  });

  it("compila projeto TypeScript sem JavaScript gerado", async () => {
    const root = await project({
      "package.json": JSON.stringify({ dependencies: { "discord.js": "^14.0.0" } }),
      "tsconfig.json": "{}",
      "src/index.ts": "export const bot = 1;",
    });

    const result = await detectProject(root);

    expect(result.runtime).toBe("node");
    expect(result.installCommand).toContain("npm run build");
    expect(result.entry).toBe("dist/index.js");
    expect(result.notes.join(" ")).toContain("assumindo");
  });

  it("delega o start ao script do package.json em projeto TypeScript", async () => {
    const root = await project({
      "package.json": JSON.stringify({ scripts: { start: "node dist/index.js", build: "tsc" } }),
      "tsconfig.json": "{}",
      "src/index.ts": "export const bot = 1;",
    });

    const result = await detectProject(root);

    expect(result.startCommand).toBe("npm start");
    expect(result.installCommand).toContain("npm run build");
  });

  it("recompila quando o projeto TypeScript já tem dist", async () => {
    const root = await project({
      "package.json": JSON.stringify({ scripts: { build: "tsc" } }),
      "tsconfig.json": "{}",
      "src/index.ts": "export const bot = 1;",
      "dist/index.js": "// compilado",
    });

    const result = await detectProject(root);

    expect(result.entry).toBe("dist/index.js");
    expect(result.installCommand).toContain("npm run build");
  });

  it("detecta projeto Python pelo main.py", async () => {
    const root = await project({
      "requirements.txt": "discord.py==2.3.2",
      "main.py": "import discord",
    });

    const result = await detectProject(root);

    expect(result.runtime).toBe("python");
    expect(result.entry).toBe("main.py");
    expect(result.depsFile).toBe("requirements.txt");
  });

  it("projeto Python só com bot.py", async () => {
    const root = await project({ "bot.py": "import discord" });

    const result = await detectProject(root);

    expect(result.runtime).toBe("python");
    expect(result.entry).toBe("bot.py");
    expect(result.depsFile).toBe("");
  });

  it("assume pyproject.toml como manifesto", async () => {
    const root = await project({ "pyproject.toml": "[project]", "main.py": "print(1)" });

    const result = await detectProject(root);

    expect(result.depsFile).toBe("pyproject.toml");
  });

  it("avisa quando não reconhece nada", async () => {
    const root = await project({ "LEIAME.txt": "sem código" });

    const result = await detectProject(root);

    expect(result.runtime).toBe("custom");
    expect(result.notes.join(" ")).toContain("Nenhum projeto");
  });

  it("reconhece bot Node.js sem package.json", async () => {
    const root = await project({ "index.js": "console.log('bot');" });

    const result = await detectProject(root);

    expect(result.runtime).toBe("node");
    expect(result.entry).toBe("index.js");
    // Sem manifesto não há o que instalar e o painel precisa avisar isso.
    expect(result.depsFile).toBe("");
    expect(result.installCommand).toBe("");
    expect(result.notes.join(" ")).toContain("Sem `package.json`");
  });
});
