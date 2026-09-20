import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

export interface PanelConfig {
  /** Nome exibido no painel. */
  panelName: string;
  host: string;
  port: number;
  /** Diretório raiz onde ficam o banco, os apps, os releases e o volume persistente. */
  dataDir: string;
  /**
   * Identificador estável desta instância do painel, derivado do `dataDir`.
   * Vai como label nos containers e nas redes, para que uma instância nunca
   * remova recursos criados por outra ao reconciliar (dois painéis podem
   * apontar para o mesmo daemon Docker).
   */
  instanceId: string;
  /** Socket do daemon Docker. */
  dockerSocket: string;
  /** Senha em texto puro (opcional). */
  password: string | null;
  /** Senha com hash scrypt (opcional, tem prioridade sobre `password`). */
  passwordHash: string | null;
  /** Segredo para assinar o cookie de sessão. */
  sessionSecret: string;
  sessionTtlMs: number;
  /** UID/GID usado dentro dos containers e dono dos diretórios dos apps. */
  runUid: number;
  runGid: number;
  /** Tamanho máximo aceito no upload de ZIP. */
  maxUploadBytes: number;
  /** Build do frontend para servir em produção (null em modo dev). */
  publicDir: string | null;
  /** Marca o cookie como Secure (ative quando estiver atrás de HTTPS). */
  cookieSecure: boolean;
  /** Prefixo das imagens de runtime que podem ser usadas. */
  allowedImages: string[] | null;
  /** Quantos releases manter por aplicação (0 = manter todos). */
  keepReleases: number;
}

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on", "sim"].includes(value.toLowerCase());
}

function intFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Deriva o identificador da instância a partir do diretório de dados. */
export function instanceIdForDataDir(dataDir: string): string {
  return createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 12);
}

function resolveSessionSecret(dataDir: string, fromEnv: string | undefined): string {
  if (fromEnv && fromEnv.trim().length >= 16) return fromEnv.trim();
  const secretFile = path.join(dataDir, ".session-secret");
  try {
    const existing = fs.readFileSync(secretFile, "utf8").trim();
    if (existing.length >= 16) return existing;
  } catch {
    // arquivo ainda não existe: geramos abaixo
  }
  const secret = randomBytes(48).toString("base64url");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
  return secret;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PanelConfig {
  const dataDir = path.resolve(env["BOTPANEL_DATA_DIR"] ?? "/var/lib/botpanel");
  const allowedImagesRaw = env["BOTPANEL_ALLOWED_IMAGES"];

  return {
    panelName: env["BOTPANEL_NAME"] ?? "BotPanel",
    host: env["BOTPANEL_HOST"] ?? "0.0.0.0",
    port: intFromEnv(env["BOTPANEL_PORT"], 8080),
    dataDir,
    instanceId: instanceIdForDataDir(dataDir),
    dockerSocket: env["BOTPANEL_DOCKER_SOCKET"] ?? "/var/run/docker.sock",
    password: env["BOTPANEL_PASSWORD"]?.trim() || null,
    passwordHash: env["BOTPANEL_PASSWORD_HASH"]?.trim() || null,
    sessionSecret: resolveSessionSecret(dataDir, env["BOTPANEL_SECRET"]),
    sessionTtlMs: intFromEnv(env["BOTPANEL_SESSION_TTL_HOURS"], 24 * 7) * 3_600_000,
    runUid: intFromEnv(env["BOTPANEL_RUN_UID"], 1000),
    runGid: intFromEnv(env["BOTPANEL_RUN_GID"], 1000),
    maxUploadBytes: intFromEnv(env["BOTPANEL_MAX_UPLOAD_MB"], 512) * 1024 * 1024,
    publicDir: env["BOTPANEL_DISABLE_STATIC"] === "1" ? null : fileURLToPath(new URL("../../web/dist", import.meta.url)),
    cookieSecure: boolFromEnv(env["BOTPANEL_COOKIE_SECURE"], false),
    allowedImages:
      allowedImagesRaw && allowedImagesRaw.trim().length > 0
        ? allowedImagesRaw.split(",").map((item) => item.trim()).filter(Boolean)
        : null,
    keepReleases: intFromEnv(env["BOTPANEL_KEEP_RELEASES"], 10),
  };
}
