import { tActive } from "./i18n/language.ts";
import type {
  ActivityEvent,
  AiAnalysis,
  AiModelListing,
  AiProviderInfo,
  AiSettings,
  AiTestResult,
  AppSummary,
  BackupRecord,
  CommandsPreview,
  DeploymentRecord,
  DiskUsageEntry,
  EnvVar,
  FileContent,
  FileListing,
  ReleaseRecord,
  SystemInfo,
  UploadResult,
} from "./types.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly details: unknown;
  /** Código estável do erro (`image.notAllowed`, `slug.taken`, …), se houver. */
  readonly code?: string;

  constructor(message: string, status: number, details?: unknown, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * Registra o que fazer quando a API responde 401 (sessão expirada). O App usa
 * isso para voltar à tela de login sem que cada componente trate o caso.
 */
export function onUnauthorized(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

/**
 * Rotas que respondem 401 como parte do fluxo normal: `/api/auth/session`
 * (checagem inicial) e `/api/auth/login` (senha errada) não podem disparar o
 * aviso de "sessão expirada".
 */
const EXPECTED_401 = ["/api/auth/session", "/api/auth/login"];

function notifyUnauthorized(path: string): void {
  if (EXPECTED_401.some((route) => path.startsWith(route))) return;
  unauthorizedHandler?.();
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  raw?: BodyInit;
  headers?: Record<string, string>;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? "GET",
    credentials: "same-origin",
  };

  if (options.raw !== undefined) {
    init.body = options.raw;
    if (options.headers) init.headers = options.headers;
  } else if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers = { "content-type": "application/json" };
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (caught) {
    throw new ApiError(tActive("api.unreachable"), 0, caught);
  }

  if (!response.ok) {
    let message = tActive("api.errorStatus", { status: response.status });
    let details: unknown;
    let code: string | undefined;
    try {
      const payload = (await response.json()) as { error?: string; details?: unknown; code?: string };
      if (payload.error) message = payload.error;
      details = payload.details;
      code = payload.code;
    } catch {
      // resposta sem JSON
    }
    if (response.status === 401) {
      message = "Sessão expirada. Entre novamente.";
      notifyUnauthorized(path);
    }
    throw new ApiError(message, response.status, details, code);
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}

export interface AppConfigPayload {
  name?: string;
  description?: string;
  iconUrl?: string;
  runtime?: AppSummary["runtime"];
  image?: string;
  entry?: string;
  startCommand?: string;
  installCommand?: string;
  depsFile?: string;
  memoryMb?: number;
  cpu?: number;
  pidsLimit?: number;
  env?: EnvVar[];
  ports?: string[];
  autoStart?: boolean;
  autoRestart?: boolean;
  slug?: string;
}

/** Campos do formulário de IA enviados para testar/listar antes de salvar. */
export interface AiDraft {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface UploadProgress {
  loadedBytes: number;
  totalBytes: number;
  percent: number;
}

/**
 * Upload do ZIP com progresso real. `fetch` não expõe progresso de envio, então
 * este único caso usa XMLHttpRequest.
 */
export function uploadZipWithProgress(
  file: File,
  onProgress: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads");
    xhr.withCredentials = true;
    xhr.responseType = "text";

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress({
        loadedBytes: event.loaded,
        totalBytes: event.total,
        percent: event.total > 0 ? Math.round((event.loaded / event.total) * 100) : 0,
      });
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadResult);
        } catch {
          reject(new ApiError(tActive("api.badUploadResponse"), xhr.status));
        }
        return;
      }
      let message = `Erro ${xhr.status}`;
      try {
        const payload = JSON.parse(xhr.responseText) as { error?: string };
        if (payload.error) message = payload.error;
      } catch {
        // sem JSON
      }
      if (xhr.status === 401) notifyUnauthorized("/api/uploads");
      reject(new ApiError(message, xhr.status));
    };

    xhr.onerror = () => reject(new ApiError("Falha de rede durante o upload do pacote.", 0));
    xhr.onabort = () => reject(new ApiError("Upload cancelado.", 0));

    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

export const api = {
  session: () => request<{ authenticated: boolean; panelName?: string }>("/api/auth/session"),
  login: (password: string) => request<{ authenticated: boolean }>("/api/auth/login", { method: "POST", body: { password } }),
  logout: () => request<{ authenticated: boolean }>("/api/auth/logout", { method: "POST" }),

  system: () => request<SystemInfo>("/api/system"),
  events: (limit = 30) => request<{ events: ActivityEvent[] }>(`/api/events?limit=${limit}`),
  usage: () => request<{ usage: DiskUsageEntry[] }>("/api/usage"),

  apps: () => request<{ apps: AppSummary[] }>("/api/apps"),
  app: (slug: string) => request<{ app: AppSummary }>(`/api/apps/${encodeURIComponent(slug)}`),
  createApp: (payload: AppConfigPayload) => request<{ app: AppSummary }>("/api/apps", { method: "POST", body: payload }),
  updateApp: (slug: string, payload: AppConfigPayload) =>
    request<{ app: AppSummary }>(`/api/apps/${encodeURIComponent(slug)}`, { method: "PATCH", body: payload }),
  removeApp: (slug: string, deleteFiles: boolean) =>
    request<{ ok: boolean }>(`/api/apps/${encodeURIComponent(slug)}?deleteFiles=${deleteFiles}`, { method: "DELETE" }),
  action: (slug: string, action: "start" | "stop" | "restart") =>
    request<{ app: AppSummary }>(`/api/apps/${encodeURIComponent(slug)}/actions/${action}`, { method: "POST" }),
  commands: (slug: string) => request<{ commands: CommandsPreview }>(`/api/apps/${encodeURIComponent(slug)}/commands`),
  logs: (slug: string, tail = 400) =>
    request<{ logs: string }>(`/api/apps/${encodeURIComponent(slug)}/logs?tail=${tail}`),

  releases: (slug: string) =>
    request<{ activeRelease: number; releases: ReleaseRecord[] }>(`/api/apps/${encodeURIComponent(slug)}/releases`),
  activateRelease: (slug: string, seq: number) =>
    request<{ app: AppSummary }>(`/api/apps/${encodeURIComponent(slug)}/releases/${seq}/activate`, { method: "POST" }),
  deleteRelease: (slug: string, seq: number) =>
    request<{ ok: boolean }>(`/api/apps/${encodeURIComponent(slug)}/releases/${seq}`, { method: "DELETE" }),

  backups: (slug: string) =>
    request<{ backups: BackupRecord[] }>(`/api/apps/${encodeURIComponent(slug)}/backups`),
  createBackup: (slug: string, includeData: boolean) =>
    request<{ backup: BackupRecord }>(`/api/apps/${encodeURIComponent(slug)}/backups`, {
      method: "POST",
      body: { includeData },
    }),
  deleteBackup: (slug: string, id: number) =>
    request<{ ok: boolean }>(`/api/apps/${encodeURIComponent(slug)}/backups/${id}`, { method: "DELETE" }),
  backupDownloadUrl: (slug: string, id: number) =>
    `/api/apps/${encodeURIComponent(slug)}/backups/${id}/download`,

  aiSettings: () => request<{ settings: AiSettings; providers: AiProviderInfo[] }>("/api/ai/settings"),
  saveAiSettings: (payload: {
    enabled?: boolean;
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    maxLines?: number;
    temperature?: number;
    clearApiKey?: boolean;
  }) => request<{ settings: AiSettings }>("/api/ai/settings", { method: "PUT", body: payload }),
  /**
   * Lista e teste aceitam os campos do formulário: sem isso, o botão usava a
   * configuração salva e parecia não funcionar antes de salvar.
   */
  aiModels: (draft: AiDraft = {}) =>
    request<{ models: AiModelListing }>("/api/ai/models", { method: "POST", body: draft }),
  testAi: (draft: AiDraft = {}) =>
    request<{ result: AiTestResult }>("/api/ai/test", { method: "POST", body: draft }),
  aiAnalyze: (slug: string, logs: string, question: string) =>
    request<{ analysis: AiAnalysis }>(`/api/apps/${encodeURIComponent(slug)}/ai/analyze`, {
      method: "POST",
      body: { logs, question },
    }),
  aiAnalyses: (slug: string) =>
    request<{ analyses: AiAnalysis[] }>(`/api/apps/${encodeURIComponent(slug)}/ai/analyses`),
  aiAnalysis: (id: number) => request<{ analysis: AiAnalysis }>(`/api/ai/analyses/${id}`),
  deleteAiAnalysis: (id: number) => request<{ ok: boolean }>(`/api/ai/analyses/${id}`, { method: "DELETE" }),

  deployments: (slug: string) =>
    request<{ deployments: DeploymentRecord[] }>(`/api/apps/${encodeURIComponent(slug)}/deployments`),
  deployment: (slug: string, id: number) =>
    request<{ deployment: DeploymentRecord }>(`/api/apps/${encodeURIComponent(slug)}/deployments/${id}`),
  deploy: (slug: string, uploadId: string, notes = "") =>
    request<{ deploymentId: number; releaseSeq: number }>(`/api/apps/${encodeURIComponent(slug)}/deploy`, {
      method: "POST",
      body: { uploadId, notes },
    }),

  uploadZip: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<UploadResult>("/api/uploads", { method: "POST", raw: form });
  },
  uploadZipWithProgress,
  discardUpload: (id: string) => request<{ ok: boolean }>(`/api/uploads/${id}`, { method: "DELETE" }),

  branding: () => request<{ branding: { name: string; iconUrl: string } }>("/api/branding"),
  saveBranding: (payload: { name?: string; iconUrl?: string }) =>
    request<{ branding: { name: string; iconUrl: string } }>("/api/branding", { method: "PUT", body: payload }),

  webhooks: () =>
    request<{
      webhooks: {
        id: string;
        name: string;
        urlMasked: string;
        events: string[];
        enabled: boolean;
        username?: string;
        avatarUrl?: string;
        messages?: Record<string, string>;
        lastResult: { at: string; ok: boolean; error?: string } | null;
      }[];
      kinds: string[];
    }>("/api/notify/webhooks"),
  saveWebhooks: (
    webhooks: {
      id: string;
      name: string;
      url?: string;
      events: string[];
      enabled: boolean;
      username?: string;
      avatarUrl?: string;
      messages?: Record<string, string>;
    }[],
  ) =>
    request<{ ok: boolean }>("/api/notify/webhooks", { method: "PUT", body: { webhooks } }),
  testWebhook: (url: string, extra?: { username?: string; avatarUrl?: string; message?: string }) =>
    request<{ ok: boolean }>("/api/notify/test", { method: "POST", body: { url, ...extra } }),
  /** Envia a imagem já recortada e devolve a URL servida por /uploads/images. */
  uploadImage: (blob: Blob, fileName: string, onProgress?: (fraction: number) => void) => {
    const form = new FormData();
    form.append("file", blob, fileName);
    if (!onProgress) return request<{ image: { id: string; url: string } }>("/api/images", { method: "POST", raw: form });
    return new Promise<{ image: { id: string; url: string } }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/images");
      xhr.withCredentials = true;
      xhr.responseType = "text";
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.total > 0 ? event.loaded / event.total : 0);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as { image: { id: string; url: string } });
          } catch {
            reject(new ApiError(tActive("api.badUploadResponse"), xhr.status));
          }
          return;
        }
        let message = `Erro ${xhr.status}`;
        try {
          const payload = JSON.parse(xhr.responseText) as { error?: string };
          if (payload.error) message = payload.error;
        } catch {
          // sem JSON
        }
        if (xhr.status === 401) notifyUnauthorized("/api/images");
        reject(new ApiError(message, xhr.status));
      };
      xhr.onerror = () => reject(new ApiError(tActive("api.unreachable"), 0));
      xhr.send(form);
    });
  },

  files: (slug: string, root: "code" | "data", path = "") =>
    request<FileListing>(`/api/apps/${encodeURIComponent(slug)}/files?root=${root}&path=${encodeURIComponent(path)}`),
  readFile: (slug: string, root: "code" | "data", path: string) =>
    request<FileContent>(`/api/apps/${encodeURIComponent(slug)}/files/content?root=${root}&path=${encodeURIComponent(path)}`),
  writeFile: (slug: string, root: "code" | "data", path: string, content: string) =>
    request<{ ok: boolean }>(`/api/apps/${encodeURIComponent(slug)}/files/content`, {
      method: "PUT",
      body: { root, path, content },
    }),
  mkdir: (slug: string, root: "code" | "data", path: string) =>
    request<{ ok: boolean }>(`/api/apps/${encodeURIComponent(slug)}/files/mkdir`, { method: "POST", body: { root, path } }),
  renameFile: (slug: string, root: "code" | "data", from: string, to: string) =>
    request<{ ok: boolean }>(`/api/apps/${encodeURIComponent(slug)}/files/rename`, {
      method: "POST",
      body: { root, from, to },
    }),
  removeFile: (slug: string, root: "code" | "data", path: string) =>
    request<{ ok: boolean }>(`/api/apps/${encodeURIComponent(slug)}/files`, { method: "DELETE", body: { root, path } }),
  uploadFiles: (slug: string, root: "code" | "data", path: string, files: File[]) => {
    const form = new FormData();
    form.append("root", root);
    form.append("path", path);
    for (const file of files) form.append("files", file, file.name);
    return request<{ ok: boolean; files: number }>(`/api/apps/${encodeURIComponent(slug)}/files/upload`, {
      method: "POST",
      raw: form,
    });
  },
  downloadUrl: (slug: string, root: "code" | "data", path: string) =>
    `/api/apps/${encodeURIComponent(slug)}/files/download?root=${root}&path=${encodeURIComponent(path)}`,
};
