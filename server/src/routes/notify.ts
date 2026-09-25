import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { ValidationError } from "../errors.ts";
import { parseInput } from "./validation.ts";
import { DISCORD_WEBHOOK_PATTERN, NOTIFY_KINDS } from "../notify/webhooks.ts";
import { z } from "zod";

const webhookSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(48),
  url: z.string().trim().regex(DISCORD_WEBHOOK_PATTERN, "URL de webhook do Discord inválida.").optional(),
  events: z.array(z.enum(["started", "stopped", "restarted", "crashed"])).max(NOTIFY_KINDS.length),
  enabled: z.boolean(),
  /** Identidade da mensagem no Discord (opcional). */
  username: z.string().trim().max(80).optional(),
  avatarUrl: z.string().trim().max(500).optional(),
  /** Texto por evento; placeholders {app}, {slug} e {code}. */
  messages: z.record(z.string().max(40), z.string().max(1000)).optional(),
});

const saveSchema = z.object({ webhooks: z.array(webhookSchema).max(10) });

const testSchema = z.object({
  url: z.string().trim().regex(DISCORD_WEBHOOK_PATTERN, "URL de webhook do Discord inválida."),
  username: z.string().trim().max(80).optional(),
  avatarUrl: z.string().trim().url().max(500).optional(),
  message: z.string().trim().max(1500).optional(),
});

export function registerNotifyRoutes(server: FastifyInstance, context: AppContext): void {
  server.get("/api/notify/webhooks", async () => {
    const webhooks = context.notify.list();
    return {
      webhooks: webhooks.map((webhook) => ({
        id: webhook.id,
        name: webhook.name,
        events: webhook.events,
        enabled: webhook.enabled,
        username: webhook.username ?? null,
        avatarUrl: webhook.avatarUrl ?? null,
        messages: webhook.messages ?? null,
        // A URL é credencial: quem tem ela consegue postar no canal. Nunca
        // volta por inteiro — a interface mostra só o formato mascarado, e a
        // edição envia uma URL nova quando o usuário trocar.
        urlMasked: webhook.url.replace(/^(https:\/\/[^/]+\/api\/webhooks\/\d+\/).+$/, "$1••••••"),
        lastResult: context.notify.lastResult(webhook.id),
      })),
      kinds: NOTIFY_KINDS,
    };
  });

  server.put("/api/notify/webhooks", async (request: FastifyRequest) => {
    const body = parseInput(saveSchema, request.body);
    // Sanidade: ids únicos, para que o resultado da última entrega não misture.
    const ids = new Set(body.webhooks.map((webhook) => webhook.id));
    if (ids.size !== body.webhooks.length) throw new ValidationError("Há webhooks com id repetido.");

    // Campos secretos/longos (URL, mensagens) são mesclados com o que já está
    // salvo: a interface só os reenvia quando o usuário realmente mudou.
    const previous = new Map(context.notify.list().map((webhook) => [webhook.id, webhook]));
    context.notify.save(
      body.webhooks.map((webhook) => {
        const before = previous.get(webhook.id);
        return {
          id: webhook.id,
          name: webhook.name,
          url: webhook.url ?? before?.url ?? "",
          events: webhook.events,
          enabled: webhook.enabled,
          username: webhook.username !== undefined ? webhook.username || undefined : before?.username,
          avatarUrl: webhook.avatarUrl !== undefined ? webhook.avatarUrl || undefined : before?.avatarUrl,
          messages:
            webhook.messages !== undefined
              ? Object.fromEntries(Object.entries(webhook.messages).filter(([, text]) => text.trim().length > 0))
              : before?.messages,
        };
      }),
    );
    return { ok: true };
  });

  /** Envia uma mensagem de teste para a URL informada (salva ou não). */
  server.post("/api/notify/test", async (request: FastifyRequest) => {
    const body = parseInput(testSchema, request.body);
    const ok = await context.notify.deliver(
      {
        id: "test",
        name: "Teste",
        url: body.url,
        events: [],
        enabled: true,
        ...(body.username?.trim() ? { username: body.username.trim() } : {}),
        ...(body.avatarUrl?.trim() ? { avatarUrl: body.avatarUrl.trim() } : {}),
        ...(body.message?.trim() ? { messages: { started: body.message.trim() } } : {}),
      },
      "started",
    );
    if (!ok) throw new ValidationError("O Discord rejeitou o webhook. Confira a URL e tente de novo.");
    return { ok: true };
  });
}
