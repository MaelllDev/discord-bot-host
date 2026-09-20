import path from "node:path";
import type { Dirent } from "node:fs";
import fsp from "node:fs/promises";
import type { PanelConfig } from "../config.ts";
import type { Store } from "../db.ts";
import { nowIso } from "../db.ts";
import type { AppRecord, BackupRecord } from "../types.ts";
import { NotFoundError, ValidationError, errorMessage } from "../errors.ts";
import { backupsDir, releaseDir, sharedDir } from "./paths.ts";
import { ensureDir, pathExists, rmrf } from "../util/fsx.ts";
import { humanBytes } from "../util/format.ts";
import { writeZip } from "../util/zipwrite.ts";
import type { ZipEntrySource } from "../util/zipwrite.ts";

/**
 * Pastas que ficam fora do backup: são derivadas do manifesto de dependências e
 * o deploy as recria. Incluí-las multiplicaria o tamanho do ZIP sem acrescentar
 * informação (um `node_modules` costuma ser maior que o projeto inteiro).
 */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".botpanel-py",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".git",
  ".cache",
  ".npm",
]);

/** Teto de segurança para um backup não encher o disco da VPS. */
const MAX_BACKUP_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Backups sob demanda: um ZIP com o código do release ativo (sem as pastas de
 * dependências) e, opcionalmente, o volume persistente `/data`. O arquivo é
 * gravado dentro da pasta da aplicação, então remover a aplicação apagando os
 * arquivos leva os backups junto.
 */
export class BackupService {
  private readonly config: PanelConfig;
  private readonly store: Store;
  /** Backups gerando agora — não podem ser apagados no meio do processo. */
  private readonly running = new Set<number>();

  constructor(config: PanelConfig, store: Store) {
    this.config = config;
    this.store = store;
  }

  /**
   * Backups interrompidos por um reinício do painel ficariam "em execução" para
   * sempre; marcar como falha é mais honesto do que mostrar um progresso falso.
   */
  recoverInterrupted(): number {
    return this.store.failRunningBackups();
  }

  list(slug: string): BackupRecord[] {
    return this.store.listBackups(this.mustGet(slug).id);
  }

  get(slug: string, id: number): BackupRecord {
    const app = this.mustGet(slug);
    const backup = this.store.getBackup(app.id, id);
    if (!backup) throw new NotFoundError(`Backup ${id} não encontrado.`);
    return backup;
  }

  /** Caminho do ZIP para download, conferindo que ele ainda existe no disco. */
  async downloadPath(
    slug: string,
    id: number,
  ): Promise<{ record: BackupRecord; absolutePath: string; fileName: string }> {
    const record = this.get(slug, id);
    if (record.status !== "success" || !(await pathExists(record.path))) {
      throw new NotFoundError("O arquivo deste backup não está mais no disco.");
    }
    return { record, absolutePath: record.path, fileName: record.fileName };
  }

  /**
   * Registra o backup e gera o ZIP em segundo plano: com muitos dados o
   * processo demora, e prender a requisição até o fim estouraria o tempo de
   * resposta. O andamento aparece na própria listagem (status/message).
   */
  async create(slug: string, includeData: boolean): Promise<BackupRecord> {
    const app = this.mustGet(slug);
    const releasePath = app.activeRelease > 0 ? releaseDir(this.config.dataDir, app.slug, app.activeRelease) : null;
    const dataPath = sharedDir(this.config.dataDir, app.slug);

    const hasCode = releasePath !== null && (await pathExists(releasePath));
    // Um `/data` vazio é criado junto com a aplicação: só conta como conteúdo
    // quando há algum arquivo dentro, senão o ZIP só teria metadados.
    const hasData = includeData && (await this.hasContent(dataPath));
    if (!hasCode && !hasData) {
      throw new ValidationError("Não há nada para copiar: publique um release antes de gerar o backup.");
    }

    const dir = backupsDir(this.config.dataDir, app.slug);
    await ensureDir(dir, 0o750);
    const fileName = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
    const absolutePath = path.join(dir, fileName);

    const id = this.store.insertBackup({
      appId: app.id,
      fileName,
      path: absolutePath,
      releaseSeq: app.activeRelease > 0 ? app.activeRelease : null,
      includeData: hasData,
      createdAt: nowIso(),
    });

    const record = this.store.getBackup(app.id, id);
    if (!record) throw new Error("Não foi possível registrar o backup.");

    this.running.add(id);
    void this.run(app, record, releasePath, dataPath).finally(() => this.running.delete(id));
    return record;
  }

  async remove(slug: string, id: number): Promise<void> {
    const record = this.get(slug, id);
    if (this.running.has(id)) throw new ValidationError("Este backup ainda está sendo gerado.");
    await rmrf(record.path);
    this.store.deleteBackup(record.appId, id);
    this.store.addEvent(record.appId, "info", `Backup ${record.fileName} removido`);
  }

  private async run(
    app: AppRecord,
    record: BackupRecord,
    releasePath: string | null,
    dataPath: string,
  ): Promise<void> {
    try {
      const entries: ZipEntrySource[] = [
        {
          entryName: "backup.json",
          data: Buffer.from(`${JSON.stringify(this.metadata(app, record), null, 2)}\n`, "utf8"),
        },
      ];
      const state = { bytes: 0 };

      if (releasePath) {
        const code = await this.collect(releasePath, "code", state);
        entries.push(...code.entries);
      }
      if (record.includeData) {
        const data = await this.collect(dataPath, "data", state);
        entries.push(...data.entries);
      }

      const result = await writeZip(record.path, entries);
      const stats = await fsp.stat(record.path);
      this.store.finishBackup(
        record.id,
        "success",
        `${result.files} arquivo(s), ${humanBytes(result.bytes)} de conteúdo`,
        stats.size,
      );
      this.store.addEvent(app.id, "info", `Backup ${record.fileName} criado (${humanBytes(stats.size)})`);
    } catch (error) {
      await rmrf(record.path);
      this.store.finishBackup(record.id, "failed", errorMessage(error));
      this.store.addEvent(app.id, "error", `Falha ao gerar o backup: ${errorMessage(error)}`);
    }
  }

  /**
   * Metadados do backup. As variáveis de ambiente vão com os valores: o arquivo
   * é do administrador e serve justamente para reconstruir a aplicação em outro
   * lugar — por isso a interface avisa que o ZIP contém segredos.
   */
  private metadata(app: AppRecord, record: BackupRecord): Record<string, unknown> {
    return {
      format: "botpanel-backup/1",
      createdAt: nowIso(),
      release: record.releaseSeq,
      includeData: record.includeData,
      layout: {
        code: "code/ — arquivos do release ativo",
        data: record.includeData ? "data/ — volume persistente (/data)" : "não incluído",
        note: "node_modules e .botpanel-py não entram no ZIP: o deploy os recria a partir do manifesto.",
      },
      app: {
        slug: app.slug,
        name: app.name,
        description: app.description,
        iconUrl: app.iconUrl,
        runtime: app.runtime,
        image: app.image,
        entry: app.entry,
        depsFile: app.depsFile,
        startCommand: app.startCommand,
        installCommand: app.installCommand,
        memoryMb: app.memoryMb,
        cpu: app.cpu,
        pidsLimit: app.pidsLimit,
        ports: app.ports,
        autoStart: app.autoStart,
        env: app.env,
      },
    };
  }

  /** `true` quando existe pelo menos um arquivo (em qualquer nível) no diretório. */
  private async hasContent(root: string): Promise<boolean> {
    const walk = async (dir: string): Promise<boolean> => {
      let items: Dirent[];
      try {
        items = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const item of items) {
        if (item.isDirectory()) {
          if (EXCLUDED_DIRS.has(item.name)) continue;
          if (await walk(path.join(dir, item.name))) return true;
          continue;
        }
        if (item.isFile()) return true;
      }
      return false;
    };
    return walk(root);
  }

  /** Percorre a árvore juntando arquivos regulares, respeitando o teto de tamanho. */
  private async collect(
    root: string,
    prefix: string,
    state: { bytes: number },
  ): Promise<{ entries: ZipEntrySource[]; files: number }> {
    const entries: ZipEntrySource[] = [];
    let files = 0;

    const walk = async (dir: string, current: string): Promise<void> => {
      let items: Dirent[];
      try {
        items = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          if (EXCLUDED_DIRS.has(item.name)) continue;
          await walk(full, `${current}/${item.name}`);
          continue;
        }
        // Apenas arquivos regulares: um link simbólico poderia trazer dados de
        // fora da aplicação para dentro do backup.
        if (!item.isFile()) continue;

        let size = 0;
        try {
          size = (await fsp.stat(full)).size;
        } catch {
          continue;
        }
        state.bytes += size;
        if (state.bytes > MAX_BACKUP_BYTES) {
          throw new Error(
            `O backup passou de ${humanBytes(MAX_BACKUP_BYTES)}. Gere um backup sem o volume /data ou reduza os arquivos da aplicação.`,
          );
        }
        entries.push({ absolutePath: full, entryName: `${current}/${item.name}` });
        files += 1;
      }
    };

    await walk(root, prefix);
    return { entries, files };
  }

  private mustGet(slug: string): AppRecord {
    const app = this.store.getApp(slug);
    if (!app) throw new NotFoundError(`Aplicação "${slug}" não encontrada.`);
    return app;
  }
}
