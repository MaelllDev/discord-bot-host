import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(target: string, mode = 0o755): Promise<void> {
  await fsp.mkdir(target, { recursive: true, mode });
}

export async function rmrf(target: string): Promise<void> {
  await fsp.rm(target, { recursive: true, force: true });
}

/** Tamanho total de um diretório, somando os arquivos (ignora links quebrados). */
export async function dirSize(target: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(target, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await dirSize(full);
      } else if (entry.isFile()) {
        total += (await fsp.stat(full)).size;
      }
    } catch {
      // ignora arquivos inacessíveis
    }
  }
  return total;
}

/**
 * Ajusta o dono de uma árvore de arquivos. Os containers rodam com um UID fixo
 * para que a aplicação consiga ler/escrever o próprio código e o volume /data.
 * Sem permissão (dev sem root) a falha é ignorada de propósito.
 */
export async function chownRecursive(target: string, uid: number, gid: number): Promise<boolean> {
  try {
    const stats = await fsp.lstat(target);
    if (stats.isSymbolicLink()) return false;
    if (!stats.isDirectory()) {
      await fsp.chown(target, uid, gid);
      return true;
    }

    await fsp.chown(target, uid, gid);
    const entries = await fsp.readdir(target, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(target, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await chownRecursive(full, uid, gid);
      } else {
        await fsp.chown(full, uid, gid);
      }
    }
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Sem permissão (dev sem root) ou caminho inexistente: segue sem bloquear.
    if (code === "EPERM" || code === "EACCES" || code === "ENOENT") return false;
    throw error;
  }
}

export interface DirEntryInfo {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  sizeBytes: number;
  modifiedAt: string | null;
  executable: boolean;
}

export async function listDirectory(target: string): Promise<DirEntryInfo[]> {
  const entries = await fsp.readdir(target, { withFileTypes: true });
  const result: DirEntryInfo[] = [];
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    let sizeBytes = 0;
    let modifiedAt: string | null = null;
    let executable = false;
    try {
      const stat = await fsp.stat(full);
      sizeBytes = entry.isDirectory() ? 0 : stat.size;
      modifiedAt = stat.mtime.toISOString();
      executable = (stat.mode & 0o111) !== 0;
    } catch {
      // link quebrado
    }
    const type: DirEntryInfo["type"] = entry.isDirectory()
      ? "directory"
      : entry.isFile()
        ? "file"
        : entry.isSymbolicLink()
          ? "symlink"
          : "other";
    result.push({ name: entry.name, type, sizeBytes, modifiedAt, executable });
  }
  result.sort((left, right) => {
    if (left.type === "directory" && right.type !== "directory") return -1;
    if (right.type === "directory" && left.type !== "directory") return 1;
    return left.name.localeCompare(right.name, "pt-BR");
  });
  return result;
}

export async function readJsonFile<T>(target: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(target, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function writeJsonFile(target: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(target));
  await fsp.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
