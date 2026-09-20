import path from "node:path";

/**
 * Erro lançado quando um caminho tentaria escapar do diretório raiz permitido.
 */
export class PathEscapeError extends Error {
  readonly relativePath: string;

  constructor(relativePath: string) {
    super(`Caminho não permitido: ${relativePath}`);
    this.name = "PathEscapeError";
    this.relativePath = relativePath;
  }
}

/**
 * Normaliza um caminho relativo vindo do cliente (ou de um ZIP) e garante que ele
 * fica dentro de `root`. Bloqueia caminhos absolutos, `..`, barras do Windows e
 * byte nulo — a base da proteção contra path traversal e zip-slip.
 */
export function resolveWithin(root: string, relativePath: string): string {
  if (typeof relativePath !== "string") throw new PathEscapeError(String(relativePath));
  if (relativePath.includes("\0")) throw new PathEscapeError(relativePath);

  const unified = relativePath.replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(unified)) throw new PathEscapeError(relativePath);
  if (unified.startsWith("/")) throw new PathEscapeError(relativePath);

  const rootResolved = path.resolve(root);
  const segments = unified.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  const cleaned: string[] = [];
  for (const segment of segments) {
    if (segment === "..") {
      if (cleaned.length === 0) throw new PathEscapeError(relativePath);
      cleaned.pop();
      continue;
    }
    cleaned.push(segment);
  }

  const target = path.join(rootResolved, ...cleaned);
  const resolved = path.resolve(target);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new PathEscapeError(relativePath);
  }
  return resolved;
}

/** Indica se o caminho relativo é seguro, sem lançar exceção. */
export function isWithin(root: string, relativePath: string): boolean {
  try {
    resolveWithin(root, relativePath);
    return true;
  } catch {
    return false;
  }
}

/** Retorna o caminho relativo (com `/`) de `target` em relação a `root`. */
export function relativeTo(root: string, target: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative.split(path.sep).filter(Boolean).join("/");
}
