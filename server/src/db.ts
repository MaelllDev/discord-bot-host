import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureDir } from "./util/fsx.ts";
import type {
  AiAnalysisRecord,
  AiAnalysisStatus,
  AppRecord,
  BackupRecord,
  BackupStatus,
  DeploymentRecord,
  DeploymentStatus,
  EnvVar,
  ReleaseRecord,
  RuntimeKind,
} from "./types.ts";

interface AppRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon_url: string;
  runtime: string;
  image: string;
  entry: string;
  start_command: string;
  install_command: string;
  deps_file: string;
  memory_mb: number;
  cpu: number;
  pids_limit: number;
  env: string;
  ports: string;
  auto_start: number;
  auto_restart: number;
  active_release: number;
  stopped_by_user: number;
  created_at: string;
  updated_at: string;
}

interface AiAnalysisRow {
  id: number;
  app_id: string;
  slug: string;
  provider: string;
  model: string;
  status: string;
  question: string;
  line_count: number;
  excerpt: string;
  result: string;
  error: string;
  created_at: string;
  finished_at: string | null;
}

interface ReleaseRow {
  id: number;
  app_id: string;
  seq: number;
  dir: string;
  image: string;
  entry: string;
  start_command: string;
  install_command: string;
  notes: string;
  size_bytes: number;
  created_at: string;
}

interface DeploymentRow {
  id: number;
  app_id: string;
  release_seq: number | null;
  kind: string;
  status: string;
  log: string;
  started_at: string;
  finished_at: string | null;
}

interface BackupRow {
  id: number;
  app_id: string;
  file_name: string;
  path: string;
  size_bytes: number;
  status: string;
  message: string;
  release_seq: number | null;
  include_data: number;
  created_at: string;
  finished_at: string | null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

function parseEnv(raw: string): EnvVar[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const candidate = item as { key?: unknown; value?: unknown; secret?: unknown };
      if (typeof candidate.key !== "string") return [];
      return [
        {
          key: candidate.key,
          value: typeof candidate.value === "string" ? candidate.value : String(candidate.value ?? ""),
          secret: candidate.secret === true,
        },
      ];
    });
  } catch {
    return [];
  }
}

function parsePorts(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function toApp(row: AppRow): AppRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    iconUrl: row.icon_url,
    runtime: row.runtime as RuntimeKind,
    image: row.image,
    entry: row.entry,
    startCommand: row.start_command,
    installCommand: row.install_command,
    depsFile: row.deps_file,
    memoryMb: row.memory_mb,
    cpu: row.cpu,
    pidsLimit: row.pids_limit,
    env: parseEnv(row.env),
    ports: parsePorts(row.ports),
    autoStart: row.auto_start === 1,
    autoRestart: row.auto_restart === 1,
    activeRelease: row.active_release,
    stoppedByUser: row.stopped_by_user === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRelease(row: ReleaseRow): ReleaseRecord {
  return {
    id: row.id,
    appId: row.app_id,
    seq: row.seq,
    dir: row.dir,
    image: row.image,
    entry: row.entry,
    startCommand: row.start_command,
    installCommand: row.install_command,
    notes: row.notes,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
}

function toBackup(row: BackupRow): BackupRecord {
  return {
    id: row.id,
    appId: row.app_id,
    fileName: row.file_name,
    path: row.path,
    sizeBytes: row.size_bytes,
    status: row.status as BackupStatus,
    message: row.message,
    releaseSeq: row.release_seq,
    includeData: row.include_data === 1,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function toAiAnalysis(row: AiAnalysisRow): AiAnalysisRecord {
  return {
    id: row.id,
    appId: row.app_id,
    appSlug: row.slug,
    provider: row.provider,
    model: row.model,
    status: row.status as AiAnalysisStatus,
    question: row.question,
    lineCount: row.line_count,
    excerpt: row.excerpt,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function toDeployment(row: DeploymentRow): DeploymentRecord {
  return {
    id: row.id,
    appId: row.app_id,
    releaseSeq: row.release_seq,
    kind: row.kind,
    status: row.status as DeploymentStatus,
    log: row.log,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(path.join(dataDir, "botpanel.db"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  static async open(dataDir: string): Promise<Store> {
    await ensureDir(dataDir, 0o750);
    return new Store(dataDir);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS apps (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        icon_url TEXT NOT NULL DEFAULT '',
        runtime TEXT NOT NULL DEFAULT 'node',
        image TEXT NOT NULL,
        entry TEXT NOT NULL DEFAULT '',
        start_command TEXT NOT NULL DEFAULT '',
        install_command TEXT NOT NULL DEFAULT '',
        deps_file TEXT NOT NULL DEFAULT '',
        memory_mb INTEGER NOT NULL DEFAULT 512,
        cpu REAL NOT NULL DEFAULT 1,
        pids_limit INTEGER NOT NULL DEFAULT 256,
        env TEXT NOT NULL DEFAULT '[]',
        ports TEXT NOT NULL DEFAULT '[]',
        auto_start INTEGER NOT NULL DEFAULT 1,
        auto_restart INTEGER NOT NULL DEFAULT 1,
        active_release INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS releases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        dir TEXT NOT NULL,
        image TEXT NOT NULL,
        entry TEXT NOT NULL DEFAULT '',
        start_command TEXT NOT NULL DEFAULT '',
        install_command TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE (app_id, seq)
      );

      CREATE TABLE IF NOT EXISTS deployments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        release_seq INTEGER,
        kind TEXT NOT NULL DEFAULT 'deploy',
        status TEXT NOT NULL DEFAULT 'running',
        log TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT,
        level TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running',
        message TEXT NOT NULL DEFAULT '',
        release_seq INTEGER,
        include_data INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS ai_analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        question TEXT NOT NULL DEFAULT '',
        line_count INTEGER NOT NULL DEFAULT 0,
        excerpt TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_releases_app ON releases (app_id, seq DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_analyses_app ON ai_analyses (app_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_deployments_app ON deployments (app_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_backups_app ON backups (app_id, id DESC);
    `);

    // Colunas adicionadas depois da primeira versão do schema. `CREATE TABLE IF
    // NOT EXISTS` não altera tabelas existentes, então a inclusão é explícita e
    // idempotente.
    this.addColumnIfMissing("apps", "stopped_by_user", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("apps", "icon_url", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("apps", "auto_restart", "INTEGER NOT NULL DEFAULT 1");
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (columns.some((entry) => entry.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- apps

  listApps(): AppRecord[] {
    const rows = this.db.prepare("SELECT * FROM apps ORDER BY name COLLATE NOCASE").all() as unknown as AppRow[];
    return rows.map(toApp);
  }

  getApp(slug: string): AppRecord | null {
    const row = this.db.prepare("SELECT * FROM apps WHERE slug = ?").get(slug) as unknown as AppRow | undefined;
    return row ? toApp(row) : null;
  }

  getAppById(id: string): AppRecord | null {
    const row = this.db.prepare("SELECT * FROM apps WHERE id = ?").get(id) as unknown as AppRow | undefined;
    return row ? toApp(row) : null;
  }

  slugTaken(slug: string, exceptId?: string): boolean {
    const row = this.db.prepare("SELECT id FROM apps WHERE slug = ?").get(slug) as unknown as
      | { id: string }
      | undefined;
    if (!row) return false;
    return exceptId ? row.id !== exceptId : true;
  }

  insertApp(app: AppRecord): void {
    this.db
      .prepare(
        `INSERT INTO apps (id, slug, name, description, icon_url, runtime, image, entry, start_command, install_command,
          deps_file, memory_mb, cpu, pids_limit, env, ports, auto_start, auto_restart, active_release,
          stopped_by_user, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        app.id,
        app.slug,
        app.name,
        app.description,
        app.iconUrl,
        app.runtime,
        app.image,
        app.entry,
        app.startCommand,
        app.installCommand,
        app.depsFile,
        app.memoryMb,
        app.cpu,
        app.pidsLimit,
        JSON.stringify(app.env),
        JSON.stringify(app.ports),
        app.autoStart ? 1 : 0,
        app.autoRestart ? 1 : 0,
        app.activeRelease,
        app.stoppedByUser ? 1 : 0,
        app.createdAt,
        app.updatedAt,
      );
  }

  updateApp(id: string, patch: Partial<AppRecord>): void {
    const columns: Record<string, string> = {
      name: "name",
      description: "description",
      iconUrl: "icon_url",
      runtime: "runtime",
      image: "image",
      entry: "entry",
      startCommand: "start_command",
      installCommand: "install_command",
      depsFile: "deps_file",
      memoryMb: "memory_mb",
      cpu: "cpu",
      pidsLimit: "pids_limit",
      autoStart: "auto_start",
      autoRestart: "auto_restart",
      stoppedByUser: "stopped_by_user",
    };
    const sets: string[] = [];
    const values: (string | number)[] = [];

    for (const [key, column] of Object.entries(columns)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(typeof value === "boolean" ? (value ? 1 : 0) : (value as string | number));
    }

    if (patch.env !== undefined) {
      sets.push("env = ?");
      values.push(JSON.stringify(patch.env));
    }
    if (patch.ports !== undefined) {
      sets.push("ports = ?");
      values.push(JSON.stringify(patch.ports));
    }
    if (patch.activeRelease !== undefined) {
      sets.push("active_release = ?");
      values.push(patch.activeRelease);
    }

    sets.push("updated_at = ?");
    values.push(nowIso());

    this.db.prepare(`UPDATE apps SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  }

  deleteApp(id: string): void {
    this.db.prepare("DELETE FROM apps WHERE id = ?").run(id);
  }

  // ------------------------------------------------------------ releases

  nextReleaseSeq(appId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM releases WHERE app_id = ?").get(appId) as
      | { max_seq: number }
      | undefined;
    return (row?.max_seq ?? 0) + 1;
  }

  insertRelease(release: Omit<ReleaseRecord, "id">): ReleaseRecord {
    const result = this.db
      .prepare(
        `INSERT INTO releases (app_id, seq, dir, image, entry, start_command, install_command, notes, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        release.appId,
        release.seq,
        release.dir,
        release.image,
        release.entry,
        release.startCommand,
        release.installCommand,
        release.notes,
        release.sizeBytes,
        release.createdAt,
      );
    return { ...release, id: Number(result.lastInsertRowid) };
  }

  listReleases(appId: string): ReleaseRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM releases WHERE app_id = ? ORDER BY seq DESC")
      .all(appId) as unknown as ReleaseRow[];
    return rows.map(toRelease);
  }

  getRelease(appId: string, seq: number): ReleaseRecord | null {
    const row = this.db.prepare("SELECT * FROM releases WHERE app_id = ? AND seq = ?").get(appId, seq) as unknown as
      | ReleaseRow
      | undefined;
    return row ? toRelease(row) : null;
  }

  countReleases(appId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM releases WHERE app_id = ?").get(appId) as
      | { total: number }
      | undefined;
    return row?.total ?? 0;
  }

  deleteRelease(appId: string, seq: number): void {
    this.db.prepare("DELETE FROM releases WHERE app_id = ? AND seq = ?").run(appId, seq);
  }

  // --------------------------------------------------------- deployments

  startDeployment(appId: string, kind: string, releaseSeq: number | null): number {
    const result = this.db
      .prepare("INSERT INTO deployments (app_id, release_seq, kind, status, log, started_at) VALUES (?, ?, ?, 'running', '', ?)")
      .run(appId, releaseSeq, kind, nowIso());
    return Number(result.lastInsertRowid);
  }

  appendDeploymentLog(id: number, chunk: string): void {
    this.db.prepare("UPDATE deployments SET log = log || ? WHERE id = ?").run(chunk, id);
  }

  finishDeployment(id: number, status: DeploymentStatus): void {
    this.db.prepare("UPDATE deployments SET status = ?, finished_at = ? WHERE id = ?").run(status, nowIso(), id);
  }

  getDeployment(id: number): DeploymentRecord | null {
    const row = this.db.prepare("SELECT * FROM deployments WHERE id = ?").get(id) as unknown as
      | DeploymentRow
      | undefined;
    return row ? toDeployment(row) : null;
  }

  listDeployments(appId: string, limit = 20): DeploymentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM deployments WHERE app_id = ? ORDER BY id DESC LIMIT ?")
      .all(appId, limit) as unknown as DeploymentRow[];
    return rows.map(toDeployment);
  }

  // ------------------------------------------------------------- backups

  insertBackup(backup: Omit<BackupRecord, "id" | "status" | "message" | "sizeBytes" | "finishedAt">): number {
    const result = this.db
      .prepare(
        `INSERT INTO backups (app_id, file_name, path, release_seq, include_data, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        backup.appId,
        backup.fileName,
        backup.path,
        backup.releaseSeq,
        backup.includeData ? 1 : 0,
        backup.createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  finishBackup(id: number, status: BackupStatus, message: string, sizeBytes = 0): void {
    this.db
      .prepare("UPDATE backups SET status = ?, message = ?, size_bytes = ?, finished_at = ? WHERE id = ?")
      .run(status, message, sizeBytes, nowIso(), id);
  }

  getBackup(appId: string, id: number): BackupRecord | null {
    const row = this.db.prepare("SELECT * FROM backups WHERE app_id = ? AND id = ?").get(appId, id) as unknown as
      | BackupRow
      | undefined;
    return row ? toBackup(row) : null;
  }

  listBackups(appId: string): BackupRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM backups WHERE app_id = ? ORDER BY id DESC")
      .all(appId) as unknown as BackupRow[];
    return rows.map(toBackup);
  }

  deleteBackup(appId: string, id: number): void {
    this.db.prepare("DELETE FROM backups WHERE app_id = ? AND id = ?").run(appId, id);
  }

  /** Backups que ficaram marcados como "em execução" quando o painel caiu. */
  failRunningBackups(): number {
    const result = this.db
      .prepare("UPDATE backups SET status = 'failed', message = ?, finished_at = ? WHERE status = 'running'")
      .run("Interrompido pelo reinício do painel.", nowIso());
    return Number(result.changes ?? 0);
  }

  // --------------------------------------------------------- análises de IA

  startAiAnalysis(analysis: {
    appId: string;
    slug: string;
    provider: string;
    model: string;
    question: string;
    lineCount: number;
    excerpt: string;
    createdAt: string;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO ai_analyses (app_id, slug, provider, model, status, question, line_count, excerpt, created_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(
        analysis.appId,
        analysis.slug,
        analysis.provider,
        analysis.model,
        analysis.question,
        analysis.lineCount,
        analysis.excerpt,
        analysis.createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  finishAiAnalysis(id: number, status: AiAnalysisStatus, result: string, error: string): void {
    this.db
      .prepare("UPDATE ai_analyses SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?")
      .run(status, result, error, nowIso(), id);
  }

  getAiAnalysis(id: number): AiAnalysisRecord | null {
    const row = this.db.prepare("SELECT * FROM ai_analyses WHERE id = ?").get(id) as unknown as
      | AiAnalysisRow
      | undefined;
    return row ? toAiAnalysis(row) : null;
  }

  listAiAnalyses(appId: string, limit = 20): AiAnalysisRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM ai_analyses WHERE app_id = ? ORDER BY id DESC LIMIT ?")
      .all(appId, limit) as unknown as AiAnalysisRow[];
    return rows.map(toAiAnalysis);
  }

  deleteAiAnalysis(id: number): void {
    this.db.prepare("DELETE FROM ai_analyses WHERE id = ?").run(id);
  }

  /**
   * Análise é dado derivado: se o painel cair no meio, o registro fica "em
   * execução" para sempre. Marcar como falha é mais honesto do que mostrar uma
   * análise que nunca vai terminar.
   */
  failRunningAiAnalyses(): number {
    const result = this.db
      .prepare("UPDATE ai_analyses SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running'")
      .run("Interrompida pelo reinício do painel.", nowIso());
    return Number(result.changes ?? 0);
  }

  // ------------------------------------------------------------ settings

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as unknown as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  // -------------------------------------------------------------- events

  addEvent(appId: string | null, level: string, message: string): void {
    this.db.prepare("INSERT INTO events (app_id, level, message, created_at) VALUES (?, ?, ?, ?)").run(
      appId,
      level,
      message,
      nowIso(),
    );
  }

  listEvents(limit = 100): { id: number; appId: string | null; level: string; message: string; createdAt: string }[] {
    const rows = this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as unknown as {
      id: number;
      app_id: string | null;
      level: string;
      message: string;
      created_at: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      appId: row.app_id,
      level: row.level,
      message: row.message,
      createdAt: row.created_at,
    }));
  }
}
