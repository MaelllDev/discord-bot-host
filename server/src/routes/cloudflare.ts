import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { parseInput } from "./validation.ts";

/**
 * Configuração enviada pela interface. `token` ausente/vazio significa "não
 * mexi no token" — a API nunca devolve o segredo, então apagar em branco o
 * perderia (mesma regra da chave de IA em `aiSettingsSchema`).
 */
const saveSchema = z.object({
  token: z.string().max(4096).optional(),
  enabled: z.boolean().optional(),
});

const logsQuerySchema = z.object({
  lines: z.coerce.number().int().min(1).max(300).optional(),
});

/**
 * Cloudflare Tunnel como integração do painel. Todas as respostas passam pelo
 * `view()` do serviço: o token nunca aparece em nenhuma delas — só `tokenSet` e
 * uma dica mascarada. O token também nunca é aceito por query string.
 */
export function registerCloudflareRoutes(server: FastifyInstance, context: AppContext): void {
  server.get("/api/cloudflare", async () => ({ tunnel: await context.cloudflare.view() }));

  server.get("/api/cloudflare/logs", async (request: FastifyRequest) => {
    const query = parseInput(logsQuerySchema, request.query);
    return { lines: await context.cloudflare.logs(query.lines ?? 120) };
  });

  server.put("/api/cloudflare", async (request: FastifyRequest) => {
    const body = parseInput(saveSchema, request.body);
    return { tunnel: await context.cloudflare.save(body) };
  });

  server.post("/api/cloudflare/connect", async () => ({ tunnel: await context.cloudflare.connect() }));

  server.post("/api/cloudflare/disconnect", async () => ({ tunnel: await context.cloudflare.disconnect() }));

  server.post("/api/cloudflare/restart", async () => ({ tunnel: await context.cloudflare.restart() }));

  server.post("/api/cloudflare/test", async () => ({ tunnel: await context.cloudflare.test() }));

  server.delete("/api/cloudflare", async () => ({ tunnel: await context.cloudflare.remove() }));
}
