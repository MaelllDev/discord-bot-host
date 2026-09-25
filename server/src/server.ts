import fs from "node:fs";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import type { PanelConfig } from "./config.ts";
import { Store } from "./db.ts";
import { DockerService } from "./docker/service.ts";
import { AppService } from "./apps/service.ts";
import { FileService } from "./apps/files.ts";
import { UploadStore } from "./apps/uploads.ts";
import { ImageStore } from "./apps/images.ts";
import { BackupService } from "./apps/backups.ts";
import { AiService } from "./ai/service.ts";
import { NotifyService, startStatusWatcher } from "./notify/webhooks.ts";
import { LoginThrottle, resolvePasswordSource } from "./auth.ts";
import { registerRoutes } from "./routes/index.ts";
import { isAuthenticated } from "./routes/auth.ts";
import { AppError, UnauthorizedError, errorMessage } from "./errors.ts";
import { isDockerUnavailable } from "./docker/service.ts";
import { PathEscapeError } from "./util/paths.ts";
import { UnsafeArchiveError } from "./util/archive.ts";
import type { AppContext } from "./context.ts";

/** Rotas que não exigem sessão. */
const PUBLIC_ROUTES = new Set(["/api/health", "/api/auth/login", "/api/auth/logout", "/api/auth/session"]);
/** GETs públicos adicionais (a mutação continua exigindo sessão). */
const PUBLIC_GETS = new Set(["/api/branding"]);

export interface BuiltServer {
  server: FastifyInstance;
  context: AppContext;
}

/**
 * Monta o servidor completo (plugins, rotas, guarda de sessão) sem escutar
 * portas — o que também permite testar com `server.inject`.
 */
export async function buildServer(config: PanelConfig): Promise<BuiltServer> {
  const store = await Store.open(config.dataDir);
  const docker = new DockerService(config.dockerSocket, config.instanceId);
  const apps = new AppService(config, store, docker);
  const files = new FileService(config, apps);
  const uploads = new UploadStore(config);
  const images = new ImageStore(config);
  const backups = new BackupService(config, store);
  const ai = new AiService(store);
  const notify = new NotifyService(store, () => config.panelName);
  await uploads.init();
  await images.init();
  // Um backup interrompido por um restart ficaria marcado como "em execução"
  // para sempre; registrar a falha é mais honesto do que mostrar progresso falso.
  backups.recoverInterrupted();
  // O mesmo vale para uma análise de IA que estava sendo gerada quando o painel caiu.
  ai.recoverInterrupted();

  const context: AppContext = {
    config,
    store,
    docker,
    apps,
    backups,
    ai,
    files,
    uploads,
    images,
    notify,
    password: resolvePasswordSource(config),
    throttle: new LoginThrottle(),
    session: { epoch: Number.parseInt(store.getSetting("session_epoch") ?? "0", 10) || 0 },
    startedAt: Date.now(),
  };

  const server = Fastify({
    logger: {
      level: process.env["LOG_LEVEL"] ?? "info",
      transport: undefined,
    },
    trustProxy: process.env["BOTPANEL_TRUST_PROXY"] === "1",
    bodyLimit: 8 * 1024 * 1024,
  });

  await server.register(cookie);
  await server.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 20,
      fields: 20,
    },
  });
  await server.register(websocket);

  // Guarda de sessão para toda a API, exceto as rotas públicas.
  server.addHook("onRequest", async (request: FastifyRequest) => {
    const path = (request.url.split("?")[0] ?? "").replace(/\/+$/, "") || "/";
    if (!path.startsWith("/api/")) return;
    if (PUBLIC_ROUTES.has(path)) return;
    // Branding (nome/ícone do painel) é público em GET: a tela de login consulta
    // antes de existir sessão. Gravação continua restrita ao admin.
    if (request.method === "GET" && PUBLIC_GETS.has(path)) return;
    if (!isAuthenticated(request, context)) throw new UnauthorizedError();
  });

  registerRoutes(server, context);

  // Observador de status: crash/recuperação sem ninguém com a página aberta.
  startStatusWatcher(context);
  // Ações manuais (start/stop/restart) avisam por conta própria, com o tipo
  // exato, e marcam intenção para o observador não duplicar o aviso.
  apps.onLifecycle = (kind, app) => void context.notify.dispatch(kind, app);
  apps.onIntent = (slug) => context.notify.noteIntent(slug);

  // Imagens enviadas (fotos dos bots, ícone do painel). Autenticado como a
  // API: foto de bot pode ser tão sensível quanto os logs dele. Fica fora do
  // bloco do frontend porque serve imagens mesmo sem build do painel.
  server.get("/uploads/images/:file", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAuthenticated(request, context)) throw new UnauthorizedError();
    const file = (request.params as { file: string }).file;
    const bytes = context.images.read(file);
    if (!bytes) return reply.code(404).send({ error: "Imagem não encontrada." });
    const ext = file.split(".").pop() ?? "";
    reply.header("cache-control", "private, max-age=86400");
    reply.type(ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`);
    return reply.send(bytes);
  });

  server.setErrorHandler((error: Error & { statusCode?: number }, request: FastifyRequest, reply: FastifyReply) => {
    // Daemon do Docker fora do ar não é erro de programa: a interface mostra a
    // causa em linguagem clara e o usuário pode tentar de novo.
    if (isDockerUnavailable(error)) {
      request.log.warn({ err: error }, "Docker indisponível");
      return reply.code(503).send({
        error: `O Docker não está respondendo em "${config.dockerSocket}". Confirme se o serviço está em execução e tente novamente.`,
        details: errorMessage(error),
      });
    }

    const statusCode =
      error instanceof AppError
        ? error.statusCode
        : error instanceof PathEscapeError || error instanceof UnsafeArchiveError
          ? 400
          : (error.statusCode ?? 500);
    if (statusCode >= 500) request.log.error(error);
    return reply.code(statusCode).send({
      error: errorMessage(error),
      details: error instanceof AppError ? error.details : undefined,
      // Código estável para o painel traduzir (`errors.<code>`); segue ausente
      // em erros que não o definem — aí o texto original é usado como está.
      code: error instanceof AppError ? error.code : undefined,
    });
  });

  const publicDir = config.publicDir;
  if (publicDir && fs.existsSync(publicDir) && fs.readdirSync(publicDir).length > 0) {
    await server.register(fastifyStatic, { root: publicDir, prefix: "/" });
    server.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "Rota não encontrada." });
      }
      return reply.sendFile("index.html");
    });
  } else {
    server.log.warn("Frontend não encontrado em web/dist. Rode `npm run build` (ou use `npm run dev:web`).");
    server.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
      return reply.code(404).send({ error: "Frontend não compilado. Execute `npm run build` na raiz do projeto." });
    });
  }

  return { server, context };
}
