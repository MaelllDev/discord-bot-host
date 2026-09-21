import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ToastProvider } from "../src/components/Toasts.tsx";
import Dashboard from "../src/pages/Dashboard.tsx";
import type { AppSummary, SystemInfo } from "../src/types.ts";

let roots: { root: Root; container: HTMLElement }[] = [];

/** Controla a lista de aplicações devolvida por `/api/apps`. */
let apps: AppSummary[] = [];

function makeApp(overrides: Partial<AppSummary> = {}): AppSummary {
  return {
    id: "app-1",
    slug: "bot-canal",
    name: "Bot Canal",
    description: "",
    iconUrl: "",
    runtime: "node",
    image: "node:22-alpine",
    entry: "index.js",
    startCommand: "node index.js",
    installCommand: "npm install",
    depsFile: "package.json",
    memoryMb: 512,
    cpu: 1,
    pidsLimit: 256,
    env: [],
    ports: [],
    autoStart: true,
    autoRestart: true,
    activeRelease: 1,
    createdAt: "2026-09-20T01:00:00.000Z",
    updatedAt: "2026-09-20T01:00:00.000Z",
    status: "running",
    resources: null,
    releaseCount: 1,
    diskBytes: 1024,
    ...overrides,
  };
}

const systemInfo: SystemInfo = {
  panelName: "BotPanel",
  dataDir: "/var/lib/botpanel",
  panel: {
    version: "1.0.1",
    nodeVersion: "v22.20.0",
    startedAt: "2026-09-20T01:00:00.000Z",
    uptimeSeconds: 120,
  },
  host: {
    platform: "linux",
    release: "6.8.0",
    arch: "x64",
    cpuModel: "Fake CPU",
    cpuCount: 4,
    loadAverage: [0.1, 0.2, 0.3],
    memoryTotalBytes: 8 * 1024 ** 3,
    memoryFreeBytes: 4 * 1024 ** 3,
    disk: { path: "/", totalBytes: 80 * 1024 ** 3, freeBytes: 40 * 1024 ** 3, usedBytes: 40 * 1024 ** 3 },
  },
  config: {
    host: "0.0.0.0",
    port: 8080,
    dockerSocket: "/var/run/docker.sock",
    allowedImages: null,
    keepReleases: 3,
    sessionTtlHours: 12,
    cookieSecure: false,
    maxUploadMb: 50,
    runUid: 1000,
    runGid: 1000,
    instanceId: "test-instance",
  },
  docker: { available: true, version: "27.0.0", apiVersion: "1.45", containers: 1 },
  apps: { total: 1, running: 1 },
  images: ["node:22-alpine"],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function renderDashboard(): Promise<string> {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  roots.push({ root, container });

  const tree: ReactElement = (
    <MemoryRouter>
      <ToastProvider>
        <Dashboard />
      </ToastProvider>
    </MemoryRouter>
  );

  await act(async () => {
    root.render(tree);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container.textContent ?? "";
}

beforeEach(() => {
  roots = [];
  apps = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("/api/apps")) return jsonResponse({ apps });
    if (url.startsWith("/api/system")) return jsonResponse(systemInfo);
    if (url.startsWith("/api/events")) return jsonResponse({ events: [] });
    throw new Error(`rota não esperada no teste: ${url}`);
  });
});

afterEach(async () => {
  for (const { root, container } of roots) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

describe("página de Dashboard", () => {
  it("renderiza os indicadores e a lista de aplicações", async () => {
    apps = [makeApp({ status: "running" }), makeApp({ id: "app-2", slug: "bot-parado", name: "Bot Parado", status: "stopped" })];

    const text = await renderDashboard();

    expect(text).toContain("Dashboard");
    expect(text).toContain("Aplicações");
    expect(text).toContain("Online");
    expect(text).toContain("Paradas");
    expect(text).toContain("Desconhecidas");
    expect(text).toContain("Uso das aplicações");
    expect(text).toContain("Capacidade da VPS");
    expect(text).toContain("Bot Canal");
    expect(text).toContain("Bot Parado");
    expect(text).toContain("Atividade recente");
    // Sem aplicações paradas/desconhecidas, o bloco de primeiros passos não aparece.
    expect(text).not.toContain("Primeiros passos");
  });

  it("sem nenhuma aplicação mostra o bloco de primeiros passos", async () => {
    const text = await renderDashboard();

    expect(text).toContain("Primeiros passos");
    expect(text).toContain("Hospede seus bots e aplicações nesta VPS");
    expect(text).toContain("Deploy por ZIP");
    expect(text).toContain("Versões e rollback");
    expect(text).toContain("Criar a primeira aplicação");
  });
});
