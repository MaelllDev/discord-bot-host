import { createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";

/** Um arquivo do disco que entra no ZIP com outro nome de caminho. */
export interface ZipFileSource {
  absolutePath: string;
  /** Caminho dentro do ZIP, sempre com `/`. */
  entryName: string;
}

/** Conteúdo gerado em memória (ex.: um arquivo de metadados). */
export interface ZipBufferSource {
  entryName: string;
  data: Buffer;
}

export type ZipEntrySource = ZipFileSource | ZipBufferSource;

export interface WriteZipResult {
  files: number;
  /** Soma dos tamanhos originais (antes de compactar). */
  bytes: number;
}

/**
 * Escreve um ZIP a partir de uma lista de arquivos. O `yazl` é o complemento de
 * escrita do `yauzl` (que o painel já usa para ler os pacotes enviados): mantém
 * um formato de ZIP conhecido e correto em vez de um escritor próprio.
 */
export async function writeZip(destPath: string, entries: ZipEntrySource[]): Promise<WriteZipResult> {
  await fsp.mkdir(path.dirname(destPath), { recursive: true, mode: 0o750 });

  const zip = new yazl.ZipFile();
  let files = 0;
  let bytes = 0;

  try {
    for (const entry of entries) {
      const entryName = entry.entryName.replace(/\\/g, "/");
      if ("data" in entry) {
        zip.addBuffer(entry.data, entryName);
        bytes += entry.data.byteLength;
      } else {
        const stats = await fsp.stat(entry.absolutePath);
        zip.addFile(entry.absolutePath, entryName);
        bytes += stats.size;
      }
      files += 1;
    }

    const finished = pipeline(zip.outputStream, createWriteStream(destPath));
    zip.end();
    await finished;
  } catch (error) {
    await fsp.rm(destPath, { force: true });
    throw error;
  }

  return { files, bytes };
}
