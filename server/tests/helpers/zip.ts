import { deflateRawSync, crc32 } from "node:zlib";

export interface ZipEntryInput {
  name: string;
  content?: string | Buffer;
  /** Permissões Unix armazenadas nos atributos externos. */
  mode?: number;
  /** Quando definido, cria uma entrada de link simbólico apontando para o alvo. */
  symlinkTo?: string;
  /** Usa deflate em vez de armazenamento sem compressão. */
  compress?: boolean;
}

interface PreparedEntry {
  name: Buffer;
  data: Buffer;
  crc: number;
  method: number;
  compressed: Buffer;
  externalAttributes: number;
}

function prepare(entry: ZipEntryInput): PreparedEntry {
  const isDirectory = entry.name.endsWith("/");
  const mode = entry.symlinkTo ? 0o120777 : (entry.mode ?? (isDirectory ? 0o040755 : 0o100644));
  const body = entry.symlinkTo ?? entry.content ?? "";
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const crc = crc32(data) >>> 0;
  const compressor = entry.compress && data.length > 0 ? deflateRawSync(data) : null;

  return {
    name: Buffer.from(entry.name, "utf8"),
    data,
    crc,
    method: compressor ? 8 : 0,
    compressed: compressor ?? data,
    // Mantém os bits de tipo (S_IFLNK/S_IFREG/S_IFDIR) junto das permissões,
    // como fazem os compactadores reais (16 bits altos de externalFileAttributes).
    externalAttributes: ((mode & 0xffff) << 16) >>> 0,
  };
}

/**
 * Monta um arquivo ZIP real (com diretório central e EOCD) para os testes.
 * Suporta entradas armazenadas, comprimidas (deflate) e links simbólicos.
 */
export function makeZip(entries: ZipEntryInput[]): Buffer {
  const prepared = entries.map(prepare);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of prepared) {
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // versão mínima
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(entry.method, 8);
    localHeader.writeUInt16LE(0, 10); // hora
    localHeader.writeUInt16LE(0x21, 12); // data (1980-01-01)
    localHeader.writeUInt32LE(entry.crc, 14);
    localHeader.writeUInt32LE(entry.compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(entry.name.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra

    localParts.push(localHeader, entry.name, entry.compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x031e, 4); // criado em Unix
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(entry.method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(entry.crc, 16);
    centralHeader.writeUInt32LE(entry.compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(entry.name.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // comentário
    centralHeader.writeUInt16LE(0, 34); // disco
    centralHeader.writeUInt16LE(0, 36); // atributos internos
    centralHeader.writeUInt32LE(entry.externalAttributes, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, entry.name);
    offset += localHeader.length + entry.name.length + entry.compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(prepared.length, 8);
  end.writeUInt16LE(prepared.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}
