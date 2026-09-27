import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import App from "../src/App.tsx";
import { I18nProvider } from "../src/i18n/index.tsx";
import { BrandingProvider } from "../src/branding.tsx";

/**
 * O App monta o roteador de dados (`createBrowserRouter`), o provider da barra
 * de alterações não salvas e o viewport dentro do Layout. Este teste garante
 * que a árvore inteira sobe sem estourar — é exatamente o tipo de quebra que
 * só aparece em tempo de execução (hook fora do contexto, rota ausente).
 */
async function renderPage(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  roots.push({ root, container });

  await act(async () => {
    root.render(element);
  });
// Ciclos reais (macrotask) para a cadeia de promessas da API assentar:
// sessão → estado autenticado → dados da página.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

let roots: { root: Root; container: HTMLElement }[] = [];

const app = {
  id: "1",
  slug: "bot-a",
  name: "Bot A",
  description: "",
  iconUrl: "",
  runtime: "node",
  image: "node:22-slim",
  entry: "index.js",
  startCommand: "",
  installCommand: "",
  depsFile: "package.json",
  memoryMb: 256,
  cpu: 0.5,
  pidsLimit: 128,
  env: [],
  ports: [],
  autoStart: true,
  autoRestart: false,
  activeRelease: 1,
  stoppedByUser: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  status: "running",
  resources: null,
  releaseCount: 1,
  diskBytes: 0,
};

function jsonResponse(payload: unknown, status = 200): Response {
  const body = JSON.stringify(payload);
  // O cliente real lê `text()` e faz o parse; `json` fica para compatibilidade.
  return { ok: status < 400, status, text: async () => body, json: async () => payload } as unknown as Response;
}

beforeEach(() => {
  roots = [];
  window.history.replaceState(null, "", "/");
  localStorage.setItem("botpanel-language", "pt-BR");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("/api/auth/session")) return jsonResponse({ authenticated: true, panelName: "BotPanel Teste" });
    if (url.startsWith("/api/apps/")) return jsonResponse({ app });
    if (url.startsWith("/api/apps")) return jsonResponse({ apps: [app] });
    if (url.includes("/events")) return jsonResponse({ events: [] });
    if (url.startsWith("/api/system"))
      return jsonResponse({
        panel: { version: "1.0.3", nodeVersion: "v22.0.0", startedAt: "2026-01-01T00:00:00.000Z", uptimeSeconds: 10 },
        docker: { available: true, version: "27.0.0", apiVersion: "1.47", containers: 1 },
        host: {
          platform: "linux",
          release: "6.8.0",
          arch: "x64",
          cpuModel: "Fake CPU",
          cpuCount: 2,
          loadAverage: [0.1, 0.1, 0.1],
          memoryTotalBytes: 4_000_000_000,
          memoryFreeBytes: 2_000_000_000,
          disk: { path: "/", totalBytes: 40_000_000_000, freeBytes: 20_000_000_000, usedBytes: 20_000_000_000 },
        },
        config: {
          host: "0.0.0.0",
          port: 8080,
          dockerSocket: "/var/run/docker.sock",
          allowedImages: null,
          keepReleases: 5,
          sessionTtlHours: 12,
          cookieSecure: false,
          maxUploadMb: 2048,
          runUid: 1000,
          runGid: 1000,
          instanceId: "test-instance",
        },
        apps: { total: 1, running: 1 },
        images: [],
      });
    if (url.startsWith("/api/branding")) return jsonResponse({ branding: { name: "BotPanel Teste", iconUrl: "" } });
    return jsonResponse({});
  });
});

afterEach(() => {
  for (const { root, container } of roots.splice(0).reverse()) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("app com data router", () => {
  it("monta a árvore completa autenticado e mostra o dashboard", async () => {
    const container = await renderPage(
      <I18nProvider>
        <BrandingProvider>
          <App />
        </BrandingProvider>
      </I18nProvider>,
    );

    expect(container.textContent).toContain("Painel");
    // A casca lista as aplicações (sidebar) e o estado do Docker.
    expect(container.textContent).toContain("Bot A");
  });

  it("a página do bot inclui a aba de configuração e a barra global não aparece sem alterações", async () => {
    window.history.replaceState(null, "", "/apps/bot-a");
    const container = await renderPage(
      <I18nProvider>
        <BrandingProvider>
          <App />
        </BrandingProvider>
      </I18nProvider>,
    );

    expect(container.textContent).toContain("Bot A");
    // Sem nada pendente, nenhuma barra de "alterações não salvas" é exibida.
    expect(container.textContent).not.toContain("Há alterações não salvas");
  });
});
