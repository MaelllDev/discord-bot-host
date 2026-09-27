import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PanelConfig } from "./config.ts";

export const SESSION_COOKIE = "botpanel_session";

export interface SessionPayload {
  sub: "admin";
  iat: number;
  exp: number;
  tokenId: string;
  /** Geração da sessão: um logout invalida imediatamente todos os tokens antigos. */
  epoch: number;
}

/** Gera o hash scrypt de uma senha no formato `scrypt$salt$hash`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

/** Compara uma senha com o hash armazenado usando comparação de tempo constante. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, expected] = parts;
  if (!salt || !expected) return false;
  try {
    const derived = scryptSync(password, salt, 64);
    const expectedBuffer = Buffer.from(expected, "hex");
    if (expectedBuffer.length !== derived.length) return false;
    return timingSafeEqual(derived, expectedBuffer);
  } catch {
    return false;
  }
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function createSessionToken(secret: string, ttlMs: number, epoch: number): string {
  const now = Date.now();
  const payload: SessionPayload = {
    sub: "admin",
    iat: now,
    exp: now + ttlMs,
    tokenId: randomUUID(),
    epoch,
  };
  const encoded = base64Url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifySessionToken(token: string, secret: string, expectedEpoch: number): SessionPayload | null {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const expected = sign(encoded, secret);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(providedBuffer, expectedBuffer)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    if (payload.sub !== "admin") return null;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    if (payload.epoch !== expectedEpoch) return null;
    return payload;
  } catch {
    return null;
  }
}

/** De onde vem a senha em uso no painel. */
export type PasswordOrigin = "env-hash" | "env" | "stored" | "generated";

export interface PasswordSource {
  origin: PasswordOrigin;
  /** Senha gerada no primeiro boot, enquanto ela é a credencial em uso. */
  generated: string | null;
  /** Valida a senha informada no login. */
  verify: (password: string) => boolean;
  /**
   * true quando o painel controla a senha (nenhuma variável de ambiente
   * configurada) e portanto pode redefini-la por token de uso único. Com
   * `BOTPANEL_PASSWORD`/`BOTPANEL_PASSWORD_HASH` quem define a senha é o
   * serviço, e o painel não tem canal seguro para provar quem é o dono da VPS.
   */
  recoveryAvailable: boolean;
  /** Passa a validar o hash scrypt de uma senha nova, sem reiniciar o painel. */
  applyReset: (hash: string) => void;
}

/** Onde fica o hash de uma senha redefinida pelo painel (sobrevive a restarts). */
export const PASSWORD_HASH_SETTING = "panel_password_hash";
/** Tamanho mínimo aceito ao redefinir a senha. */
export const MIN_PASSWORD_LENGTH = 8;

/** Compara duas strings por digest de tamanho fixo — não vaza o comprimento. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/**
 * Resolve a origem da senha do painel:
 * 1. `BOTPANEL_PASSWORD_HASH` (scrypt) tem prioridade;
 * 2. `BOTPANEL_PASSWORD` em texto puro;
 * 3. hash de uma senha redefinida pelo painel (guardado no banco);
 * 4. senha aleatória gerada e guardada em `<dataDir>/.initial-password`.
 *
 * A senha nunca é escrita em log: quem precisa conhecê-la lê o arquivo com
 * permissão 0600, no servidor.
 */
export function resolvePasswordSource(config: PanelConfig, storedHash: string | null = null): PasswordSource {
  if (config.passwordHash) {
    return {
      origin: "env-hash",
      generated: null,
      recoveryAvailable: false,
      verify: (password) => verifyPassword(password, config.passwordHash as string),
      applyReset: () => undefined,
    };
  }
  if (config.password) {
    const expected = config.password;
    return {
      origin: "env",
      generated: null,
      recoveryAvailable: false,
      verify: (password) => constantTimeEquals(password, expected),
      applyReset: () => undefined,
    };
  }

  const file = path.join(config.dataDir, ".initial-password");
  let currentHash: string | null = storedHash;
  let generated: string | null = null;

  if (!currentHash) {
    try {
      generated = fs.readFileSync(file, "utf8").trim() || null;
    } catch {
      generated = null;
    }
    if (!generated) {
      generated = randomBytes(12).toString("base64url");
      fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, `${generated}\n`, { mode: 0o600 });
    }
  }
  return {
    origin: currentHash ? "stored" : "generated",
    generated,
    recoveryAvailable: true,
    verify: (password) => {
      if (currentHash) return verifyPassword(password, currentHash);
      return generated !== null && constantTimeEquals(password, generated);
    },
    applyReset: (hash: string) => {
      currentHash = hash;
      // A senha inicial deixa de valer: sem isso ela continuaria entrando.
      generated = null;
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Sem permissão para remover: a senha nova já venceu a antiga.
      }
    },
  };
}

/**
 * Janela mínima entre dois pedidos de token de recuperação por IP. O token é
 * de uso único; este intervalo evita que um chamador anônimo gere tokens em
 * sequência e invalide o que o administrador acabou de ler.
 */
export const RECOVER_COOLDOWN_MS = 10 * 60 * 1000;

/** Controla o intervalo entre pedidos de recuperação de senha por IP. */
export class PasswordResetService {
  /** Nome do arquivo onde o token é gravado no diretório de dados. */
  static readonly FILE_NAME = "reset-token";

  private pending: { hash: Buffer; expiresAt: number } | null = null;
  private readonly dataDir: string;
  private readonly file: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, PasswordResetService.FILE_NAME);
  }

  /** Caminho do arquivo do token (só quem tem acesso ao servidor consegue lê-lo). */
  get tokenFile(): string {
    return this.file;
  }

  /**
   * Gera um token novo — invalidando o anterior — e grava apenas o token no
   * arquivo com permissão 0600. A senha atual nunca é tocada.
   */
  issue(now = Date.now()): { expiresAt: number } {
    const token = randomBytes(32).toString("base64url");
    this.pending = { hash: hashToken(token), expiresAt: now + RESET_TOKEN_TTL_MS };
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, `${token}\n`, { mode: 0o600 });
    return { expiresAt: this.pending.expiresAt };
  }

  /**
   * Consome o token. Uso único: qualquer tentativa (certa ou errada, dentro ou
   * fora do prazo) descarta o token pendente e apaga o arquivo.
   */
  redeem(token: string, now = Date.now()): boolean {
    const pending = this.pending;
    this.pending = null;
    this.clearFile();
    if (!pending) return false;
    if (pending.expiresAt <= now) return false;
    const provided = hashToken(token);
    return provided.length === pending.hash.length && timingSafeEqual(provided, pending.hash);
  }

  /** Remove um token pendente de um boot anterior (a memória não sobrevive). */
  clearStale(): void {
    this.pending = null;
    this.clearFile();
  }

  private clearFile(): void {
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      // Arquivo já ausente ou sem permissão: nada a fazer.
    }
  }
}

/** Hash do token guardado em memória: o valor em claro só existe no arquivo. */
function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** Validade de um token de recuperação. */
export const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

export class RecoverThrottle {
  private readonly last = new Map<string, number>();

  /** true quando o IP ainda está dentro da janela de espera. */
  isBlocked(ip: string, now = Date.now()): boolean {
    const previous = this.last.get(ip);
    return previous !== undefined && now - previous < RECOVER_COOLDOWN_MS;
  }

  /** Quanto falta (em segundos) para o IP poder pedir de novo. */
  remainingSeconds(ip: string, now = Date.now()): number {
    const previous = this.last.get(ip);
    if (previous === undefined) return 0;
    return Math.max(0, Math.ceil((previous + RECOVER_COOLDOWN_MS - now) / 1000));
  }

  register(ip: string, now = Date.now()): void {
    this.last.set(ip, now);
    // O mapa cresce um registro por IP que pediu; uma limpeza simples mantém
    // o custo de memória limitado em instalações expostas à internet.
    if (this.last.size > 1000) {
      const cutoff = now - RECOVER_COOLDOWN_MS;
      for (const [key, moment] of this.last) {
        if (moment <= cutoff) this.last.delete(key);
      }
    }
  }
}

/**
 * Limita tentativas de login por IP para dificultar força bruta.
 */
export class LoginThrottle {
  private readonly attempts = new Map<string, { failures: number; blockedUntil: number }>();
  private readonly maxFailures: number;
  private readonly windowMs: number;

  constructor(maxFailures = 8, windowMs = 15 * 60 * 1000) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
  }

  isBlocked(ip: string): boolean {
    const record = this.attempts.get(ip);
    if (!record) return false;
    if (record.blockedUntil > Date.now()) return true;
    if (record.blockedUntil !== 0 && record.blockedUntil <= Date.now()) this.attempts.delete(ip);
    return false;
  }

  registerFailure(ip: string): void {
    const record = this.attempts.get(ip) ?? { failures: 0, blockedUntil: 0 };
    record.failures += 1;
    if (record.failures >= this.maxFailures) {
      record.blockedUntil = Date.now() + this.windowMs;
      record.failures = 0;
    }
    this.attempts.set(ip, record);
  }

  reset(ip: string): void {
    this.attempts.delete(ip);
  }

  /** Segundos restantes do bloqueio atual (0 quando não há bloqueio). */
  remainingSeconds(ip: string, now = Date.now()): number {
    const record = this.attempts.get(ip);
    if (!record || record.blockedUntil <= now) return 0;
    return Math.ceil((record.blockedUntil - now) / 1000);
  }
}
