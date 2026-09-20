import type { PanelConfig } from "./config.ts";
import type { Store } from "./db.ts";
import type { DockerService } from "./docker/service.ts";
import type { AppService } from "./apps/service.ts";
import type { FileService } from "./apps/files.ts";
import type { UploadStore } from "./apps/uploads.ts";
import type { BackupService } from "./apps/backups.ts";
import type { AiService } from "./ai/service.ts";
import type { LoginThrottle, PasswordSource } from "./auth.ts";

export interface AppContext {
  config: PanelConfig;
  store: Store;
  docker: DockerService;
  apps: AppService;
  backups: BackupService;
  ai: AiService;
  files: FileService;
  uploads: UploadStore;
  password: PasswordSource;
  throttle: LoginThrottle;
  /** Geração atual das sessões (incrementada a cada logout). */
  session: { epoch: number };
  startedAt: number;
}
