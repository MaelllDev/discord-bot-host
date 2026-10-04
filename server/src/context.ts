import type { PanelConfig } from "./config.ts";
import type { Store } from "./db.ts";
import type { DockerService } from "./docker/service.ts";
import type { AppService } from "./apps/service.ts";
import type { FileService } from "./apps/files.ts";
import type { UploadStore } from "./apps/uploads.ts";
import type { ImageStore } from "./apps/images.ts";
import type { BackupService } from "./apps/backups.ts";
import type { MetricsService } from "./apps/metrics.ts";
import type { RestoreService } from "./apps/restore.ts";
import type { UrlFetchService } from "./apps/fetchurl.ts";
import type { AiService } from "./ai/service.ts";
import type { CloudflareService } from "./cloudflare/service.ts";
import type { NotifyService } from "./notify/webhooks.ts";
import type { LoginThrottle, PasswordResetService, PasswordSource, RecoverThrottle } from "./auth.ts";

export interface AppContext {
  config: PanelConfig;
  store: Store;
  docker: DockerService;
  apps: AppService;
  backups: BackupService;
  ai: AiService;
  files: FileService;
  uploads: UploadStore;
  images: ImageStore;
  notify: NotifyService;
  /** Integração do painel com o Cloudflare Tunnel (container `cloudflared`). */
  cloudflare: CloudflareService;
  metrics: MetricsService;
  restore: RestoreService;
  urlFetch: UrlFetchService;
  password: PasswordSource;
  throttle: LoginThrottle;
  /** Janela mínima entre pedidos de token de recuperação por IP. */
  recoverThrottle: RecoverThrottle;
  /** Tokens de recuperação de senha (uso único, guardados em arquivo 0600). */
  resetTokens: PasswordResetService;
  /** Limite de tentativas de redefinição de senha por IP. */
  resetThrottle: LoginThrottle;
  /** Geração atual das sessões (incrementada a cada logout). */
  session: { epoch: number };
  startedAt: number;
}
