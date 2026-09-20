import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { ValidationError } from "../errors.ts";
import { parseInput, createAppSchema, updateAppSchema } from "./validation.ts";

function slugOf(request: FastifyRequest): string {
  return (request.params as { slug: string }).slug;
}

function parseIntParam(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function registerAppRoutes(server: FastifyInstance, context: AppContext): void {
  server.get("/api/apps", async () => {
    const apps = await context.apps.list();
    return { apps };
  });

  server.post("/api/apps", async (request, reply) => {
    const input = parseInput(createAppSchema, request.body);
    const created = await context.apps.create(input);
    reply.code(201);
    return { app: await context.apps.get(created.slug) };
  });

  server.get("/api/apps/:slug", async (request) => {
    return { app: await context.apps.get(slugOf(request)) };
  });

  server.patch("/api/apps/:slug", async (request) => {
    const input = parseInput(updateAppSchema, request.body);
    const updated = await context.apps.update(slugOf(request), input);
    return { app: await context.apps.get(updated.slug) };
  });

  server.delete("/api/apps/:slug", async (request) => {
    const query = request.query as { deleteFiles?: string };
    await context.apps.remove(slugOf(request), query.deleteFiles === "true");
    return { ok: true };
  });

  server.post("/api/apps/:slug/actions/:action", async (request) => {
    const action = (request.params as { action: string }).action;
    const slug = slugOf(request);
    switch (action) {
      case "start":
        await context.apps.start(slug);
        break;
      case "stop":
        await context.apps.stop(slug);
        break;
      case "restart":
        await context.apps.restart(slug);
        break;
      default:
        throw new ValidationError(`Ação desconhecida: ${action}`);
    }
    return { app: await context.apps.get(slug) };
  });

  server.get("/api/apps/:slug/logs", async (request) => {
    const query = request.query as { tail?: string };
    const tail = Math.min(Math.max(parseIntParam(query.tail, 400), 1), 5000);
    return { logs: await context.apps.logs(slugOf(request), tail) };
  });

  /** Pré-visualização dos comandos que serão executados. */
  server.get("/api/apps/:slug/commands", async (request) => {
    const slug = slugOf(request);
    const app = context.apps.mustGet(slug);
    const presentFiles = app.activeRelease > 0 ? await context.apps.listReleaseFiles(slug, app.activeRelease) : [];
    return { commands: context.apps.effectiveCommands(app, presentFiles) };
  });

  // ------------------------------------------------------------- releases

  server.get("/api/apps/:slug/releases", async (request) => {
    const slug = slugOf(request);
    const app = context.apps.mustGet(slug);
    return { activeRelease: app.activeRelease, releases: context.apps.listReleases(slug) };
  });

  server.post("/api/apps/:slug/releases/:seq/activate", async (request) => {
    const slug = slugOf(request);
    const seq = parseIntParam((request.params as { seq: string }).seq, 0);
    if (seq <= 0) throw new ValidationError("Release inválido.");
    await context.apps.activate(slug, seq);
    return { app: await context.apps.get(slug) };
  });

  server.delete("/api/apps/:slug/releases/:seq", async (request) => {
    const slug = slugOf(request);
    const seq = parseIntParam((request.params as { seq: string }).seq, 0);
    await context.apps.deleteRelease(slug, seq);
    return { ok: true };
  });

  // -------------------------------------------------------------- backups

  server.get("/api/apps/:slug/backups", async (request) => {
    return { backups: context.backups.list(slugOf(request)) };
  });

  /** Registra o backup e gera o ZIP em segundo plano (acompanhe pelo status). */
  server.post("/api/apps/:slug/backups", async (request, reply) => {
    const body = parseInput(
      z.object({ includeData: z.boolean().optional() }),
      request.body ?? {},
    );
    const backup = await context.backups.create(slugOf(request), body.includeData ?? true);
    reply.code(202);
    return { backup };
  });

  server.get("/api/apps/:slug/backups/:id", async (request) => {
    const id = parseIntParam((request.params as { id: string }).id, 0);
    return { backup: context.backups.get(slugOf(request), id) };
  });

  server.get("/api/apps/:slug/backups/:id/download", async (request, reply) => {
    const id = parseIntParam((request.params as { id: string }).id, 0);
    const { absolutePath, fileName } = await context.backups.downloadPath(slugOf(request), id);
    reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
    reply.type("application/zip");
    return reply.send(createReadStream(absolutePath));
  });

  server.delete("/api/apps/:slug/backups/:id", async (request) => {
    const id = parseIntParam((request.params as { id: string }).id, 0);
    await context.backups.remove(slugOf(request), id);
    return { ok: true };
  });

  // ---------------------------------------------------------- deployments

  server.get("/api/apps/:slug/deployments", async (request) => {
    const slug = slugOf(request);
    const app = context.apps.mustGet(slug);
    return { deployments: context.store.listDeployments(app.id, 25) };
  });

  server.get("/api/apps/:slug/deployments/:id", async (request) => {
    const id = parseIntParam((request.params as { id: string }).id, 0);
    const deployment = context.store.getDeployment(id);
    if (!deployment) throw new ValidationError("Deployment não encontrado.");
    return { deployment };
  });

  /** Publica um novo release a partir de um ZIP já enviado. */
  server.post("/api/apps/:slug/deploy", async (request, reply) => {
    const slug = slugOf(request);
    const body = parseInput(
      z.object({ uploadId: z.string().min(1), notes: z.string().max(500).optional() }),
      request.body,
    );
    context.apps.mustGet(slug);
    const upload = context.uploads.mustGet(body.uploadId);

    const result = await context.apps.startDeploy(slug, upload.filePath, body.notes ?? "");
    void result.finished.then(async () => {
      const deployment = context.store.getDeployment(result.deploymentId);
      if (deployment?.status === "success") await context.uploads.discard(body.uploadId);
    });

    reply.code(202);
    return { deploymentId: result.deploymentId, releaseSeq: result.releaseSeq };
  });

  // -------------------------------------------------------------- uploads

  /** Recebe o ZIP do projeto e devolve a detecção automática do runtime. */
  server.post("/api/uploads", async (request, reply) => {
    if (!request.isMultipart()) {
      throw new ValidationError("Envie o pacote como multipart/form-data no campo `file`.");
    }
    const data = await request.file();
    if (!data) throw new ValidationError("Nenhum arquivo recebido.");

    const record = await context.uploads.save(data.file, data.filename ?? "pacote.zip");
    if (data.file.truncated) {
      await context.uploads.discard(record.id);
      throw new ValidationError("O arquivo excede o tamanho máximo permitido.");
    }

    const inspection = await context.uploads.inspect(record.id);
    reply.code(201);
    return {
      upload: {
        id: inspection.id,
        fileName: inspection.fileName,
        sizeBytes: inspection.sizeBytes,
        fileCount: inspection.fileCount,
      },
      detection: inspection.detection,
    };
  });

  server.get("/api/uploads/:id", async (request) => {
    const id = (request.params as { id: string }).id;
    const inspection = await context.uploads.inspect(id);
    return {
      upload: { id: inspection.id, fileName: inspection.fileName, sizeBytes: inspection.sizeBytes, fileCount: inspection.fileCount },
      detection: inspection.detection,
    };
  });

  server.delete("/api/uploads/:id", async (request) => {
    await context.uploads.discard((request.params as { id: string }).id);
    return { ok: true };
  });
}
