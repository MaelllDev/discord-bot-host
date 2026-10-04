import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { makeZip } from "./helpers/zip.ts";
import type { ZipEntryInput } from "./helpers/zip.ts";
import { makeTar } from "./helpers/tar.ts";
import type { TarEntryInput } from "./helpers/tar.ts";
import { writeArchiveFixture } from "./helpers/archive-fixtures.ts";
import {
  archiveFormatLabel,
  computeStripPrefix,
  detectArchiveFormat,
  extractArchive,
  extractZip,
  isSupportedArchive,
  listZipEntries,
  resolveArchiveEntry,
  SUPPORTED_ARCHIVE_EXTENSIONS,
  UnsafeArchiveError,
} from "../src/util/archive.ts";
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

/** Escreve um TAR (opcionalmente comprimido com gzip) em `workDir`. */
async function writeTar(fileName: string, entries: TarEntryInput[], compress = false): Promise<string> {
  const target = path.join(workDir, fileName);
  const tar = makeTar(entries);
  await fs.writeFile(target, compress ? gzipSync(tar) : tar);
  return target;
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

describe("detectArchiveFormat", () => {
  it("reconhece todos os formatos sem diferenciar maiúsculas", () => {
    expect(detectArchiveFormat("pacote.zip")).toBe("zip");
    expect(detectArchiveFormat("Bot.7Z")).toBe("7z");
    expect(detectArchiveFormat("backup.Rar")).toBe("rar");
    expect(detectArchiveFormat("codigo.tar.gz")).toBe("tar.gz");
    expect(detectArchiveFormat("CODIGO.tar.xz")).toBe("tar.xz");
    expect(detectArchiveFormat("codigo.tgz")).toBe("tar.gz");
    expect(detectArchiveFormat("codigo.txz")).toBe("tar.xz");
    expect(detectArchiveFormat("codigo.tar")).toBe("tar");
  });

  it("não confunde a extensão longa com a curta", () => {
    expect(detectArchiveFormat("bot.tar.gz")).toBe("tar.gz");
    expect(detectArchiveFormat("bot.tar")).toBe("tar");
    // `backup.tar.gz.zip` termina em .zip e deve ser lido como ZIP.
    expect(detectArchiveFormat("backup.tar.gz.zip")).toBe("zip");
  });

  it("ignora formatos não suportados", () => {
    expect(detectArchiveFormat("bot.tar.bz2")).toBeNull();
    expect(detectArchiveFormat("projeto")).toBeNull();
    expect(isSupportedArchive("bot.rar")).toBe(true);
    expect(isSupportedArchive("bot.txt")).toBe(false);
  });

  it("publica a lista de extensões e os rótulos usados nas mensagens", () => {
    expect(SUPPORTED_ARCHIVE_EXTENSIONS).toEqual([".zip", ".7z", ".rar", ".tar.gz", ".tar.xz"]);
    expect(archiveFormatLabel("zip")).toBe("ZIP");
    expect(archiveFormatLabel("7z")).toBe("7-Zip");
    expect(archiveFormatLabel("rar")).toBe("RAR");
    expect(archiveFormatLabel("tar")).toBe("TAR");
    expect(archiveFormatLabel("tar.gz")).toBe("TAR.GZ");
    expect(archiveFormatLabel("tar.xz")).toBe("TAR.XZ");
  });
});

describe("resolveArchiveEntry", () => {
  it("mantém entradas válidas dentro do destino", () => {
    const target = path.join(workDir, "out");
    expect(resolveArchiveEntry(target, "src/index.js")).toBe(path.join(target, "src", "index.js"));
  });

  it("recusa travessia, caminho absoluto e byte nulo", () => {
    const target = path.join(workDir, "out");
    expect(() => resolveArchiveEntry(target, "../fora.txt")).toThrow(UnsafeArchiveError);
    expect(() => resolveArchiveEntry(target, "a/b/../../../fora.txt")).toThrow(UnsafeArchiveError);
    expect(() => resolveArchiveEntry(target, "/etc/passwd")).toThrow(UnsafeArchiveError);
    expect(() => resolveArchiveEntry(target, "a\0b")).toThrow(UnsafeArchiveError);
  });
});

describe("extractArchive (TAR)", () => {
  const project: TarEntryInput[] = [
    { name: "meu-bot", directory: true },
    { name: "meu-bot/index.js", content: "console.log('bot');\n" },
    { name: "meu-bot/requirements.txt", content: "requests\n" },
  ];

  it("extrai um .tar puro e remove a raiz única", async () => {
    const archive = await writeTar("bot.tar", project);
    const target = path.join(workDir, "out");

    const result = await extractArchive(archive, target);

    expect(result.files).toBe(2);
    expect(result.strippedRoot).toBe("meu-bot/");
    expect(await fs.readFile(path.join(target, "index.js"), "utf8")).toBe("console.log('bot');\n");
  });

  it("extrai um .tar.gz", async () => {
    const archive = await writeTar("bot.tar.gz", project, true);
    const target = path.join(workDir, "out");

    const result = await extractArchive(archive, target);

    expect(result.files).toBe(2);
    expect(await fs.readFile(path.join(target, "requirements.txt"), "utf8")).toBe("requests\n");
  });

  it("aceita o apelido .tgz", async () => {
    const archive = await writeTar("bot.tgz", project, true);
    const target = path.join(workDir, "out");

    const result = await extractArchive(archive, target);

    expect(result.files).toBe(2);
    expect(await fs.readFile(path.join(target, "index.js"), "utf8")).toContain("bot");
  });

  it("extrai um .tar.xz", async () => {
    const archive = await writeArchiveFixture(workDir, "tar-xz");
    const target = path.join(workDir, "out");

    const result = await extractArchive(archive, target);

    expect(result.strippedRoot).toBe("meu-bot/");
    expect(await fs.readFile(path.join(target, "index.js"), "utf8")).toBe("console.log('bot');\n");
    expect(await fs.readFile(path.join(target, "sub/lib.js"), "utf8")).toBe("export const x = 1;\n");
  });

  it("recusa links simbólicos vindos de TAR", async () => {
    const archive = await writeTar(
      "bot.tar.gz",
      [...project, { name: "meu-bot/escape-link", symlinkTo: "/etc/passwd" }],
      true,
    );
    const target = path.join(workDir, "out");

    await expect(extractArchive(archive, target)).rejects.toBeInstanceOf(UnsafeArchiveError);
    await expect(fs.access(path.join(target, "escape-link"))).rejects.toThrow();
  });

  it("preserva o conteúdo binário dos arquivos", async () => {
    const payload = Buffer.from([0, 1, 2, 250, 251, 252, 0, 0, 7]);
    const archive = await writeTar("bin.tar.gz", [{ name: "data.bin", content: payload }], true);
    const target = path.join(workDir, "out");

    await extractArchive(archive, target);

    const written = await fs.readFile(path.join(target, "data.bin"));
    expect(Buffer.compare(written, payload)).toBe(0);
  });
});

describe("extractArchive (7z e RAR)", () => {
  it("extrai um .zip pelo caminho do yauzl", async () => {
    const zipPath = await writeZip([{ name: "index.js", content: "ok" }]);
    const target = path.join(workDir, "out");

    const result = await extractArchive(zipPath, target);

    expect(result.files).toBe(1);
    expect(await fs.readFile(path.join(target, "index.js"), "utf8")).toBe("ok");
  });

  it("extrai um 7z preservando o conteúdo", async () => {
    const archive = await writeArchiveFixture(workDir, "7z-copy");
    const target = path.join(workDir, "out");

    const result = await extractArchive(archive, target);

    expect(result.files).toBe(1);
    expect(result.strippedRoot).toBeNull();
    const content = await fs.readFile(path.join(target, "file1"), "utf8");
    expect(content).toContain("file 1 contents");
  });

  it("extrai um RAR preservando o conteúdo", async () => {
    const archive = await writeArchiveFixture(workDir, "rar-stored");
    const target = path.join(workDir, "out");

    const result = await extractArchive(archive, target);

    expect(result.files).toBe(1);
    expect(await fs.readFile(path.join(target, "helloworld.txt"), "utf8")).toBe(
      "hello libarchive test suite!\n",
    );
  });

  it("remove a pasta raiz única também nos formatos 7z/RAR", async () => {
    const archive = await writeArchiveFixture(workDir, "7z-root");
    const target = path.join(workDir, "out");

    const result = await extractArchive(archive, target);

    expect(result.strippedRoot).toBe("meu-bot/");
    expect(await fs.readFile(path.join(target, "index.js"), "utf8")).toContain("bot");
    expect(await fs.readFile(path.join(target, "requirements.txt"), "utf8")).toBe("requests\n");
    await expect(fs.access(path.join(target, "meu-bot"))).rejects.toThrow();
  });

  it("recusa links simbólicos vindos de 7z e de RAR", async () => {
    for (const fixture of ["7z-symlink", "rar-symlink"] as const) {
      const archive = await writeArchiveFixture(workDir, fixture);
      const target = path.join(workDir, `out-${fixture}`);
      await expect(extractArchive(archive, target)).rejects.toBeInstanceOf(UnsafeArchiveError);
    }
  });

  it("recusa pacotes protegidos por senha", async () => {
    for (const fixture of ["7z-encrypted", "rar-encrypted"] as const) {
      const archive = await writeArchiveFixture(workDir, fixture);
      const target = path.join(workDir, `out-${fixture}`);
      await expect(extractArchive(archive, target)).rejects.toBeInstanceOf(UnsafeArchiveError);
    }
  });

  it("respeita os limites de entradas e de bytes descompactados", async () => {
    const archive = await writeArchiveFixture(workDir, "7z-root");

    await expect(
      extractArchive(archive, path.join(workDir, "limite-entradas"), undefined, { maxEntries: 1 }),
    ).rejects.toBeInstanceOf(UnsafeArchiveError);
    await expect(
      extractArchive(archive, path.join(workDir, "limite-bytes"), undefined, { maxTotalBytes: 8 }),
    ).rejects.toBeInstanceOf(UnsafeArchiveError);
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
