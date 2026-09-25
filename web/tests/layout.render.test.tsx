import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// O React 19 só trata `act(...)` como ambiente de teste quando este sinal está
// ligado — sem ele os efeitos não são liberados de forma síncrona.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import Layout from "../src/components/Layout.tsx";
import { I18nProvider } from "../src/i18n/index.tsx";
import { BrandingProvider } from "../src/branding.tsx";
import type { AppSummary, SystemInfo } from "../src/types.ts";

let roots: { root: Root; container: HTMLElement }[] = [];

/** Controla o que `/api/system` responde em cada teste. */
let dockerAvailable = true;

const app: AppSummary = {
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
};

function systemInfo(available: boolean): SystemInfo {
  return {
    panelName: "BotPanel Teste",
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
      disk: null,
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
    docker: {
      available,
      version: available ? "27.0.0" : null,
      apiVersion: available ? "1.45" : null,
      containers: available ? 1 : null,
    },
    apps: { total: 1, running: available ? 1 : null },
    images: ["node:22-alpine"],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Monta a casca do painel em uma rota e devolve o texto renderizado. */
async function renderShell(path: string): Promise<string> {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  roots.push({ root, container });

  const tree: ReactElement = (
    <I18nProvider>
      <BrandingProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<Layout onLogout={() => {}} />}>
              <Route index element={<p>conteúdo do dashboard</p>} />
              <Route path="apps/:slug" element={<p>conteúdo da aplicação</p>} />
              <Route path="apps/new" element={<p>conteúdo de nova aplicação</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </BrandingProvider>
    </I18nProvider>
  );

  await act(async () => {
    root.render(tree);
  });
  // Um ciclo extra para as respostas da API (promessas) assentarem.
  await act(async () => {
    await Promise.resolve();
  });
  return container.textContent ?? "";
}

beforeEach(() => {
  roots = [];
  dockerAvailable = true;
  // Idioma fixo: as asserções abaixo são em português (o idioma de origem).
  localStorage.setItem("botpanel-language", "pt-BR");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("/api/apps")) return jsonResponse({ apps: [app] });
    if (url.startsWith("/api/system")) return jsonResponse(systemInfo(dockerAvailable));
    // A casca agora pega o nome do painel do /api/branding.
    if (url.startsWith("/api/branding")) return jsonResponse({ branding: { name: "BotPanel Teste", iconUrl: "" } });
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

describe("casca do painel", () => {
  it("mostra a navegação em seções, a lista de aplicações e o estado do Docker", async () => {
    const text = await renderShell("/");

    expect(text).toContain("BotPanel Teste");
    expect(text).toContain("Dashboard");
    expect(text).toContain("Aplicações");
    expect(text).toContain("Nova aplicação");
    expect(text).toContain("Gerenciar");
    expect(text).toContain("Backups");
    expect(text).toContain("Sistema");
    expect(text).toContain("Configurações");
    expect(text).toContain("Minhas aplicações");
    expect(text).toContain("Bot Canal");
    expect(text).toContain("Docker conectado");
    expect(text).toContain("conteúdo do dashboard");
  });

  it("resolve o título da barra superior pelo nome da aplicação aberta", async () => {
    const text = await renderShell("/apps/bot-canal");

    // Uma vez na lista da sidebar e outra no título da barra superior.
    expect((text.match(/Bot Canal/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(text).toContain("bot-canal");
    expect(text).toContain("conteúdo da aplicação");
  });

  it("com o Docker fora do ar mostra indisponível, e não um falso conectado", async () => {
    dockerAvailable = false;
    const text = await renderShell("/");

    expect(text).toContain("Docker indisponível");
    expect(text).not.toContain("Docker conectado");
    // O painel continua navegável mesmo sem o daemon.
    expect(text).toContain("Dashboard");
  });
});
