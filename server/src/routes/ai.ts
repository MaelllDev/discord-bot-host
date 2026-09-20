import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { parseInput, aiAnalyzeSchema, aiDraftSchema, aiSettingsSchema } from "./validation.ts";

function slugOf(request: FastifyRequest): string {
  return (request.params as { slug: string }).slug;
}

function idOf(request: FastifyRequest): number {
  return Number.parseInt((request.params as { id: string }).id, 10);
}

/**
 * Análise de logs com IA. A chave de API é do próprio administrador e fica
 * guardada no banco local do painel — não existe conta, proxy ou chave
 * compartilhada do projeto. Nenhuma rota devolve a chave: apenas `apiKeySet` e
 * uma dica mascarada.
 */
export function registerAiRoutes(server: FastifyInstance, context: AppContext): void {
  server.get("/api/ai/settings", async () => {
    return { settings: context.ai.getSettings(), providers: context.ai.listProviders() };
  });

  server.put("/api/ai/settings", async (request) => {
    const input = parseInput(aiSettingsSchema, request.body);
    return { settings: context.ai.saveSettings(input) };
  });

  /**
   * Lista de modelos direto do provedor, com as sugestões do painel como
   * reserva. Aceita os campos do formulário no corpo: assim o botão "buscar
   * modelos" funciona antes de salvar, usando a chave que o usuário acabou de
   * digitar.
   */
  server.get("/api/ai/models", async (request) => {
    return { models: await context.ai.listModels() };
  });

  server.post("/api/ai/models", async (request) => {
    const draft = parseInput(aiDraftSchema, request.body ?? {});
    return { models: await context.ai.listModels(draft) };
  });

  /** Testa a conexão com o provedor — com os campos do formulário, se enviados. */
  server.post("/api/ai/test", async (request) => {
    const draft = parseInput(aiDraftSchema, request.body ?? {});
    return { result: await context.ai.test(draft) };
  });

  // ------------------------------------------------------------- análises

  server.post("/api/apps/:slug/ai/analyze", async (request, reply) => {
    const input = parseInput(aiAnalyzeSchema, request.body);
    const app = context.apps.mustGet(slugOf(request));
    const summary = await context.apps.get(app.slug);
    const analysis = context.ai.analyze(app, { status: summary.status, exitCode: summary.resources?.exitCode ?? null }, input.logs, input.question);
    reply.code(202);
    return { analysis };
  });

  server.get("/api/apps/:slug/ai/analyses", async (request) => {
    const app = context.apps.mustGet(slugOf(request));
    return { analyses: context.ai.list(app.id) };
  });

  server.get("/api/ai/analyses/:id", async (request) => {
    return { analysis: context.ai.get(idOf(request)) };
  });

  server.delete("/api/ai/analyses/:id", async (request) => {
    context.ai.remove(idOf(request));
    return { ok: true };
  });
}
