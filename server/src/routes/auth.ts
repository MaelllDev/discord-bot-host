import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { SESSION_COOKIE, createSessionToken, verifySessionToken } from "../auth.ts";
import type { AppContext } from "../context.ts";
import { UnauthorizedError } from "../errors.ts";
import { parseInput } from "./validation.ts";

const loginSchema = z.object({ password: z.string().min(1).max(512) });

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
    return { authenticated: true, panelName: context.config.panelName };
  });

}
