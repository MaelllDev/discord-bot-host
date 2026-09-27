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
import Login from "../src/pages/Login.tsx";

let roots: { root: Root; container: HTMLElement }[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Simula a digitação em um input controlado do React. */
function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function inputByLabel(container: HTMLElement, label: string): HTMLInputElement {
  const field = [...container.querySelectorAll("label")].find((node) =>
    node.textContent?.trim().startsWith(label),
  );
  const input = field?.querySelector("input");
  if (!input) throw new Error(`input não encontrado para o rótulo: ${label}`);
  return input;
}

const buttonWithText = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text));

const click = async (element: Element | undefined): Promise<void> => {
  if (!element) throw new Error("elemento esperado não encontrado");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

/** Encadeia os microtasks pendentes até a cadeia de promessas assentar. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderLogin(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  roots.push({ root, container });

  const tree: ReactElement = (
    <I18nProvider>
      <BrandingProvider>
        <ToastProvider>
          <Login onSuccess={() => {}} />
        </ToastProvider>
      </BrandingProvider>
    </I18nProvider>
  );

  await act(async () => {
    root.render(tree);
  });
  await flush();
  return container;
}

beforeEach(() => {
  roots = [];
  localStorage.clear();
  localStorage.setItem("botpanel-language", "pt-BR");
});

afterEach(async () => {
  for (const { root, container } of roots) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

describe("recuperação de senha na tela de login", () => {
  it("mostra o link sempre e explica o caminho do servidor quando não há recuperação", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.startsWith("/api/branding")) return jsonResponse({ branding: { name: "BotPanel", iconUrl: "" } });
      if (url.startsWith("/api/auth/recover")) {
        calls.push(url);
        return jsonResponse({ available: false });
      }
      throw new Error(`rota não esperada: ${url}`);
    });

    const container = await renderLogin();

    // O link aparece mesmo com a senha vinda de variável de ambiente.
    expect(container.textContent).toContain("Esqueci minha senha");

    await click(buttonWithText(container, "Esqueci minha senha"));
    await flush();

    // Em vez de resetar, explica como trocar a senha no servidor.
    expect(container.textContent).toContain("não redefine a senha pela interface");
    expect(container.textContent).toContain("/etc/botpanel.env");
    expect(container.textContent).toContain("systemctl restart botpanel");

    // Nenhuma chamada a token/reset foi feita: só a consulta de disponibilidade.
    expect(calls.every((url) => url === "/api/auth/recover")).toBe(true);
    expect(container.textContent).not.toContain("Gerar token");
  });

  it("gera o token, mostra o arquivo no servidor e redefine a senha", async () => {
    const calls: { url: string; body?: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.startsWith("/api/branding")) return jsonResponse({ branding: { name: "BotPanel", iconUrl: "" } });
      if (url === "/api/auth/recover" && (!init?.method || init.method === "GET")) {
        return jsonResponse({ available: true });
      }
      if (url === "/api/auth/recover/token") {
        calls.push({ url });
        return jsonResponse({ ok: true, expiresInSeconds: 900, tokenFile: "/opt/botpanel/data/reset-token" });
      }
      if (url === "/api/auth/recover/reset") {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return jsonResponse({ ok: true });
      }
      throw new Error(`rota não esperada: ${url}`);
    });

    const container = await renderLogin();
    expect(container.textContent).toContain("Esqueci minha senha");

    // Confirmação: o token só é gerado depois do clique em "Gerar token".
    await click(buttonWithText(container, "Esqueci minha senha"));
    expect(container.textContent).toContain("Redefinir a senha com um token");
    expect(calls).toHaveLength(0);

    await click(buttonWithText(container, "Gerar token"));
    await flush();

    expect(calls[0]?.url).toBe("/api/auth/recover/token");
    // O caminho do arquivo aparece para o administrador ler no servidor.
    expect(container.textContent).toContain("/opt/botpanel/data/reset-token");
    expect(container.textContent).toContain("vale por 15 min");

    setInput(inputByLabel(container, "Token"), "token-lido-do-arquivo");
    setInput(inputByLabel(container, "Nova senha"), "senha-nova-bem-longa");
    setInput(inputByLabel(container, "Confirmar nova senha"), "senha-nova-bem-longa");
    await click(buttonWithText(container, "Redefinir senha"));
    await flush();

    expect(calls[1]).toEqual({
      url: "/api/auth/recover/reset",
      body: { token: "token-lido-do-arquivo", password: "senha-nova-bem-longa" },
    });
    expect(container.textContent).toContain("Senha redefinida");
  });

  it("avisa quando as senhas não coincidem e não chama a API", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.startsWith("/api/branding")) return jsonResponse({ branding: { name: "BotPanel", iconUrl: "" } });
      if (url === "/api/auth/recover" && (!init?.method || init.method === "GET")) {
        return jsonResponse({ available: true });
      }
      if (url === "/api/auth/recover/token") return jsonResponse({ ok: true, expiresInSeconds: 900, tokenFile: "/d/t" });
      calls.push(url);
      return jsonResponse({ ok: true });
    });

    const container = await renderLogin();
    await click(buttonWithText(container, "Esqueci minha senha"));
    await click(buttonWithText(container, "Gerar token"));
    await flush();

    setInput(inputByLabel(container, "Token"), "token-ok");
    setInput(inputByLabel(container, "Nova senha"), "senha-nova-bem-longa");
    setInput(inputByLabel(container, "Confirmar nova senha"), "senha-diferente");
    await click(buttonWithText(container, "Redefinir senha"));
    await flush();

    expect(container.textContent).toContain("não são iguais");
    expect(calls).toHaveLength(0);
  });

  it("explica a espera quando o servidor limita os pedidos de token", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.startsWith("/api/branding")) return jsonResponse({ branding: { name: "BotPanel", iconUrl: "" } });
      if (url === "/api/auth/recover" && (!init?.method || init.method === "GET")) {
        return jsonResponse({ available: true });
      }
      if (url === "/api/auth/recover/token") {
        return jsonResponse({ error: "wait", retryAfterSeconds: 600 }, 429);
      }
      throw new Error(`rota não esperada: ${url}`);
    });

    const container = await renderLogin();
    await click(buttonWithText(container, "Esqueci minha senha"));
    await click(buttonWithText(container, "Gerar token"));
    await flush();

    expect(container.textContent).toContain("Aguarde 10 min");
  });
});
