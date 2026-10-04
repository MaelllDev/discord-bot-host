import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import { createWriteStream, statSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { PanelConfig } from "../config.ts";
import { ensureDir, rmrf } from "../util/fsx.ts";
import { detectProject } from "./detect.ts";
import { detectArchive, extractArchive, SUPPORTED_ARCHIVE_LABEL } from "../util/archive.ts";
import type { ProjectDetection } from "./detect.ts";
import { NotFoundError, ValidationError } from "../errors.ts";

function statSyncSafe(target: string): { size: number } | null {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

export interface UploadRecord {
  id: string;
  fileName: string;
  sizeBytes: number;
  filePath: string;
  createdAt: number;
}

export interface UploadInspection extends UploadRecord {
  detection: ProjectDetection;
  fileCount: number;
}

/**
 * Guarda os pacotes enviados (.zip, .7z, .rar, .tar.gz, .tar.xz…) em disco até
 * que o deploy os consuma. Os arquivos ficam em `<dataDir>/tmp/uploads` e são
 * limpos no boot e por expiração.
 */
export class UploadStore {
  private readonly config: PanelConfig;
  private readonly records = new Map<string, UploadRecord>();
  private readonly ttlMs = 6 * 60 * 60 * 1000;

  constructor(config: PanelConfig) {
    this.config = config;
  }

  get uploadsDir(): string {
    return path.join(this.config.dataDir, "tmp", "uploads");
  }

  async init(): Promise<void> {
    await rmrf(path.join(this.config.dataDir, "tmp"));
    await ensureDir(this.uploadsDir, 0o750);
  }

  /** Salva o stream do upload em disco e devolve o identificador para o deploy. */
  async save(stream: NodeJS.ReadableStream, fileName: string): Promise<UploadRecord> {
    const id = randomUUID();
    const safeName = path.basename(fileName || "pacote.zip").replace(/[^\w.\- ]+/g, "_").slice(-80) || "pacote.zip";
    const kind = detectArchive(safeName);
    if (!kind) {
      throw new ValidationError(
        `Envie um pacote ${SUPPORTED_ARCHIVE_LABEL} contendo o projeto da aplicação.`,
      );
    }
    await ensureDir(this.uploadsDir, 0o750);
    // A extensão define o extrator usado no deploy, então ela é preservada.
    const filePath = path.join(this.uploadsDir, `${id}${kind.extension}`);

    await pipeline(stream, createWriteStream(filePath));
    const stats = await fsp.stat(filePath).catch(() => null);
    if (!stats || stats.size === 0) {
      await rmrf(filePath);
      throw new ValidationError("O arquivo enviado está vazio.");
    }

    const record: UploadRecord = { id, fileName: safeName, sizeBytes: stats.size, filePath, createdAt: Date.now() };
    this.records.set(id, record);
    return record;
  }

  /**
   * Primitivas para fontes que não vêm de multipart (ex.: download por URL):
   * `allocate` reserva id/caminho com a extensão que escolhe o extrator, o
   * conteúdo é gravado pela chamadora e `commit` valida e registra o resultado.
   */
  async allocate(extension: string): Promise<UploadRecord> {
    const id = randomUUID();
    await ensureDir(this.uploadsDir, 0o750);
    const filePath = path.join(this.uploadsDir, `${id}${extension}`);
    return { id, fileName: `pacote${extension}`, sizeBytes: 0, filePath, createdAt: Date.now() };
  }

  /** Registra o upload após o arquivo estar completo no disco. */
  commit(record: UploadRecord): UploadRecord {
    const stats = statSyncSafe(record.filePath);
    if (!stats || stats.size === 0) {
      throw new ValidationError("O pacote recebido está vazio.");
    }
    const saved: UploadRecord = { ...record, sizeBytes: stats.size, createdAt: Date.now() };
    this.records.set(saved.id, saved);
    return saved;
  }

  /** Esquece um upload reservado sem apagar o arquivo (a chamadora já apagou). */
  forget(id: string): void {
    this.records.delete(id);
  }

  get(id: string): UploadRecord | null {
    const record = this.records.get(id);
    if (!record) return null;
    if (Date.now() - record.createdAt > this.ttlMs) {
      this.records.delete(id);
      void rmrf(record.filePath);
      return null;
    }
    return record;
  }

  mustGet(id: string): UploadRecord {
    const record = this.get(id);
    if (!record) throw new NotFoundError("Upload não encontrado ou expirado. Envie o pacote novamente.");
    return record;
  }

  /**
   * Extrai o pacote em um diretório temporário e detecta runtime, arquivo
   * principal e dependências — usado para preencher o formulário antes de criar
   * a app, sem depender do formato enviado.
   */
  async inspect(id: string): Promise<UploadInspection> {
    const record = this.mustGet(id);
    const scratch = path.join(this.config.dataDir, "tmp", `inspect-${record.id}`);
    await rmrf(scratch);
    try {
      const result = await extractArchive(record.filePath, scratch);
      const detection = await detectProject(scratch);
      return { ...record, detection, fileCount: result.files };
    } finally {
      await rmrf(scratch);
    }
  }

  /** Valida o pacote sem criar nada (usado antes de publicar um release). */
  async validate(id: string): Promise<void> {
    const record = this.mustGet(id);
    const stats = await fsp.stat(record.filePath);
    if (stats.size === 0) throw new ValidationError("O pacote enviado está vazio.");
  }

  async discard(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    this.records.delete(id);
    await rmrf(record.filePath);
  }

  /** Remove uploads expirados (chamado periodicamente pelo servidor). */
  async cleanup(): Promise<void> {
    for (const [id, record] of this.records) {
      if (Date.now() - record.createdAt > this.ttlMs) {
        this.records.delete(id);
        await rmrf(record.filePath);
      }
    }
  }
}
