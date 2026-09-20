import fs from "node:fs";
import os from "node:os";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import type { SystemInfo } from "../types.ts";

/** Versão do painel lida do `package.json` do servidor (some se ilegível). */
function panelVersion(): string | null {
  try {
    const file = fileURLToPath(new URL("../../package.json", import.meta.url));
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

/** Espaço em disco do diretório de dados (null se o sistema não suportar statfs). */
async function diskUsage(target: string): Promise<SystemInfo["host"]["disk"]> {
  try {
    const stats = await fsp.statfs(target);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return { path: target, totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes) };
  } catch {
    return null;
  }
}

function hostInfo(): SystemInfo["host"] {
  const cpus = os.cpus();
  const load = os.loadavg();
  return {
    platform: `${os.type()} ${os.release()}`,
    release: os.release(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model?.trim() ?? null,
    cpuCount: cpus.length,
    loadAverage: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    memoryTotalBytes: os.totalmem(),
    memoryFreeBytes: os.freemem(),
    disk: null,
  };
}

export function registerSystemRoutes(server: FastifyInstance, context: AppContext): void {
  server.get("/api/health", async () => ({ status: "ok" }));

  server.get("/api/system", async () => {
    const docker = await context.docker.info();
    const apps = context.store.listApps();

    // Com o daemon fora, "0 containers" e "0 em execução" seriam mentira: o
    // estado é desconhecido e o painel mostra isso explicitamente.
    let running: number | null = null;
    if (docker.available) {
      const managed = await context.docker.listManaged();
      running = managed.filter((container) => container.status === "running").length;
    }

    const host = hostInfo();
    host.disk = await diskUsage(context.config.dataDir);

    const info: SystemInfo = {
      panelName: context.config.panelName,
      dataDir: context.config.dataDir,
      panel: {
        version: panelVersion(),
        nodeVersion: process.version,
        startedAt: new Date(context.startedAt).toISOString(),
        uptimeSeconds: Math.max(0, Math.floor((Date.now() - context.startedAt) / 1000)),
      },
      host,
      config: {
        host: context.config.host,
        port: context.config.port,
        dockerSocket: context.config.dockerSocket,
        allowedImages: context.config.allowedImages,
        keepReleases: context.config.keepReleases,
        sessionTtlHours: Math.round(context.config.sessionTtlMs / 3_600_000),
        cookieSecure: context.config.cookieSecure,
        maxUploadMb: Math.round(context.config.maxUploadBytes / (1024 * 1024)),
        runUid: context.config.runUid,
        runGid: context.config.runGid,
        instanceId: context.config.instanceId,
      },
      docker: {
        available: docker.available,
        version: docker.version,
        apiVersion: docker.apiVersion,
        containers: docker.available ? docker.containers : null,
      },
      apps: { total: apps.length, running },
      images: await context.docker.listImages(),
    };
    return info;
  });

  server.get("/api/events", async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "50", 10) || 50, 1), 200);
    return { events: context.store.listEvents(limit) };
  });

  /** Uso de disco por aplicação (operação mais custosa, feita sob demanda). */
  server.get("/api/usage", async () => {
    const apps = context.store.listApps();
    const usage = await Promise.all(
      apps.map(async (app) => ({ slug: app.slug, bytes: await context.apps.diskUsage(app.slug) })),
    );
    return { usage };
  });
}
