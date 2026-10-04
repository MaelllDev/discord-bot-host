import path from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import fsp from "node:fs/promises";
import yauzl from "yauzl";
import type { Entry, ZipFile } from "yauzl";
import { ArchiveReader, libarchiveWasm } from "libarchive-wasm";
import type { LibarchiveWasm } from "libarchive-wasm";
import { PathEscapeError, resolveWithin } from "./paths.ts";
import { ensureDir, rmrf } from "./fsx.ts";

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

/**
 * 7z, RAR e TAR são extraídos pelo libarchive-wasm, que só sabe ler de memória:
 * o pacote inteiro precisa caber na RAM do processo. ZIP continua em streaming
 * pelo yauzl, por isso este limite vale apenas para os outros formatos.
 */
const MAX_IN_MEMORY_ARCHIVE_BYTES = 256 * 1024 * 1024;

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

// ------------------------------------------------------------------ formatos

/**
 * Formatos de pacote aceitos no upload de uma aplicação. `tar` guarda apenas o
 * formato (o libarchive detecta a compressão sozinho), enquanto `.tar.gz` e
 * `.tar.xz` são formas distintas só para as mensagens ao usuário.
 */
export type ArchiveFormat = "zip" | "7z" | "rar" | "tar" | "tar.gz" | "tar.xz";

/**
 * Extensões reconhecidas, da mais longa para a mais curta — a ordem importa
 * para que `.tar.gz` nunca seja confundido com `.tar`.
 */
const ARCHIVE_KINDS: { extension: string; format: ArchiveFormat; label: string }[] = [
  { extension: ".tar.gz", format: "tar.gz", label: "TAR.GZ" },
  { extension: ".tgz", format: "tar.gz", label: "TAR.GZ" },
  { extension: ".tar.xz", format: "tar.xz", label: "TAR.XZ" },
  { extension: ".txz", format: "tar.xz", label: "TAR.XZ" },
  { extension: ".zip", format: "zip", label: "ZIP" },
  { extension: ".7z", format: "7z", label: "7-Zip" },
  { extension: ".rar", format: "rar", label: "RAR" },
  { extension: ".tar", format: "tar", label: "TAR" },
];

/**
 * Extensões divulgadas nas mensagens de erro/ajuda (sem os apelidos curtos:
 * `.tgz`, `.txz` e `.tar` são aceitos, mas não precisam aparecer em todo aviso).
 */
export const SUPPORTED_ARCHIVE_EXTENSIONS = [".zip", ".7z", ".rar", ".tar.gz", ".tar.xz"] as const;

/** Descrição curta dos formatos aceitos, para mensagens ao usuário. */
export const SUPPORTED_ARCHIVE_LABEL = SUPPORTED_ARCHIVE_EXTENSIONS.join(", ");

/** Nome amigável do formato para mensagens ao usuário. */
export function archiveFormatLabel(format: ArchiveFormat): string {
  return ARCHIVE_KINDS.find((entry) => entry.format === format)?.label ?? "pacote";
}

/**
 * Descobre formato e extensão de um pacote pelo nome do arquivo, sempre sem
 * diferenciar maiúsculas e priorizando a extensão mais longa que casar.
 */
export function detectArchive(fileName: string): { format: ArchiveFormat; extension: string } | null {
  const lower = fileName.toLowerCase();
  for (const entry of ARCHIVE_KINDS) {
    if (lower.endsWith(entry.extension)) return { format: entry.format, extension: entry.extension };
  }
  return null;
}

/** Descobre só o formato pela extensão do arquivo (case-insensitive). */
export function detectArchiveFormat(fileName: string): ArchiveFormat | null {
  return detectArchive(fileName)?.format ?? null;
}

/** Indica se o nome termina em uma das extensões de pacote suportadas. */
export function isSupportedArchive(fileName: string): boolean {
  return detectArchive(fileName) !== null;
}

/**
 * Extrai um pacote para `destDir` escolhendo o extrator pela extensão: ZIP usa
 * o yauzl (streaming) e 7z/RAR/TAR usam o libarchive-wasm. As mesmas garantias
 * de segurança valem para todos: nada de path traversal, links ou junk do macOS.
 */
export async function extractArchive(
  archivePath: string,
  destDir: string,
  overridePrefix?: string | null,
  limits: ExtractLimits = {},
): Promise<ExtractResult> {
  const format = detectArchiveFormat(archivePath);
  if (format === null || format === "zip") return extractZip(archivePath, destDir, overridePrefix);
  return extractWithLibarchive(format, archivePath, destDir, overridePrefix, limits);
}

/**
 * Resolve o nome de uma entrada de 7z/RAR/TAR para um caminho dentro de `destDir`,
 * recusando travessia de diretório, caminhos absolutos e byte nulo — a mesma
 * proteção usada no caminho do ZIP.
 */
export function resolveArchiveEntry(destDir: string, entryPath: string): string {
  try {
    return resolveWithin(destDir, entryPath);
  } catch (error) {
    if (error instanceof PathEscapeError) {
      throw new UnsafeArchiveError(`O pacote contém um caminho inválido (${entryPath}).`);
    }
    throw error;
  }
}

let libarchive: Promise<LibarchiveWasm> | null = null;

/** Carrega o WASM do libarchive uma única vez por processo. */
function loadLibarchive(): Promise<LibarchiveWasm> {
  libarchive ??= libarchiveWasm();
  return libarchive;
}

/** Move o conteúdo de uma raiz única para cima e remove a pasta que ficou vazia. */
async function liftSingleRoot(destDir: string, prefix: string | null): Promise<string | null> {
  if (!prefix) return null;
  const segments = prefix.replace(/\/+$/, "").split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const rootDir = path.join(destDir, ...segments);
  const stats = await fsp.stat(rootDir).catch(() => null);
  if (!stats?.isDirectory()) return null;
  for (const child of await fsp.readdir(rootDir)) {
    await fsp.rename(path.join(rootDir, child), path.join(destDir, child));
  }
  await rmrf(rootDir);
  return prefix;
}

/**
 * Extrai 7z/RAR/TAR em memória com o libarchive. Lê o índice e o conteúdo na
 * mesma passada: cada entrada é validada (caminho, tipo, tamanho) antes de tocar
 * o disco, e qualquer violação aborta tudo — o release nunca fica pela metade.
 */
async function extractWithLibarchive(
  format: ArchiveFormat,
  archivePath: string,
  destDir: string,
  overridePrefix: string | null | undefined,
  limits: ExtractLimits,
): Promise<ExtractResult> {
  const label = archiveFormatLabel(format);
  const stats = await fsp.stat(archivePath);
  if (stats.size > MAX_IN_MEMORY_ARCHIVE_BYTES) {
    throw new UnsafeArchiveError(
      `Pacotes ${label} acima de ${Math.round(MAX_IN_MEMORY_ARCHIVE_BYTES / (1024 * 1024))} MB não são suportados. ` +
        "Reenvie o projeto como .zip, que é extraído em streaming.",
    );
  }

  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const engine = await loadLibarchive();

  await ensureDir(destDir);
  const extracted: string[] = [];
  let entries = 0;
  let files = 0;
  let bytes = 0;
  let reader: ArchiveReader | null = null;

  try {
    reader = new ArchiveReader(engine, new Int8Array(await fsp.readFile(archivePath)));
    if (reader.hasEncryptedData() === true) {
      throw new UnsafeArchiveError(`O pacote ${label} está protegido por senha e não pode ser usado.`);
    }

    for (const entry of reader.entries()) {
      entries += 1;
      if (entries > maxEntries) {
        throw new UnsafeArchiveError(`O pacote contém entradas demais (limite: ${maxEntries}).`);
      }

      const originalName = entry.getPathname().replace(/\\/g, "/");
      if (isJunkEntry(originalName)) continue;

      // Prefixo forçado pelo chamador (ex.: restaurar um backup dentro de uma
      // raiz específica); `null` significa "não remover nada" e `undefined`
      // deixa a detecção automática de raiz única cuidar disso depois.
      const entryName =
        overridePrefix && originalName.startsWith(overridePrefix)
          ? originalName.slice(overridePrefix.length)
          : originalName;
      if (entryName.length === 0) continue;

      const fileType = entry.getFiletype();
      if (fileType === "Directory") {
        await ensureDir(resolveArchiveEntry(destDir, entryName));
        continue;
      }
      if (fileType === "SymbolicLink") {
        throw new UnsafeArchiveError(`O pacote contém um link simbólico (${entryName}), que não é permitido.`);
      }
      if (entry.getHardlinkTarget()) {
        throw new UnsafeArchiveError(`O pacote contém um link rígido (${entryName}), que não é permitido.`);
      }
      if (fileType !== "File") {
        throw new UnsafeArchiveError(`O pacote contém um arquivo especial não suportado (${entryName}).`);
      }

      const declared = entry.getSize();
      bytes += declared;
      if (bytes > maxTotalBytes) {
        throw new UnsafeArchiveError("Pacote descompactado excede o tamanho máximo permitido.");
      }

      const destination = resolveArchiveEntry(destDir, entryName);
      await ensureDir(path.dirname(destination));
      await fsp.writeFile(destination, readEntryData(entryName, label, entry));
      extracted.push(entryName);
      files += 1;
    }
  } catch (error) {
    if (error instanceof UnsafeArchiveError) throw error;
    // Falhas do próprio libarchive (arquivo corrompido, truncado, formato
    // diferente do que a extensão promete…) viram 400 com mensagem útil em vez
    // de um 500 opaco.
    const message = error instanceof Error ? error.message : String(error);
    throw new UnsafeArchiveError(
      `Pacote ${label} inválido ou corrompido — o conteúdo não corresponde à extensão do arquivo. ` +
        `Detalhe técnico: ${message}`,
    );
  } finally {
    reader?.free();
  }

  const strippedRoot = overridePrefix === undefined ? computeStripPrefix(extracted) : overridePrefix;
  const lifted = overridePrefix === undefined ? await liftSingleRoot(destDir, strippedRoot) : null;
  return { files, bytes, strippedRoot: lifted ?? strippedRoot };
}

/** Lê o conteúdo de uma entrada, traduzindo falhas do libarchive em erro claro. */
function readEntryData(
  entryName: string,
  label: string,
  entry: { readData(): Int8Array | undefined },
): Int8Array {
  try {
    return entry.readData() ?? new Int8Array(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/encrypt|password|senha|ppmd/i.test(message)) {
      throw new UnsafeArchiveError(`O pacote ${label} está protegido por senha e não pode ser usado.`);
    }
    throw new UnsafeArchiveError(`Não foi possível ler ${entryName} dentro do pacote ${label}: ${message}`);
  }
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
