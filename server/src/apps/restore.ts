import fsp from "node:fs/promises";
import path from "node:path";
import type { PanelConfig } from "../config.ts";
import type { AppService, StartedDeploy } from "./service.ts";
import type { BackupService } from "./backups.ts";
import { NotFoundError, ValidationError, errorMessage } from "../errors.ts";
import { extractArchive } from "../util/archive.ts";
import { ensureDir, rmrf } from "../util/fsx.ts";
import { writeZip } from "../util/zipwrite.ts";
import type { ZipEntrySource } from "../util/zipwrite.ts";

/**
 * Restauração de backup: transforma um backup existente em um novo release da
 * aplicação. O ZIP de backup tem layout próprio (`backup.json`, `code/`,
 * `data/`), então ele é extraído em um diretório temporário e só a pasta
 * `code/` é reempacotada — o pacote gerado entra no mesmo `startDeploy` de
 * sempre, com extração, instalação de dependências e ativação idênticas a um
 * upload manual (e um novo release imutável como resultado).
 *
 * Um backup sem código (só `/data`) não pode virar release: o erro deixa isso
 * explícito em vez de publicar um release vazio.
 */
export class RestoreService {
  private readonly config: PanelConfig;
  private readonly apps: AppService;
  private readonly backups: BackupService;

  constructor(config: PanelConfig, apps: AppService, backups: BackupService) {
    this.config = config;
    this.apps = apps;
    this.backups = backups;
  }

  async restore(slug: string, backupId: number): Promise<StartedDeploy> {
    this.apps.mustGet(slug);
    const record = this.backups.get(slug, backupId);
    if (record.status !== "success") {
      throw new ValidationError("Este backup não foi concluído com sucesso e não pode ser restaurado.");
    }
    if (!(await existsAs(record.path))) {
      throw new NotFoundError("O arquivo deste backup não está mais no disco.");
    }

    const work = path.join(this.config.dataDir, "tmp", `restore-${record.id}-${Date.now()}`);
    const extracted = path.join(work, "x");
    const packagePath = path.join(work, "restore.zip");
    await rmrf(work);
    await ensureDir(extracted, 0o750);
    try {
      const extraction = await extractArchive(record.path, extracted);
      if (extraction.files <= 0) {
        throw new ValidationError("O backup não contém arquivos para restaurar.");
      }

      const codeDir = path.join(extracted, "code");
      if (!(await existsAs(codeDir, "directory"))) {
        throw new ValidationError(
          "Este backup não contém o código da aplicação (apenas o volume /data). Restaure os arquivos pelo gerenciador de arquivos.",
        );
      }

      const entries = await collectFiles(codeDir, "project");
      await writeZip(packagePath, entries);
    } catch (error) {
      // Falha antes do deploy: nada foi publicado e o temporário morre aqui.
      await rmrf(work);
      if (error instanceof ValidationError || error instanceof NotFoundError) throw error;
      throw new ValidationError(`Não foi possível preparar a restauração: ${errorMessage(error)}`);
    }

    const started = await this.apps.startDeploy(slug, packagePath, `Restauração do backup ${record.fileName}`);
    // O deploy consome o pacote em segundo plano: o temporário vive até ele
    // terminar (sucesso ou falha) e é removido logo depois.
    void started.finished.finally(() => {
      void rmrf(work);
    });
    return started;
  }
}

async function existsAs(target: string, kind: "any" | "directory" = "any"): Promise<boolean> {
  try {
    const stats = await fsp.stat(target);
    return kind === "directory" ? stats.isDirectory() : true;
  } catch {
    return false;
  }
}

/** Percorre a pasta extraída juntando arquivos regulares para o ZIP. */
async function collectFiles(root: string, prefix: string): Promise<ZipEntrySource[]> {
  const entries: ZipEntrySource[] = [];
  const walk = async (dir: string, current: string): Promise<void> => {
    let items: import("node:fs").Dirent[];
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full, `${current}/${item.name}`);
        continue;
      }
      if (!item.isFile()) continue;
      entries.push({ absolutePath: full, entryName: `${current}/${item.name}` });
    }
  };
  await walk(root, prefix);
  return entries;
}
