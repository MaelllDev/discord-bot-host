import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { PanelConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { ensureDir, rmrf } from "../util/fsx.ts";
import { detectArchive, SUPPORTED_ARCHIVE_LABEL } from "../util/archive.ts";
import type { UploadRecord, UploadStore } from "./uploads.ts";

/**
 * Tamanho máximo de um pacote baixado por URL. Por padrão acompanha
 * BOTPANEL_MAX_UPLOAD_MB (o mesmo teto do upload multipart), com teto mínimo
 * de segurança para o caso do valor configurado estar zerado.
 */
export const DEFAULT_FETCH_LIMIT_MB = 512;

/** Só http(s): nada de `file:`, `ftp:` ou redirecionamento para unix socket. */
function assertHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError("URL inválida.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError("Apenas URLs http:// ou https:// são aceitas.");
  }
  return url;
}

/**
 * Deploy por URL: o painel baixa o pacote de um endereço http(s) informado e
 * o registra como um upload comum — daí para frente o fluxo é idêntico ao do
 * upload manual (inspeção, deploy, descarte). Útil para reinstalar a partir de
 * um release do GitHub sem passar pelo navegador.
 *
 * O download é em stream direto para o disco: um Content-Length maior que o
 * limite aborta antes de baixar, e bytes demais no meio do stream também.
 */
export class UrlFetchService {
  private readonly config: PanelConfig;
  private readonly uploads: UploadStore;
  private readonly limitBytes: number;

  constructor(config: PanelConfig, uploads: UploadStore, limitBytes?: number) {
    this.config = config;
    this.uploads = uploads;
    this.limitBytes = limitBytes ?? Math.max(config.maxUploadBytes, 64 * 1024 * 1024);
  }

  /** Baixa o pacote e devolve o mesmo registro usado pelo upload multipart. */
  async fetchToUpload(rawUrl: string): Promise<UploadRecord> {
    const url = assertHttpUrl(rawUrl);
    // A extensão da URL só escolhe o extrator; se não houver, o nome é
    // "pacote.zip" e o tipo real é detectado pelo conteúdo depois.
    const fileName = decodeURIComponent(path.basename(url.pathname)) || "pacote.zip";
    const kind = detectArchive(fileName);
    if (!kind) {
      throw new ValidationError(
        `A URL não termina em uma extensão suportada (${SUPPORTED_ARCHIVE_LABEL}). Use o link direto do arquivo.`,
      );
    }

    await ensureDir(this.uploads.uploadsDir, 0o750);
    const record = await this.uploads.allocate(kind.extension);
    const target = record.filePath;
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(10 * 60_000),
      });
      if (!response.ok) {
        throw new ValidationError(`O servidor respondeu HTTP ${response.status} para a URL informada.`);
      }
      const declared = response.headers.get("content-length");
      if (declared && Number(declared) > this.limitBytes) {
        throw new ValidationError(
          `O arquivo remoto tem pelo menos ${Math.ceil(Number(declared) / (1024 * 1024))} MB e passa do limite de ${Math.round(this.limitBytes / (1024 * 1024))} MB.`,
        );
      }
      if (!response.body) {
        throw new ValidationError("O servidor não enviou nenhum conteúdo.");
      }

      let received = 0;
      const guard = new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          received += chunk.byteLength;
          if (received > this.limitBytes) {
            controller.error(new Error("limite de tamanho excedido"));
            return;
          }
          controller.enqueue(chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body.pipeThrough(guard) as never), createWriteStream(target));
    } catch (error) {
      await rmrf(target);
      this.uploads.forget(record.id);
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("limite de tamanho excedido")) {
        throw new ValidationError(
          `O download passou do limite de ${Math.round(this.limitBytes / (1024 * 1024))} MB.`,
        );
      }
      throw new ValidationError(`Falha ao baixar o pacote: ${message}`);
    }

    const saved = this.uploads.commit(record);
    if (saved.sizeBytes === 0) {
      await this.uploads.discard(saved.id);
      throw new ValidationError("O arquivo baixado está vazio.");
    }
    return saved;
  }
}
