import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { ValidationError } from "../errors.ts";
import { parseInput } from "./validation.ts";
import { z } from "zod";

/** Chaves do banco usadas pela identidade visual do painel. */
export const BRANDING_KEYS = {
  name: "branding.name",
  icon: "branding.icon",
} as const;

/** Nome do painel efetivo: personalizado, ou o do config/env como padrão. */
export function effectivePanelName(context: AppContext): string {
  return context.store.getSetting(BRANDING_KEYS.name) ?? context.config.panelName;
}

/** URL do ícone do painel (vazia = usar o logo padrão). */
export function effectivePanelIcon(context: AppContext): string {
  return context.store.getSetting(BRANDING_KEYS.icon) ?? "";
}

const brandingSchema = z.object({
  name: z.string().trim().min(1).max(48).optional(),
  iconUrl: z.string().trim().max(500).optional(),
});

export function registerBrandingRoutes(server: FastifyInstance, context: AppContext): void {
  /**
   * Público por design: a tela de login precisa do nome e do ícone antes de
   * qualquer sessão, e não expõe nada sensível — é cosmética do painel.
   */
  server.get("/api/branding", async () => {
    return { branding: { name: effectivePanelName(context), iconUrl: effectivePanelIcon(context) } };
  });

  server.put("/api/branding", async (request: FastifyRequest) => {
    const body = parseInput(brandingSchema, request.body);
    if (body.name !== undefined) {
      context.store.setSetting(BRANDING_KEYS.name, body.name);
      context.config.panelName = body.name;
      context.store.addEvent(null, "info", `Nome do painel alterado para "${body.name}"`);
    }
    if (body.iconUrl !== undefined) {
      context.store.setSetting(BRANDING_KEYS.icon, body.iconUrl);
      context.store.addEvent(null, "info", body.iconUrl ? "Ícone do painel atualizado" : "Ícone do painel restaurado ao padrão");
    }
    return { branding: { name: effectivePanelName(context), iconUrl: effectivePanelIcon(context) } };
  });

  // ------------------------------------------------------------ imagens

  /** Upload de imagem (foto de bot ou ícone do painel). Devolve a URL. */
  server.post("/api/images", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.isMultipart()) {
      throw new ValidationError("Envie a imagem como multipart/form-data no campo `file`.");
    }
    const data = await request.file();
    if (!data) throw new ValidationError("Nenhuma imagem recebida.");

    // Cota de disco antes de gravar: evita acumular lixo em /var/lib.
    const used = await context.images.usedBytes();
    if (used > 256 * 1024 * 1024) {
      throw new ValidationError("Espaço de imagens esgotado. Remova imagens antigas e tente de novo.");
    }

    const saved = await context.images.save(data.file, data.mimetype);
    reply.code(201);
    return { image: saved };
  });
}
