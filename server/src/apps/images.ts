import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { PanelConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";

/** Extensões aceitas por MIME type real (o Content-Type declarado não é prova). */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB por imagem
/** Limites de segurança do SVG — ele pode carregar script, os bitmaps não. */
const MAX_SVG_BYTES = 512 * 1024;
/** Espaço total por instância em dataDir/uploads/images. */
const QUOTA_BYTES = 256 * 1024 * 1024;

/**
 * Dimensões de um PNG/JPEG/GIF/WebP/ICO sem biblioteca: os cabeçalhos trazem
 * width/height nos primeiros bytes, e basta comparar com os limites. SVG não
 * tem dimensão obrigatória — passa livre (o <img> escala).
 */
export function imageSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 8) return null;
  if (buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1] ?? 0;
      const length = buffer.readUInt16BE(offset + 2);
      // SOF0..SOF15, exceto DHT (C4) e JPG (C8): carregam a resolução.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8) {
        return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
    return null;
  }
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const format = buffer.toString("ascii", 12, 16);
    if (format === "VP8 ") return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    if (format === "VP8L") {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (format === "VP8X") {
      const byte = (index: number): number => buffer[index] ?? 0;
      const width = 1 + (byte(24) | (byte(25) << 8) | (byte(26) << 16));
      const height = 1 + (byte(27) | (byte(28) << 8) | (byte(29) << 16));
      return { width, height };
    }
    return null;
  }
  if (buffer.toString("ascii", 0, 3) === "GIF") {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) {
    return { width: buffer.readUInt16LE(6) || 256, height: buffer.readUInt16LE(8) || 256 };
  }
  return null;
}

export interface SavedImage {
  id: string;
  fileName: string;
  url: string;
  sizeBytes: number;
}

export class ImageStore {
  private readonly root: string;
  private readonly config: PanelConfig;

  constructor(config: PanelConfig) {
    this.config = config;
    this.root = path.join(config.dataDir, "uploads", "images");
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.root, { recursive: true });
  }

  /** Diretório onde as imagens ficam — usado pelo handler de estáticos. */
  get dir(): string {
    return this.root;
  }

  /** Salva o stream multipart com validação de tipo/tamanho/dimensão. */
  async save(stream: NodeJS.ReadableStream & { truncated?: boolean }, declaredMime: string): Promise<SavedImage> {
    // Aceita apenas pelo conteúdo (magic bytes); o MIME declarado só ajuda a
    // decidir a extensão — nunca é prova de tipo.
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as ArrayBuffer);
      total += buffer.length;
      if (total > MAX_BYTES) throw new ValidationError("A imagem excede o limite de 4 MB.");
      chunks.push(buffer);
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) throw new ValidationError("Nenhuma imagem recebida.");
    if (stream.truncated) throw new ValidationError("A imagem excede o limite de 4 MB.");

    const kind = sniffImage(buffer);
    if (!kind) {
      throw new ValidationError("Formato não suportado. Envie PNG, JPEG, GIF, WebP, SVG ou ICO.");
    }
    if (kind === "svg") {
      if (buffer.length > MAX_SVG_BYTES) throw new ValidationError("O SVG excede o limite de 512 KB.");
      if (/(<script|on\w+\s*=|javascript:)/i.test(buffer.toString("utf8"))) {
        throw new ValidationError("O SVG contém conteúdo não permitido (script).");
      }
    }
    if (declaredMime && !Object.values(MIME_BY_EXT).includes(declaredMime)) {
      throw new ValidationError(`Content-Type não suportado: ${declaredMime}.`);
    }

    const dims = kind === "svg" ? { width: 512, height: 512 } : imageSize(buffer);
    if (dims && (dims.width > 4096 || dims.height > 4096)) {
      throw new ValidationError("A imagem excede 4096×4096 pixels.");
    }

    const id = randomBytes(8).toString("hex");
    const ext = kind === "jpeg" ? "jpg" : kind;
    const fileName = `${id}.${ext}`;
    await fsp.writeFile(path.join(this.root, fileName), buffer, { mode: 0o644 });
    return { id, fileName, url: `/uploads/images/${fileName}`, sizeBytes: buffer.length };
  }

  /** Bytes de uma imagem salva, ou null quando o nome não é confiável. */
  read(fileName: string): Buffer | null {
    // O nome precisa ser exatamente o padrão gerado: sem travessia de caminho.
    if (!/^[a-f0-9]{16}\.(?:png|jpg|jpeg|gif|webp|svg|ico)$/.test(fileName)) return null;
    try {
      return fs.readFileSync(path.join(this.root, fileName));
    } catch {
      return null;
    }
  }

  /** Uso total do diretório de imagens (para a cota). */
  async usedBytes(): Promise<number> {
    try {
      const files = await fsp.readdir(this.root);
      let total = 0;
      for (const file of files) {
        const stat = await fsp.stat(path.join(this.root, file)).catch(() => null);
        if (stat?.isFile()) total += stat.size;
      }
      return total;
    } catch {
      return 0;
    }
  }

  /** Remove um arquivo de imagem pelo nome validado. */
  async remove(fileName: string): Promise<void> {
    if (!/^[a-f0-9]{16}\.(?:png|jpg|jpeg|gif|webp|svg|ico)$/.test(fileName)) return;
    await fsp.rm(path.join(this.root, fileName), { force: true });
  }
}

function sniffImage(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (buffer.readUInt32BE(0) === 0x89504e47) return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "jpeg";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buffer.toString("ascii", 0, 3) === "GIF") return "gif";
  if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) return "ico";
  const head = buffer.toString("utf8", 0, 200).trim().toLowerCase();
  if (head.startsWith("<?xml") || head.startsWith("<svg")) {
    // Um "SVG" que na verdade é HTML/JS disfarçado não passa.
    return buffer.toString("utf8").includes("<svg") ? "svg" : null;
  }
  return null;
}
