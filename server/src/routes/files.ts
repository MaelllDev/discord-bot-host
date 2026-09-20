import { createReadStream } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { ValidationError } from "../errors.ts";
import { fileRootSchema, parseInput } from "./validation.ts";

const MAX_UPLOAD_TOTAL_BYTES = 64 * 1024 * 1024;

interface QueryParams {
  root?: string;
  path?: string;
}

function slugOf(request: FastifyRequest): string {
  return (request.params as { slug: string }).slug;
}

function rootOf(value: unknown): "code" | "data" {
  const parsed = fileRootSchema.safeParse(value ?? "code");
  if (!parsed.success) throw new ValidationError(`Raiz de arquivos inválida: ${String(value)}`);
  return parsed.data;
}

const writeSchema = z.object({
  root: fileRootSchema.default("code"),
  path: z.string().min(1).max(1024),
  content: z.string().max(4 * 1024 * 1024),
});

const mkdirSchema = z.object({ root: fileRootSchema.default("code"), path: z.string().min(1).max(1024) });
const renameSchema = z.object({
  root: fileRootSchema.default("code"),
  from: z.string().min(1).max(1024),
  to: z.string().min(1).max(1024),
});
const removeSchema = z.object({ root: fileRootSchema.default("code"), path: z.string().min(1).max(1024) });

export function registerFileRoutes(server: FastifyInstance, context: AppContext): void {
  server.get("/api/apps/:slug/files", async (request) => {
    const query = request.query as QueryParams;
    return context.files.list(slugOf(request), rootOf(query.root), query.path ?? "");
  });

  server.get("/api/apps/:slug/files/content", async (request) => {
    const query = request.query as QueryParams;
    if (!query.path) throw new ValidationError("Informe o caminho do arquivo.");
    return context.files.read(slugOf(request), rootOf(query.root), query.path);
  });

  server.put("/api/apps/:slug/files/content", async (request) => {
    const body = parseInput(writeSchema, request.body);
    await context.files.write(slugOf(request), body.root, body.path, body.content);
    return { ok: true };
  });

  server.post("/api/apps/:slug/files/mkdir", async (request) => {
    const body = parseInput(mkdirSchema, request.body);
    await context.files.mkdir(slugOf(request), body.root, body.path);
    return { ok: true };
  });

  server.post("/api/apps/:slug/files/rename", async (request) => {
    const body = parseInput(renameSchema, request.body);
    await context.files.rename(slugOf(request), body.root, body.from, body.to);
    return { ok: true };
  });

  server.delete("/api/apps/:slug/files", async (request) => {
    const body = parseInput(removeSchema, request.body);
    await context.files.remove(slugOf(request), body.root, body.path);
    return { ok: true };
  });

  /** Upload de um ou mais arquivos para uma pasta do release ou do volume /data. */
  server.post("/api/apps/:slug/files/upload", async (request) => {
    if (!request.isMultipart()) {
      throw new ValidationError("Envie os arquivos como multipart/form-data.");
    }
    const slug = slugOf(request);
    let root: "code" | "data" = "code";
    let targetDir = "";
    let total = 0;
    let saved = 0;

    for await (const part of request.parts()) {
      if (part.type === "field") {
        if (part.fieldname === "root") root = rootOf(part.value);
        if (part.fieldname === "path") targetDir = String(part.value ?? "").replace(/^\/+/, "");
        continue;
      }

      const relative = path.posix.join(targetDir === "." ? "" : targetDir, path.basename(part.filename || "arquivo"));
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of part.file) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        total += buffer.length;
        if (total > MAX_UPLOAD_TOTAL_BYTES) {
          throw new ValidationError("O upload excede o limite total de 64 MB.");
        }
        chunks.push(buffer);
      }
      if (part.file.truncated) throw new ValidationError(`O arquivo ${relative} excede o limite permitido.`);
      await context.files.saveUpload(slug, root, relative, Buffer.concat(chunks, size));
      saved += 1;
    }

    if (saved === 0) throw new ValidationError("Nenhum arquivo recebido.");
    return { ok: true, files: saved };
  });

  /** Download direto de um arquivo. */
  server.get("/api/apps/:slug/files/download", async (request, reply) => {
    const query = request.query as QueryParams;
    if (!query.path) throw new ValidationError("Informe o caminho do arquivo.");
    const { absolutePath, name } = await context.files.downloadPath(slugOf(request), rootOf(query.root), query.path);
    reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(name)}"`);
    reply.type("application/octet-stream");
    return reply.send(createReadStream(absolutePath));
  });
}
