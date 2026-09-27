import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_HASH_SETTING,
  SESSION_COOKIE,
  createSessionToken,
  hashPassword,
  verifySessionToken,
} from "../auth.ts";
import type { AppContext } from "../context.ts";
import { UnauthorizedError, ValidationError } from "../errors.ts";
import { effectivePanelName } from "./branding.ts";
import { parseInput } from "./validation.ts";

const loginSchema = z.object({ password: z.string().min(1).max(512) });

const resetSchema = z.object({
  token: z.string().trim().min(16).max(512),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(512),
});

export function isAuthenticated(request: FastifyRequest, context: AppContext): boolean {
  const cookies = (request as unknown as { cookies?: Record<string, string | undefined> }).cookies;
  const token = cookies?.[SESSION_COOKIE];
  if (!token) return false;
  return verifySessionToken(token, context.config.sessionSecret, context.session.epoch) !== null;
}

export function registerAuthRoutes(server: FastifyInstance, context: AppContext): void {
  server.post("/api/auth/login", async (request: FastifyRequest, reply: FastifyReply) => {
    const ip = request.ip;
    if (context.throttle.isBlocked(ip)) {
      throw new UnauthorizedError("Muitas tentativas de login. Tente novamente mais tarde.");
    }

    const body = parseInput(loginSchema, request.body);
    if (!context.password.verify(body.password)) {
      context.throttle.registerFailure(ip);
      throw new UnauthorizedError("Senha incorreta.");
    }

    context.throttle.reset(ip);
    const token = createSessionToken(context.config.sessionSecret, context.config.sessionTtlMs, context.session.epoch);
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: context.config.cookieSecure,
      maxAge: Math.floor(context.config.sessionTtlMs / 1000),
    });
    return { authenticated: true };
  });

  server.post("/api/auth/logout", async (request: FastifyRequest, reply: FastifyReply) => {
    // Invalida de verdade: a geração da sessão muda e todo token antigo morre.
    // Só faz isso com uma sessão válida, para que ninguém derrube o admin de fora.
    if (isAuthenticated(request, context)) {
      context.session.epoch = Date.now();
      context.store.setSetting("session_epoch", String(context.session.epoch));
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { authenticated: false };
  });

  server.get("/api/auth/session", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAuthenticated(request, context)) {
      reply.code(401);
      return { authenticated: false };
    }
    return { authenticated: true, panelName: effectivePanelName(context) };
  });

  // Recuperação de senha (pré-autenticação): um token de uso único é gravado em
  // arquivo com permissão 0600 no servidor, e só ele permite definir uma senha
  // nova. A senha em uso nunca é exibida nem registrada — e nada volta pela API.
  server.get("/api/auth/recover", async () => ({ available: context.password.recoveryAvailable }));

  if (context.password.recoveryAvailable) {
    server.post("/api/auth/recover/token", async (request: FastifyRequest, reply: FastifyReply) => {
      const ip = request.ip;
      if (context.recoverThrottle.isBlocked(ip)) {
        reply.code(429);
        return { error: "wait", retryAfterSeconds: context.recoverThrottle.remainingSeconds(ip) };
      }
      context.recoverThrottle.register(ip);
      const { expiresAt } = context.resetTokens.issue();
      // Registro útil para auditoria, sem nenhum segredo: o token em claro só
      // existe no arquivo que o administrador lê pelo servidor.
      request.log.warn(`Token de recuperação de senha gerado a partir de ${ip}.`);
      return {
        ok: true,
        expiresInSeconds: Math.round((expiresAt - Date.now()) / 1000),
        tokenFile: context.resetTokens.tokenFile,
      };
    });

    server.post("/api/auth/recover/reset", async (request: FastifyRequest, reply: FastifyReply) => {
      const ip = request.ip;
      if (context.resetThrottle.isBlocked(ip)) {
        reply.code(429);
        return { error: "wait", retryAfterSeconds: context.resetThrottle.remainingSeconds(ip) };
      }

      const body = parseInput(resetSchema, request.body);
      if (!context.resetTokens.redeem(body.token)) {
        // Uma única resposta para token inválido, expirado ou já usado: de fora
        // não dá para distinguir os casos (evita enumeração).
        context.resetThrottle.registerFailure(ip);
        throw new ValidationError("Token inválido ou expirado. Gere um token novo e tente de novo.");
      }

      context.resetThrottle.reset(ip);
      const hash = hashPassword(body.password);
      context.store.setSetting(PASSWORD_HASH_SETTING, hash);
      context.password.applyReset(hash);
      // Troca de credencial invalida sessões abertas, como no logout.
      context.session.epoch = Date.now();
      context.store.setSetting("session_epoch", String(context.session.epoch));
      request.log.warn(`Senha do painel redefinida com token de recuperação (${ip}).`);
      return { ok: true };
    });
  }

}
