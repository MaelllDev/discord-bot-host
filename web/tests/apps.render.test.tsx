import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

// O React 19 só trata `act(...)` como ambiente de teste quando este sinal está
// ligado — sem ele os efeitos não são liberados de forma síncrona.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ToastProvider } from "../src/components/Toasts.tsx";
import { I18nProvider } from "../src/i18n/index.tsx";
import Apps from "../src/pages/Apps.tsx";
import type { AppSummary } from "../src/types.ts";

let roots: { root: Root; container: HTMLElement }[] = [];

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function renderApps(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  roots.push({ root, container });

  const tree: ReactElement = (
    <I18nProvider>
      <ToastProvider>
        <MemoryRouter initialEntries={["/apps"]}>
          <Apps />
        </MemoryRouter>
      </ToastProvider>
    </I18nProvider>
  );

  await act(async () => {
    root.render(tree);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  roots = [];
  localStorage.clear();
  localStorage.setItem("botpanel-language", "pt-BR");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("/api/apps")) return jsonResponse({ apps: [app] });
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

const viewButton = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(label));

describe("tela de Aplicações", () => {
  it("começa em cards e mostra o nome da aplicação", async () => {
    const container = await renderApps();

    expect(container.textContent).toContain("Bot Canal");
    // A grade de cards aparece por padrão (nenhuma tabela na árvore).
    expect(container.querySelector("table")).toBeNull();
    expect(localStorage.getItem("botpanel.apps.view")).toBe("cards");
  });

  it("alterna para a lista e guarda a preferência", async () => {
    const container = await renderApps();

    await act(async () => {
      viewButton(container, "Lista")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(localStorage.getItem("botpanel.apps.view")).toBe("list");
    expect(container.querySelector("table")).not.toBeNull();
  });

  it("volta a lista já aberta quando a preferência foi salva", async () => {
    localStorage.setItem("botpanel.apps.view", "list");
    const container = await renderApps();

    expect(container.querySelector("table")).not.toBeNull();
  });
});
