import fsp from "node:fs/promises";
import path from "node:path";
import type { PanelConfig } from "../config.ts";
import { chownRecursive, ensureDir, listDirectory, pathExists, rmrf } from "../util/fsx.ts";
import { resolveWithin } from "../util/paths.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import type { DirEntryInfo } from "../util/fsx.ts";
import type { AppService } from "./service.ts";

export type FileRoot = "code" | "data";

export interface FileListing {
  root: FileRoot;
  path: string;
  entries: DirEntryInfo[];
}

export interface FileContent {
  root: FileRoot;
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
  binary: boolean;
}

const MAX_TEXT_BYTES = 512 * 1024;

function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, 8192);
  return probe.includes(0);
}

export class FileService {
  private readonly config: PanelConfig;
  private readonly apps: AppService;

  constructor(config: PanelConfig, apps: AppService) {
    this.config = config;
    this.apps = apps;
  }

  /** Resolve o diretório raiz pedido, garantindo que ele exista. */
  private async resolveRoot(slug: string, root: FileRoot): Promise<string> {
    const roots = await this.apps.browsableRoots(slug);
    if (root === "code") {
      if (!roots.code) {
        throw new ValidationError("Nenhum release publicado: publique uma versão para ver os arquivos do código.");
      }
      return roots.code;
    }
    if (root !== "data") throw new ValidationError(`Raiz de arquivos inválida: ${root}`);
    await ensureDir(roots.data, 0o770);
    return roots.data;
  }

  private async absolute(slug: string, root: FileRoot, relative: string): Promise<string> {
    const base = await this.resolveRoot(slug, root);
    return resolveWithin(base, relative.replace(/^\/+/, ""));
  }

  private async syncOwnership(slug: string, root: FileRoot, target: string): Promise<void> {
    if (root !== "code" && root !== "data") return;
    await chownRecursive(target, this.config.runUid, this.config.runGid);
    void slug;
  }

  async list(slug: string, root: FileRoot, relative = ""): Promise<FileListing> {
    const base = await this.resolveRoot(slug, root);
    const target = resolveWithin(base, relative.replace(/^\/+/, ""));
    if (!(await pathExists(target))) throw new NotFoundError(`Diretório não encontrado: ${relative || "/"}`);
    const entries = await listDirectory(target);
    return { root, path: relative.replace(/^\/+/, ""), entries };
  }

  async read(slug: string, root: FileRoot, relative: string): Promise<FileContent> {
    const target = await this.absolute(slug, root, relative);
    const stats = await fsp.stat(target).catch(() => null);
    if (!stats || !stats.isFile()) throw new NotFoundError(`Arquivo não encontrado: ${relative}`);

    const handle = await fsp.open(target, "r");
    try {
      const length = Math.min(stats.size, MAX_TEXT_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      const binary = looksBinary(buffer);
      return {
        root,
        path: relative,
        content: binary ? "" : buffer.toString("utf8"),
        sizeBytes: stats.size,
        truncated: stats.size > length,
        binary,
      };
    } finally {
      await handle.close();
    }
  }

  async write(slug: string, root: FileRoot, relative: string, content: string): Promise<void> {
    if (relative.trim().length === 0) throw new ValidationError("Informe o caminho do arquivo.");
    const target = await this.absolute(slug, root, relative);
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, content, "utf8");
    await this.syncOwnership(slug, root, target);
  }

  async mkdir(slug: string, root: FileRoot, relative: string): Promise<void> {
    if (relative.trim().length === 0) throw new ValidationError("Informe o nome da pasta.");
    const target = await this.absolute(slug, root, relative);
    await ensureDir(target, 0o775);
    await this.syncOwnership(slug, root, target);
  }

  async remove(slug: string, root: FileRoot, relative: string): Promise<void> {
    if (relative.trim().length === 0) throw new ValidationError("Não é possível remover a raiz.");
    const target = await this.absolute(slug, root, relative);
    if (!(await pathExists(target))) throw new NotFoundError(`Item não encontrado: ${relative}`);
    await rmrf(target);
  }

  async rename(slug: string, root: FileRoot, from: string, to: string): Promise<void> {
    if (from.trim().length === 0 || to.trim().length === 0) throw new ValidationError("Informe origem e destino.");
    const source = await this.absolute(slug, root, from);
    const destination = await this.absolute(slug, root, to);
    if (!(await pathExists(source))) throw new NotFoundError(`Item não encontrado: ${from}`);
    if (await pathExists(destination)) throw new ValidationError(`Já existe um item em "${to}".`);
    await ensureDir(path.dirname(destination));
    await fsp.rename(source, destination);
    await this.syncOwnership(slug, root, destination);
  }

  /** Grava um arquivo enviado por upload (substituindo o existente). */
  async saveUpload(slug: string, root: FileRoot, relative: string, data: Buffer): Promise<void> {
    if (relative.trim().length === 0) throw new ValidationError("Informe o caminho do arquivo.");
    const target = await this.absolute(slug, root, relative);
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, data);
    await this.syncOwnership(slug, root, target);
  }

  async downloadPath(slug: string, root: FileRoot, relative: string): Promise<{ absolutePath: string; name: string }> {
    const target = await this.absolute(slug, root, relative);
    const stats = await fsp.stat(target).catch(() => null);
    if (!stats || !stats.isFile()) throw new NotFoundError(`Arquivo não encontrado: ${relative}`);
    return { absolutePath: target, name: path.basename(target) };
  }
}
