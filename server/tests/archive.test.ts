import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeZip } from "./helpers/zip.ts";
import type { ZipEntryInput } from "./helpers/zip.ts";
import { computeStripPrefix, extractZip, listZipEntries, UnsafeArchiveError } from "../src/util/archive.ts";
import { PathEscapeError, resolveWithin } from "../src/util/paths.ts";

let workDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "botpanel-archive-"));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

async function writeZip(entries: ZipEntryInput[]): Promise<string> {
  const zipPath = path.join(workDir, "pacote.zip");
  await fs.writeFile(zipPath, makeZip(entries));
  return zipPath;
}

describe("extractZip", () => {
  it("extrai arquivos e diretórios preservando o conteúdo", async () => {
    const zipPath = await writeZip([
      { name: "index.js", content: "console.log('oi');" },
      { name: "src/util.js", content: "export const x = 1;" },
    ]);
    const target = path.join(workDir, "out");

    const result = await extractZip(zipPath, target);

    expect(result.files).toBe(2);
    expect(result.strippedRoot).toBeNull();
    expect(await fs.readFile(path.join(target, "index.js"), "utf8")).toBe("console.log('oi');");
    expect(await fs.readFile(path.join(target, "src/util.js"), "utf8")).toBe("export const x = 1;");
  });

  it("remove a pasta raiz única (padrão de ZIP do GitHub)", async () => {
    const zipPath = await writeZip([
      { name: "meu-bot-main/" },
      { name: "meu-bot-main/index.js", content: "bot" },
      { name: "meu-bot-main/src/commands.js", content: "cmd" },
    ]);
    const target = path.join(workDir, "out");

    const result = await extractZip(zipPath, target);

    expect(result.strippedRoot).toBe("meu-bot-main/");
    expect(await fs.readFile(path.join(target, "index.js"), "utf8")).toBe("bot");
    expect(await fs.readFile(path.join(target, "src/commands.js"), "utf8")).toBe("cmd");
  });

  it("mantém a estrutura quando há mais de uma raiz", async () => {
    const zipPath = await writeZip([
      { name: "bot/index.js", content: "a" },
      { name: "config/settings.json", content: "{}" },
    ]);
    const target = path.join(workDir, "out");

    const result = await extractZip(zipPath, target);

    expect(result.strippedRoot).toBeNull();
    expect(await fs.readFile(path.join(target, "bot/index.js"), "utf8")).toBe("a");
  });

  it("bloqueia zip-slip com caminhos relativos maliciosos", async () => {
    const zipPath = await writeZip([{ name: "../escapou.txt", content: "hack" }]);
    const target = path.join(workDir, "out");

    await expect(extractZip(zipPath, target)).rejects.toBeInstanceOf(UnsafeArchiveError);
    await expect(fs.access(path.join(workDir, "escapou.txt"))).rejects.toThrow();
  });

  it("bloqueia caminhos absolutos", async () => {
    const zipPath = await writeZip([{ name: "/etc/passwd", content: "root:x:0:0" }]);
    const target = path.join(workDir, "out");

    await expect(extractZip(zipPath, target)).rejects.toBeInstanceOf(UnsafeArchiveError);
  });

  it("bloqueia aninhamento profundo que escaparia da raiz", async () => {
    const zipPath = await writeZip([{ name: "a/b/../../../fora.txt", content: "x" }]);
    const target = path.join(workDir, "out");

    await expect(extractZip(zipPath, target)).rejects.toBeInstanceOf(UnsafeArchiveError);
  });

  it("recusa links simbólicos vindos do ZIP", async () => {
    const zipPath = await writeZip([
      { name: "index.js", content: "ok" },
      { name: "link", symlinkTo: "/etc/passwd" },
    ]);
    const target = path.join(workDir, "out");

    await expect(extractZip(zipPath, target)).rejects.toBeInstanceOf(UnsafeArchiveError);
  });

  it("ignora junk do macOS e do Windows", async () => {
    const zipPath = await writeZip([
      { name: "__MACOSX/index.js" },
      { name: "index.js", content: "real" },
      { name: ".DS_Store", content: "lixo" },
      { name: "Thumbs.db", content: "lixo" },
    ]);
    const target = path.join(workDir, "out");

    const result = await extractZip(zipPath, target);

    expect(result.files).toBe(1);
    await expect(fs.access(path.join(target, ".DS_Store"))).rejects.toThrow();
  });

  it("lê entradas comprimidas com deflate", async () => {
    const zipPath = await writeZip([
      { name: "grande.txt", content: "repete ".repeat(500), compress: true },
    ]);
    const target = path.join(workDir, "out");

    const result = await extractZip(zipPath, target);

    expect(result.files).toBe(1);
    const content = await fs.readFile(path.join(target, "grande.txt"), "utf8");
    expect(content).toBe("repete ".repeat(500));
  });

  it("preserva a permissão de execução", async () => {
    const zipPath = await writeZip([{ name: "start.sh", content: "#!/bin/sh\n", mode: 0o100755 }]);
    const target = path.join(workDir, "out");

    await extractZip(zipPath, target);

    const stats = await fs.stat(path.join(target, "start.sh"));
    expect(stats.mode & 0o111).not.toBe(0);
  });
});

describe("listZipEntries", () => {
  it("respeita o limite de entradas (proteção contra zip bomb)", async () => {
    const zipPath = await writeZip([
      { name: "a.txt", content: "a" },
      { name: "b.txt", content: "b" },
      { name: "c.txt", content: "c" },
    ]);

    await expect(listZipEntries(zipPath, { maxEntries: 2 })).rejects.toBeInstanceOf(UnsafeArchiveError);
  });

  it("respeita o limite de bytes descompactados", async () => {
    const zipPath = await writeZip([{ name: "big.bin", content: "x".repeat(4096) }]);

    await expect(listZipEntries(zipPath, { maxTotalBytes: 1024 })).rejects.toBeInstanceOf(UnsafeArchiveError);
  });
});

describe("computeStripPrefix", () => {
  it("detecta uma raiz única", () => {
    expect(computeStripPrefix(["bot/index.js", "bot/main.py"])).toBe("bot/");
  });

  it("não remove nada quando os arquivos estão soltos na raiz", () => {
    expect(computeStripPrefix(["index.js", "README.md"])).toBeNull();
  });

  it("não remove nada quando há múltiplas raízes", () => {
    expect(computeStripPrefix(["bot/index.js", "config/app.json"])).toBeNull();
  });
});

describe("resolveWithin", () => {
  it("resolve caminhos válidos", () => {
    const root = path.join(workDir, "root");
    expect(resolveWithin(root, "src/index.js")).toBe(path.join(root, "src", "index.js"));
    expect(resolveWithin(root, "./a/b/../c")).toBe(path.join(root, "a", "c"));
    expect(resolveWithin(root, "")).toBe(path.resolve(root));
  });

  it("recusa travessia, caminhos absolutos e byte nulo", () => {
    const root = path.join(workDir, "root");
    expect(() => resolveWithin(root, "../fora")).toThrow(PathEscapeError);
    expect(() => resolveWithin(root, "/etc/passwd")).toThrow(PathEscapeError);
    expect(() => resolveWithin(root, "C:\\Windows\\system32")).toThrow(PathEscapeError);
    expect(() => resolveWithin(root, "a\0b")).toThrow(PathEscapeError);
    expect(() => resolveWithin(root, "..\\..\\fora")).toThrow(PathEscapeError);
  });
});
