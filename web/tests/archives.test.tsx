import { describe, expect, it } from "vitest";
import {
  ARCHIVE_ACCEPT,
  ARCHIVE_EXTENSIONS,
  ARCHIVE_EXTENSIONS_LABEL,
  isArchiveFile,
  stripArchiveExtension,
} from "../src/archives.ts";

describe("helpers de pacote", () => {
  it("aceita todas as extensões sem diferenciar maiúsculas", () => {
    for (const extension of ARCHIVE_EXTENSIONS) {
      expect(isArchiveFile(`bot${extension}`)).toBe(true);
      expect(isArchiveFile(`BOT${extension.toUpperCase()}`)).toBe(true);
    }
  });

  it("aceita .tar.gz e .tar.xz", () => {
    expect(isArchiveFile("codigo.tar.gz")).toBe(true);
    expect(isArchiveFile("codigo.tar.xz")).toBe(true);
    expect(isArchiveFile("codigo.tgz")).toBe(true);
    expect(isArchiveFile("codigo.txz")).toBe(true);
  });

  it("recusa outros formatos", () => {
    expect(isArchiveFile("foto.png")).toBe(false);
    expect(isArchiveFile("bot.tar.bz2")).toBe(false);
    expect(isArchiveFile("projeto")).toBe(false);
  });

  it("remove a extensão completa para sugerir o nome da aplicação", () => {
    expect(stripArchiveExtension("meu-bot.7z")).toBe("meu-bot");
    expect(stripArchiveExtension("meu-bot.RAR")).toBe("meu-bot");
    // Não pode sobrar apenas "meu-bot.tar" ao remover só o ".gz".
    expect(stripArchiveExtension("meu-bot.tar.gz")).toBe("meu-bot");
    expect(stripArchiveExtension("meu-bot.tar.xz")).toBe("meu-bot");
    expect(stripArchiveExtension("meu-bot.tgz")).toBe("meu-bot");
    expect(stripArchiveExtension("meu-bot.tar")).toBe("meu-bot");
    expect(stripArchiveExtension("meu-bot")).toBe("meu-bot");
  });

  it("monta o accept com extensões e MIME types", () => {
    for (const extension of ARCHIVE_EXTENSIONS) expect(ARCHIVE_ACCEPT).toContain(extension);
    expect(ARCHIVE_ACCEPT).toContain("application/x-7z-compressed");
    expect(ARCHIVE_ACCEPT).toContain("application/vnd.rar");
    expect(ARCHIVE_ACCEPT).toContain("application/gzip");
    expect(ARCHIVE_ACCEPT).toContain("application/x-xz");
    expect(ARCHIVE_EXTENSIONS_LABEL).toBe("zip, 7z, rar, tar.gz ou tar.xz");
  });
});
