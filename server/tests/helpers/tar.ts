/**
 * Escritor mínimo de TAR (formato ustar) para os testes — o projeto já monta
 * ZIPs à mão em `helpers/zip.ts`, então o TAR segue o mesmo caminho e evita
 * carregar blobs binários grandes no repositório.
 *
 * Suporta arquivos, diretórios, links simbólicos e o bit de execução, que é o
 * necessário para exercitar o extrator.
 */
export interface TarEntryInput {
  name: string;
  content?: string | Buffer;
  /** Quando definido, cria uma entrada de link simbólico apontando para o alvo. */
  symlinkTo?: string;
  /** Marca a entrada como diretório (ganha a barra final no nome). */
  directory?: boolean;
  /** Permissões Unix (padrão: 0644 para arquivo, 0755 para diretório). */
  mode?: number;
}

const BLOCK = 512;

/** Escreve um campo numérico octal terminado em NUL, no tamanho do cabeçalho. */
function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0").slice(-(length - 1));
  target.write(text, offset, length - 1, "ascii");
  target[offset + length - 1] = 0;
}

function header(entry: TarEntryInput): Buffer {
  const block = Buffer.alloc(BLOCK);
  const isDirectory = entry.directory === true;
  const isSymlink = typeof entry.symlinkTo === "string";
  const name = isDirectory && !entry.name.endsWith("/") ? `${entry.name}/` : entry.name;
  const body = isSymlink ? entry.symlinkTo! : entry.content ?? "";
  const data = isSymlink ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const mode = entry.mode ?? (isDirectory ? 0o755 : isSymlink ? 0o777 : 0o644);

  block.write(name.slice(0, 100), 0, 100, "utf8");
  writeOctal(block, 100, 8, mode);
  writeOctal(block, 108, 8, 0); // uid
  writeOctal(block, 116, 8, 0); // gid
  writeOctal(block, 124, 12, data.length);
  writeOctal(block, 136, 12, 0); // mtime
  block.write("        ", 148, 8, "ascii"); // espaço reservado para o checksum
  block[156] = isDirectory ? 0x35 : isSymlink ? 0x32 : 0x30; // '5' | '2' | '0'
  if (isSymlink) block.write(entry.symlinkTo!.slice(0, 100), 157, 100, "utf8");
  block.write("ustar", 257, 5, "ascii");
  block[262] = 0;
  block.write("00", 263, 2, "ascii");
  block.write("root", 265, 4, "ascii");
  block.write("root", 297, 4, "ascii");

  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");

  return block;
}

function padded(data: Buffer): Buffer {
  if (data.length === 0) return Buffer.alloc(0);
  const remainder = data.length % BLOCK;
  if (remainder === 0) return data;
  return Buffer.concat([data, Buffer.alloc(BLOCK - remainder)]);
}

/** Monta um TAR válido (ustar) com as entradas informadas, na ordem dada. */
export function makeTar(entries: TarEntryInput[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(header(entry));
    if (!entry.symlinkTo && !entry.directory) {
      const body = entry.content ?? "";
      parts.push(padded(Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8")));
    }
  }
  // Dois blocos de zeros encerram o arquivo.
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}
