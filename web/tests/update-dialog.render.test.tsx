import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// O React 19 só trata `act(...)` como ambiente de teste quando este sinal está
// ligado — sem ele os efeitos não são liberados de forma síncrona.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ToastProvider } from "../src/components/Toasts.tsx";
import { I18nProvider } from "../src/i18n/index.tsx";
import UpdateCodeDialog from "../src/components/UpdateCodeDialog.tsx";
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

/** `uploadZipWithProgress` usa XHR — o mock resolve direto com o payload. */
class MockXhr {
  public status = 200;
  public responseText = "";
  public upload = { onprogress: null as ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null };
  public onload: (() => void) | null = null;
  public open(): void {}
  public send(): void {
    this.responseText = JSON.stringify({
      upload: { id: "up-1", fileName: "bot.zip", sizeBytes: 10, fileCount: 2 },
      detection: {
        runtime: "node",
        entry: "index.js",
        depsFile: "package.json",
        installCommand: "npm install",
        startCommand: "node index.js",
        presentFiles: ["index.js", "package.json"],
        notes: [],
      },
    });
    this.onload?.();
  }
}

async function renderDialog(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  roots.push({ root, container });

  const tree: ReactElement = (
    <I18nProvider>
      <ToastProvider>
        <UpdateCodeDialog app={app} open onClose={() => {}} onDeployed={() => {}} />
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

function dropEvent(file: File): DragEvent {
  const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", { value: { files: [file] } });
  return event;
}

function makeFile(name: string, type: string): File {
  return new File(["conteudo"], name, { type });
}

/** Encadeia os microtasks pendentes até a cadeia do upload assentar. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  roots = [];
  localStorage.clear();
  localStorage.setItem("botpanel-language", "pt-BR");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("/api/apps/") && url.endsWith("/deployments")) {
      return jsonResponse({ deploymentId: 1, releaseSeq: 2 });
    }
    throw new Error(`rota não esperada no teste: ${url}`);
  });
  vi.stubGlobal("XMLHttpRequest", MockXhr as unknown as typeof XMLHttpRequest);
});

afterEach(async () => {
  for (const { root, container } of roots) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

describe("diálogo de atualização de código", () => {
  it("aceita um .zip solto por drag & drop e mostra a detecção", async () => {
    const container = await renderDialog();

    const zone = container.querySelector<HTMLElement>('[data-testid="update-dropzone"]');
    expect(zone).not.toBeNull();

    await act(async () => {
      zone!.dispatchEvent(dropEvent(makeFile("bot.zip", "application/zip")));
    });
    await flush();

    // O fluxo saiu da etapa "select": a dropzone deu lugar à detecção do projeto.
    expect(container.querySelector('[data-testid="update-dropzone"]')).toBeNull();
    expect(container.textContent).toContain("bot.zip");
    expect(container.textContent).toContain("runtime");
  });

  it("recusa arquivo que não é .zip com um aviso", async () => {
    const container = await renderDialog();

    const zone = container.querySelector<HTMLElement>('[data-testid="update-dropzone"]')!;
    await act(async () => {
      zone.dispatchEvent(dropEvent(makeFile("foto.png", "image/png")));
    });
    await flush();

    // Continua na etapa de seleção e mostra a mensagem de recusa.
    expect(container.querySelector('[data-testid="update-dropzone"]')).not.toBeNull();
    expect(container.textContent).toContain("não é um arquivo .zip");
    expect(container.textContent).toContain("foto.png");
  });
});
