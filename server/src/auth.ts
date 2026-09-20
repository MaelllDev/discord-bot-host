import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
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

export interface PasswordSource {
  /** Senha gerada automaticamente no primeiro boot (mostrada no log uma vez). */
  generated: string | null;
  /** Valida a senha informada no login. */
  verify: (password: string) => boolean;
}

/**
 * Resolve a origem da senha do painel:
 * 1. `BOTPANEL_PASSWORD_HASH` (scrypt) tem prioridade;
 * 2. `BOTPANEL_PASSWORD` em texto puro;
 * 3. senha aleatória gerada e guardada em `<dataDir>/.initial-password`.
 */
export function resolvePasswordSource(config: PanelConfig): PasswordSource {
  if (config.passwordHash) {
    return { generated: null, verify: (password) => verifyPassword(password, config.passwordHash as string) };
  }
  if (config.password) {
    const expected = Buffer.from(config.password);
    return {
      generated: null,
      verify: (password) => {
        const provided = Buffer.from(password);
        if (provided.length !== expected.length) return false;
        return timingSafeEqual(provided, expected);
      },
    };
  }

  const file = path.join(config.dataDir, ".initial-password");
  let password: string | null = null;
  try {
    password = fs.readFileSync(file, "utf8").trim() || null;
  } catch {
    password = null;
  }
  if (!password) {
    password = randomBytes(12).toString("base64url");
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${password}\n`, { mode: 0o600 });
  }
  const stored = password;
  return { generated: stored, verify: (candidate) => candidate === stored };
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
}
