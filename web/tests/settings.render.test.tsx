import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// O React 19 só trata `act(...)` como ambiente de teste quando este sinal está
// ligado — sem ele os efeitos não são liberados de forma síncrona.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ToastProvider } from "../src/components/Toasts.tsx";
import { I18nProvider } from "../src/i18n/index.tsx";
import { BrandingProvider } from "../src/branding.tsx";
import Settings from "../src/pages/Settings.tsx";
import type { AiProviderInfo, AiSettings, SystemInfo } from "../src/types.ts";

/**
 * Monta um componente de página com os providers que o App usa e devolve o
 * texto renderizado. Lança se a árvore estourar durante o render/efeito — é
 * assim que uma tela branca por erro de runtime aparece no navegador.
 */
async function renderPage(element: ReactElement): Promise<string> {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  roots.push({ root, container });

  await act(async () => {
    root.render(
      <I18nProvider>
        <BrandingProvider>
          <ToastProvider>{element}</ToastProvider>
        </BrandingProvider>
      </I18nProvider>,
    );
  });
  // Um ciclo extra para as respostas da API (promessas) assentarem.
  await act(async () => {
    await Promise.resolve();
  });
  return container.textContent ?? "";
}

let roots: { root: Root; container: HTMLElement }[] = [];

const systemInfo: SystemInfo = {
  panelName: "BotPanel",
  dataDir: "/var/lib/botpanel",
  panel: {
    version: "0.1.0",
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
  docker: { available: true, version: "27.0.0", apiVersion: "1.45", containers: 2 },
  apps: { total: 2, running: 1 },
  images: ["node:22-alpine", "python:3.12-alpine"],
};

const aiSettings: AiSettings = {
  enabled: true,
  provider: "groq",
  model: "openai/gpt-oss-120b",
  baseUrl: "",
  maxLines: 200,
  temperature: 0.2,
  apiKeySet: true,
  apiKeyHint: "gsk_…4f2a",
};

const provider: AiProviderInfo = {
  id: "groq",
  label: "Groq",
  keysUrl: "https://console.groq.com/keys",
  docsUrl: "https://console.groq.com/docs",
  keyLabel: "chave da Groq",
  requiresKey: true,
  customBaseUrl: false,
  defaultBaseUrl: "https://api.groq.com/openai/v1",
  defaultModel: "openai/gpt-oss-120b",
  models: [
    { id: "openai/gpt-oss-120b", label: "GPT OSS 120B" },
    { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B" },
  ],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  roots = [];
  localStorage.setItem("botpanel-language", "pt-BR");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("/api/system")) return jsonResponse(systemInfo);
    if (url.startsWith("/api/ai/settings")) return jsonResponse({ settings: aiSettings, providers: [provider] });
    if (url.startsWith("/api/ai/models")) {
      return jsonResponse({
        models: { models: provider.models.map((item) => item.id), source: "provider", error: null },
      });
    }
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

describe("página de Configurações", () => {
  it("renderiza a configuração efetiva e o card de IA sem estourar", async () => {
    const text = await renderPage(<Settings />);

    expect(text).toContain("Configurações");
    expect(text).toContain("Configuração efetiva");
    expect(text).toContain("/var/lib/botpanel");
    expect(text).toContain("Análise de logs com IA");
    // Depois que a configuração de IA chega, o formulário completo aparece: é
    // neste segundo render que a contagem de hooks precisa permanecer igual.
    expect(text).toContain("Modelo");
    expect(text).toContain("openai/gpt-oss-120b");
    expect(text).toContain("buscar modelos");
  });

  it("mostra a lista de modelos do provedor junto com o formulário", async () => {
    const text = await renderPage(<Settings />);

    expect(text).toContain("llama-3.1-8b-instant");
    expect(text).toContain("Modelos disponíveis na sua conta");
  });
});
