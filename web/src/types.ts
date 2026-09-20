export type RuntimeKind = "node" | "python" | "custom";

export type AppStatus =
  | "running"
  | "starting"
  | "restarting"
  | "paused"
  | "stopped"
  | "crashed"
  | "deploying"
  | "unknown";

export interface EnvVar {
  key: string;
  value: string;
  secret: boolean;
}

export interface ContainerResources {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  pids: number;
  uptimeSeconds: number;
  startedAt: string | null;
  exitCode: number | null;
  status: AppStatus;
}

export interface AppSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** URL (http/https) do ícone da aplicação; vazia usa o ícone padrão. */
  iconUrl: string;
  runtime: RuntimeKind;
  image: string;
  entry: string;
  startCommand: string;
  installCommand: string;
  depsFile: string;
  memoryMb: number;
  cpu: number;
  pidsLimit: number;
  env: EnvVar[];
  ports: string[];
  /** Sobe sozinha quando a VPS (e o painel) reinicia. */
  autoStart: boolean;
  /** Reinicia sozinha quando o processo termina com erro. */
  autoRestart: boolean;
  activeRelease: number;
  createdAt: string;
  updatedAt: string;
  status: AppStatus;
  resources: ContainerResources | null;
  releaseCount: number;
  diskBytes: number;
}

export interface ReleaseRecord {
  id: number;
  appId: string;
  seq: number;
  dir: string;
  image: string;
  entry: string;
  startCommand: string;
  installCommand: string;
  notes: string;
  sizeBytes: number;
  createdAt: string;
}

export interface DeploymentRecord {
  id: number;
  appId: string;
  releaseSeq: number | null;
  kind: string;
  status: "running" | "success" | "failed";
  log: string;
  startedAt: string;
  finishedAt: string | null;
}

export type BackupStatus = "running" | "success" | "failed";

export interface BackupRecord {
  id: number;
  appId: string;
  fileName: string;
  path: string;
  sizeBytes: number;
  status: BackupStatus;
  message: string;
  releaseSeq: number | null;
  includeData: boolean;
  createdAt: string;
  finishedAt: string | null;
}

export interface SystemInfo {
  panelName: string;
  dataDir: string;
  panel: {
    version: string | null;
    nodeVersion: string;
    startedAt: string;
    uptimeSeconds: number;
  };
  host: {
    platform: string;
    release: string;
    arch: string;
    cpuModel: string | null;
    cpuCount: number;
    loadAverage: [number, number, number];
    memoryTotalBytes: number;
    memoryFreeBytes: number;
    disk: { path: string; totalBytes: number; freeBytes: number; usedBytes: number } | null;
  };
  config: {
    host: string;
    port: number;
    dockerSocket: string;
    allowedImages: string[] | null;
    keepReleases: number;
    sessionTtlHours: number;
    cookieSecure: boolean;
    maxUploadMb: number;
    runUid: number;
    runGid: number;
    instanceId: string;
  };
  docker: {
    available: boolean;
    version: string | null;
    apiVersion: string | null;
    /** `null` = daemon inacessível (o valor real é desconhecido). */
    containers: number | null;
  };
  apps: { total: number; running: number | null };
  images: string[];
}

export interface DiskUsageEntry {
  slug: string;
  bytes: number;
}

export interface ActivityEvent {
  id: number;
  appId: string | null;
  level: string;
  message: string;
  createdAt: string;
}

export interface ProjectDetection {
  runtime: RuntimeKind;
  entry: string;
  depsFile: string;
  installCommand: string;
  startCommand: string;
  presentFiles: string[];
  notes: string[];
}

export interface UploadResult {
  upload: { id: string; fileName: string; sizeBytes: number; fileCount: number };
  detection: ProjectDetection;
}

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  sizeBytes: number;
  modifiedAt: string | null;
  executable: boolean;
}

export interface FileListing {
  root: "code" | "data";
  path: string;
  entries: FileEntry[];
}

export interface FileContent {
  root: "code" | "data";
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
  binary: boolean;
}

export interface CommandsPreview {
  startCommand: string | null;
  installCommand: string | null;
  error: string | null;
}

export interface AiProviderInfo {
  id: string;
  label: string;
  keysUrl: string;
  docsUrl: string;
  keyLabel: string;
  requiresKey: boolean;
  customBaseUrl: boolean;
  defaultBaseUrl: string;
  defaultModel: string;
  models: { id: string; label: string }[];
}

/** A chave de API nunca é devolvida: só se existe e uma dica mascarada. */
export interface AiSettings {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  maxLines: number;
  temperature: number;
  apiKeySet: boolean;
  apiKeyHint: string;
}

export interface AiModelListing {
  models: string[];
  source: "provider" | "builtin";
  error: string | null;
}

export interface AiTestResult {
  ok: boolean;
  message: string;
  provider: string;
  model: string;
  latencyMs: number;
}

export type AiAnalysisStatus = "running" | "success" | "failed";

export interface AiAnalysis {
  id: number;
  appId: string;
  appSlug: string;
  provider: string;
  model: string;
  status: AiAnalysisStatus;
  question: string;
  lineCount: number;
  /** Trecho redigido que foi enviado ao provedor. */
  excerpt: string;
  result: string;
  error: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface StreamLine {
  id: number;
  stream: "stdout" | "stderr" | "system";
  line: string;
}
