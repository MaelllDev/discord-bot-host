import path from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import fsp from "node:fs/promises";
import yauzl from "yauzl";
import type { Entry, ZipFile } from "yauzl";
import { PathEscapeError, resolveWithin } from "./paths.ts";
import { ensureDir } from "./fsx.ts";

export interface ZipEntryInfo {
  /** Caminho completo dentro do ZIP, com `/`. */
  fileName: string;
  isDirectory: boolean;
  isSymlink: boolean;
  /** Tamanho descompactado. */
  sizeBytes: number;
  /** Permissões Unix (0 quando ausentes). */
  mode: number;
}

export interface ExtractLimits {
  maxEntries?: number;
  maxTotalBytes?: number;
}

export interface ExtractResult {
  files: number;
  bytes: number;
  /** Diretório raiz removido automaticamente (comum em ZIPs do GitHub). */
  strippedRoot: string | null;
}

export class UnsafeArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeArchiveError";
  }
}

const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

/** Junk comum de arquivos criados no macOS que só atrapalharia o projeto. */
function isJunkEntry(fileName: string): boolean {
  const normalized = fileName.replace(/\\/g, "/");
  return (
    normalized.startsWith("__MACOSX/") ||
    normalized.endsWith("/.DS_Store") ||
    normalized === ".DS_Store" ||
    normalized.endsWith("/Thumbs.db") ||
    normalized === "Thumbs.db"
  );
}

function isSymlinkEntry(entry: Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return mode === 0o120000;
}

/**
 * Percorre o diretório central do ZIP sem extrair nada, aplicando os limites de
 * quantidade de entradas e de tamanho total (proteção contra zip bomb).
 */
export async function listZipEntries(zipPath: string, limits: ExtractLimits = {}): Promise<ZipEntryInfo[]> {
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const entries: ZipEntryInfo[] = [];
  let totalBytes = 0;

  await walkZip(zipPath, (entry) => {
    if (entries.length >= maxEntries) {
      throw new UnsafeArchiveError(`ZIP com entradas demais (limite: ${maxEntries}).`);
    }
    const isDirectory = entry.fileName.endsWith("/");
    totalBytes += entry.uncompressedSize;
    if (totalBytes > maxTotalBytes) {
      throw new UnsafeArchiveError("ZIP descompactado excede o tamanho máximo permitido.");
    }
    entries.push({
      fileName: entry.fileName.replace(/\\/g, "/"),
      isDirectory,
      isSymlink: isSymlinkEntry(entry),
      sizeBytes: entry.uncompressedSize,
      mode: (entry.externalFileAttributes >>> 16) & 0o777,
    });
  });

  return entries;
}

/**
 * Detecta se todas as entradas estão dentro de um único diretório raiz
 * (padrão de ZIP exportado pelo GitHub) e devolve esse prefixo para ser removido.
 */
export function computeStripPrefix(fileNames: string[]): string | null {
  const roots = new Set<string>();
  let sawNestedPath = false;

  for (const raw of fileNames) {
    const name = raw.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (name.length === 0) continue;
    const segments = name.split("/");
    const first = segments[0];
    if (!first) continue;
    if (segments.length > 1) sawNestedPath = true;
    roots.add(first);
  }

  if (!sawNestedPath || roots.size !== 1) return null;
  const [onlyRoot] = [...roots];
  return onlyRoot ? `${onlyRoot}/` : null;
}

/**
 * Extrai um ZIP para `destDir` de forma segura: valida cada entrada contra
 * path traversal (zip-slip), recusa links simbólicos, ignora junk do macOS e
 * respeita os limites de tamanho.
 */
export async function extractZip(
  zipPath: string,
  destDir: string,
  overridePrefix?: string | null,
): Promise<ExtractResult> {
  const listed = await listZipEntries(zipPath, { maxTotalBytes: undefined });
  const strippedRoot =
    overridePrefix === undefined
      ? computeStripPrefix(listed.filter((entry) => !entry.isDirectory).map((entry) => entry.fileName))
      : overridePrefix;

  for (const entry of listed) {
    if (entry.isSymlink) {
      throw new UnsafeArchiveError(`O ZIP contém um link simbólico (${entry.fileName}), que não é permitido.`);
    }
  }

  await ensureDir(destDir);
  const stripped = new Set<string>();
  let files = 0;
  let bytes = 0;

  await walkZip(zipPath, async (entry, zip) => {
    const fileName = entry.fileName.replace(/\\/g, "/");
    if (isJunkEntry(fileName)) return;

    const withoutPrefix =
      strippedRoot && fileName.startsWith(strippedRoot) ? fileName.slice(strippedRoot.length) : fileName;
    if (withoutPrefix.length === 0) return;

    let destination: string;
    try {
      destination = resolveWithin(destDir, withoutPrefix);
    } catch (error) {
      if (error instanceof PathEscapeError) {
        throw new UnsafeArchiveError(`O ZIP contém um caminho inválido (${fileName}).`);
      }
      throw error;
    }

    // Um diretório listado antes de um arquivo dentro dele já foi criado.
    if (stripped.has(destination)) return;

    if (entry.fileName.endsWith("/")) {
      await ensureDir(destination);
      return;
    }

    await ensureDir(path.dirname(destination));
    const readStream = await openEntryStream(zip, entry);
    await pipeline(readStream, createWriteStream(destination));
    const mode = (entry.externalFileAttributes >>> 16) & 0o777;
    if (mode > 0) {
      await fsp.chmod(destination, mode).catch(() => undefined);
    }
    stripped.add(destination);
    files += 1;
    bytes += entry.uncompressedSize;
  });

  return { files, bytes, strippedRoot };
}

/**
 * O yauzl já recusa nomes com `..` ou caminhos absolutos, mas com um erro
 * genérico. Unificamos tudo em `UnsafeArchiveError` para que a API responda 400
 * e o usuário entenda que o pacote foi rejeitado por segurança.
 */
function asUnsafeError(error: unknown): Error {
  if (error instanceof UnsafeArchiveError) return error;
  if (error instanceof PathEscapeError) {
    return new UnsafeArchiveError(`O ZIP contém um caminho inválido (${error.relativePath}).`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new UnsafeArchiveError(`Pacote ZIP inválido ou inseguro: ${message}`);
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`Não foi possível ler ${entry.fileName}`));
        return;
      }
      resolve(stream);
    });
  });
}

/**
 * Itera as entradas do ZIP em modo streaming. A leitura do conteúdo só acontece
 * se o visitante chamar `openReadStream`, então percorrer o índice é barato.
 */
function walkZip(
  zipPath: string,
  visitor: (entry: Entry, zip: ZipFile) => void | Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(asUnsafeError(error));
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    yauzl.open(
      zipPath,
      { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true },
      (openError, zip) => {
        if (openError || !zip) {
          fail(openError ?? new Error("ZIP inválido."));
          return;
        }
        zip.on("entry", (entry: Entry) => {
          if (settled) return;
          Promise.resolve()
            .then(() => visitor(entry, zip))
            .then(() => {
              if (!settled) zip.readEntry();
            })
            .catch(fail);
        });
        zip.on("end", finish);
        zip.on("error", (error: Error) => fail(error));
        zip.readEntry();
      },
    );
  });
}
