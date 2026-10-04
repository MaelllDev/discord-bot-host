/**
 * Formatos de pacote aceitos no upload de código — precisa acompanhar o que o
 * backend reconhece (`server/src/util/archive.ts`). A ordem é da extensão mais
 * longa para a mais curta, para `.tar.gz` nunca ser lido como `.tar`.
 */
export const ARCHIVE_EXTENSIONS = [
  ".tar.gz",
  ".tar.xz",
  ".tgz",
  ".txz",
  ".zip",
  ".7z",
  ".rar",
  ".tar",
] as const;

/** Texto pronto para as mensagens ("zip, 7z, rar, tar.gz ou tar.xz"). */
export const ARCHIVE_EXTENSIONS_LABEL = "zip, 7z, rar, tar.gz ou tar.xz";

/**
 * Atributo `accept` dos inputs de arquivo. As extensões cobrem todos os
 * formatos; os MIME types ajudam o seletor do sistema a filtrar melhor.
 */
export const ARCHIVE_ACCEPT = [
  ...ARCHIVE_EXTENSIONS,
  "application/zip",
  "application/x-zip-compressed",
  "application/x-7z-compressed",
  "application/vnd.rar",
  "application/x-rar-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/x-xz",
  "application/x-tar",
].join(",");

/** true quando o nome do arquivo termina em uma extensão de pacote aceita. */
export function isArchiveFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** Remove a extensão do pacote, útil para sugerir o nome da aplicação. */
export function stripArchiveExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  for (const extension of ARCHIVE_EXTENSIONS) {
    if (lower.endsWith(extension)) return fileName.slice(0, fileName.length - extension.length);
  }
  return fileName;
}
