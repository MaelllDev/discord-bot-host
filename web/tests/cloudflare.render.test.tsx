import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// O React 19 só trata `act(...)` como ambiente de teste quando este sinal está
// ligado — sem ele os efeitos não são liberados de forma síncrona.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ToastProvider } from "../src/components/Toasts.tsx";
import { I18nProvider } from "../src/i18n/index.tsx";
import LanguageSwitch from "../src/components/LanguageSwitch.tsx";
import Cloudflare from "../src/pages/Cloudflare.tsx";
import type { TunnelView } from "../src/types.ts";

/** Token de teste: formato plausível, sem valor real nenhum. */
const TOKEN = "eyJhIjoiZmFrZS10dW5uZWwtdG9rZW4tcGFyYS10ZXN0ZXMifQ==";

let roots: { root: Root; container: HTMLElement }[] = [];
let tunnel: TunnelView;
let requests: { method: string; url: string; body?: unknown }[] = [];
/** Rotas que devem responder erro, no formato `MÉTODO /caminho`. */
let failing: Set<string>;

function view(overrides: Partial<TunnelView> = {}): TunnelView {
  return {
    configured: true,
    enabled: true,
    tokenSet: true,
    tokenHint: "eyJh••••fQ==",
    state: "connected",
    containerName: "botpanel-cloudflared",
    containerId: "abc123",
    image: "cloudflare/cloudflared:latest",
    restartPolicy: "unless-stopped",
    containerStatus: "running",
    uptimeSeconds: 3600,
    startedAt: "2026-09-28T00:00:00.000Z",
    exitCode: 0,
    dockerAvailable: true,
    lastError: null,
    lastErrorCode: null,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
    lastConnectedAt: "2026-09-28T00:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function errorResponse(message: string, code?: string): Response {
  return jsonResponse({ error: message, code }, 400);
}

async function renderPage(element: ReactElement = <Cloudflare />, language = "pt-BR"): Promise<HTMLElement> {
  localStorage.setItem("botpanel-language", language);
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  roots.push({ root, container });

  await act(async () => {
    root.render(
      <I18nProvider>
        <ToastProvider>{element}</ToastProvider>
      </I18nProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

/** Encadeia microtasks até as chamadas de rede assentarem. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/**
 * Escreve em um input controlado. O setter do protótipo é necessário porque o
 * React acompanha o valor pela propriedade da instância: atribuir `.value`
 * direto não dispara o `onChange` (mesma técnica do teste de login).
 */
function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Desmonta a última página montada (usado ao trocar o estado entre cenários). */
async function unmountLast(): Promise<void> {
  const entry = roots.pop();
  if (!entry) return;
  await act(async () => entry.root.unmount());
  entry.container.remove();
}

function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  );
}

function buttonLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].map((item) => item.textContent?.trim() ?? "");
}

async function click(container: HTMLElement, label: string): Promise<void> {
  const target = button(container, label);
  if (!target) throw new Error(`botão "${label}" não encontrado. Botões: ${buttonLabels(container).join(" | ")}`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  roots = [];
  requests = [];
  failing = new Set();
  tunnel = view();
  localStorage.clear();

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ method, url, body });

    if (failing.has(`${method} ${url.split("?")[0]}`)) {
      return errorResponse("Falha simulada no teste.", "cloudflare.connectionFailed");
    }

    if (url.startsWith("/api/cloudflare/logs")) {
      return jsonResponse({ lines: ["INF Starting tunnel", "INF Registered tunnel connection"] });
    }
    if (url === "/api/cloudflare" && method === "GET") return jsonResponse({ tunnel });
    if (url === "/api/cloudflare" && method === "PUT") {
      const payload = (body ?? {}) as { token?: string; enabled?: boolean };
      if (payload.token) tunnel = { ...tunnel, tokenSet: true, configured: true };
      if (payload.enabled !== undefined) tunnel = { ...tunnel, enabled: payload.enabled };
      return jsonResponse({ tunnel });
    }
    if (url === "/api/cloudflare/connect") {
      tunnel = { ...tunnel, state: "connected", containerStatus: "running", restartPolicy: "unless-stopped" };
      return jsonResponse({ tunnel });
    }
    if (url === "/api/cloudflare/disconnect") {
      tunnel = { ...tunnel, state: "stopped", enabled: false, containerStatus: "stopped" };
      return jsonResponse({ tunnel });
    }
    if (url === "/api/cloudflare/restart") {
      tunnel = { ...tunnel, state: "connected", containerStatus: "running" };
      return jsonResponse({ tunnel });
    }
    if (url === "/api/cloudflare/test") {
      if (tunnel.state !== "connected") return errorResponse("O túnel não conectou.", "cloudflare.notConnected");
      return jsonResponse({ tunnel });
    }
    if (url === "/api/cloudflare" && method === "DELETE") {
      tunnel = view({
        configured: false,
        tokenSet: false,
        tokenHint: "",
        state: "not_configured",
        containerStatus: null,
        restartPolicy: null,
        enabled: false,
      });
      return jsonResponse({ tunnel });
    }
    throw new Error(`rota não esperada no teste: ${method} ${url}`);
  });
});

afterEach(async () => {
  for (const { root, container } of roots) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("página Cloudflare Tunnel", () => {
  it("renderiza o estado seguro do túnel", async () => {
    const container = await renderPage();
    const text = container.textContent ?? "";

    expect(text).toContain("Cloudflare Tunnel");
    expect(text).toContain("Conectado");
    expect(text).toContain("Token configurado");
    expect(text).toContain("botpanel-cloudflared");
    expect(text).toContain("unless-stopped");
    expect(text).toContain("cloudflare/cloudflared:latest");
  });

  it("apresenta o texto em português", async () => {
    const container = await renderPage(<Cloudflare />, "pt-BR");
    const text = container.textContent ?? "";
    expect(text).toContain("Configuração");
    expect(text).toContain("Desconectar");
    expect(text).toContain("Testar conexão");
    expect(text).toContain("Remover configuração");
  });

  it("apresenta o texto em inglês", async () => {
    const container = await renderPage(<Cloudflare />, "en");
    const text = container.textContent ?? "";
    expect(text).toContain("Configuration");
    expect(text).toContain("Disconnect");
    expect(text).toContain("Test connection");
    expect(text).toContain("Remove configuration");
  });

  it("troca de idioma sem recarregar a página", async () => {
    const container = await renderPage(
      <>
        <Cloudflare />
        <LanguageSwitch compact />
      </>,
      "pt-BR",
    );
    expect(container.textContent).toContain("Desconectar");

    const globe = container.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']");
    expect(globe).toBeTruthy();
    await act(async () => {
      globe!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const english = [...container.querySelectorAll("[role='menuitemradio']")].find((item) =>
      item.textContent?.includes("English"),
    );
    expect(english).toBeTruthy();
    await act(async () => {
      english!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("Disconnect");
    expect(container.textContent).not.toContain("Desconectar");
  });

  it("nunca mostra o token depois de salvo", async () => {
    tunnel = view({ tokenSet: false, configured: false, tokenHint: "", state: "not_configured", containerStatus: null });
    const container = await renderPage();

    // O campo aparece porque ainda não há token salvo: digite e salve.
    const input = container.querySelector<HTMLInputElement>("input[type='password']");
    expect(input).toBeTruthy();
    await act(async () => {
      setInput(input!, TOKEN);
    });
    await click(container, "Salvar");

    // O valor enviado foi para a API...
    const sent = requests.find((item) => item.method === "PUT");
    expect(sent?.body).toMatchObject({ token: TOKEN });
    // ...e não sobrou na tela, nem no estado do componente.
    expect(container.textContent).not.toContain(TOKEN);
    expect(container.innerHTML).not.toContain(TOKEN);
    expect(container.querySelector("input[type='password']")).toBeNull();
    expect(container.textContent).toContain("Token configurado");
  });

  it("mostra o estado conectado", async () => {
    const container = await renderPage();
    expect(container.textContent).toContain("Conectado");
    expect(container.textContent).toContain("Última conexão");
  });

  it("mostra o estado desconectado", async () => {
    tunnel = view({ state: "disconnected", enabled: true, containerStatus: "running" });
    const container = await renderPage();
    expect(container.textContent).toContain("Sem conexão");
    // Container de pé com túnel sem conexão: não é "Conectado".
    expect(container.textContent).not.toContain("Último erro do túnel");
  });

  it("mostra o estado de erro com a explicação redigida", async () => {
    tunnel = view({
      state: "error",
      lastErrorCode: "cloudflare.connectionFailed",
      lastError:
        "cloudflared: ERR Failed to connect to edge: invalid tunnel token <token-redigido>",
    });
    const container = await renderPage();
    const text = container.textContent ?? "";
    expect(text).toContain("Erro");
    expect(text).toContain("não conseguiu conectar à Cloudflare");
    expect(text).toContain("<token-redigido>");
    expect(text).not.toContain(TOKEN);
  });

  it("avisa quando o Docker está indisponível", async () => {
    tunnel = view({ dockerAvailable: false, state: "unknown" });
    const container = await renderPage();
    expect(container.textContent).toContain("O Docker não está respondendo");
  });

  it("mostra um toast de sucesso ao conectar", async () => {
    tunnel = view({ state: "stopped", enabled: false, containerStatus: "stopped" });
    const container = await renderPage();

    await click(container, "Conectar");
    const status = container.querySelector("[role='status']");
    expect(status?.textContent).toContain("Túnel conectado");
    expect(requests.some((item) => item.url === "/api/cloudflare/connect")).toBe(true);
  });

  it("mostra um toast de erro quando a ação falha", async () => {
    tunnel = view({ state: "stopped", enabled: false, containerStatus: "stopped" });
    failing.add("POST /api/cloudflare/connect");
    const container = await renderPage();

    await click(container, "Conectar");
    const status = container.querySelector("[role='status']");
    expect(status?.textContent).toContain("Falha simulada no teste");
  });

  it("pede confirmação antes de remover a configuração", async () => {
    const container = await renderPage();
    expect(container.querySelector("[role='dialog']")).toBeNull();

    await click(container, "Remover configuração");
    const dialog = container.querySelector("[role='dialog']");
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain("Remover a configuração do túnel?");
    // Ainda não chamou a API: só abriu o diálogo.
    expect(requests.some((item) => item.method === "DELETE")).toBe(false);

    const confirm = [...dialog!.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "Remover configuração",
    );
    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(requests.some((item) => item.method === "DELETE")).toBe(true);
    expect(container.querySelector("[role='dialog']")).toBeNull();
    expect(container.textContent).toContain("Não configurado");
  });

  it("os botões respeitam o estado atual", async () => {
    // Sem container: dá para conectar (se há token), mas não para desconectar/reiniciar.
    tunnel = view({ state: "stopped", enabled: false, containerStatus: null });
    let container = await renderPage();
    expect(buttonLabels(container)).toContain("Conectar");
    expect(buttonLabels(container)).not.toContain("Desconectar");
    expect(buttonLabels(container)).not.toContain("Reiniciar");
    await unmountLast();

    // Conectado: as ações de container aparecem e "Conectar" sai de cena.
    tunnel = view({ state: "connected", containerStatus: "running" });
    container = await renderPage();
    expect(buttonLabels(container)).not.toContain("Conectar");
    expect(buttonLabels(container)).toContain("Desconectar");
    expect(buttonLabels(container)).toContain("Reiniciar");
    expect(buttonLabels(container)).toContain("Testar conexão");

    // Sem token: não há o que conectar nem testar.
    tunnel = view({
      state: "not_configured",
      configured: false,
      tokenSet: false,
      tokenHint: "",
      containerStatus: null,
    });
    await unmountLast();
    container = await renderPage();
    expect(buttonLabels(container)).not.toContain("Conectar");
    expect(buttonLabels(container)).not.toContain("Testar conexão");
  });

  it("carrega os logs de diagnóstico sob demanda", async () => {
    const container = await renderPage();
    expect(container.textContent).toContain("Carregue os logs");

    await click(container, "Carregar logs");
    expect(requests.some((item) => item.url.startsWith("/api/cloudflare/logs"))).toBe(true);
    expect(container.textContent).toContain("Registered tunnel connection");
  });

  it("todas as chaves novas existem nos dois idiomas", async () => {
    const { ptBR } = await import("../src/i18n/pt-BR.ts");
    const { en } = await import("../src/i18n/en.ts");

    const keys = Object.keys(ptBR).filter(
      (key) => key.startsWith("cloudflare.") || key.startsWith("errors.cloudflare."),
    );
    expect(keys.length).toBeGreaterThan(40);
    for (const key of keys) {
      const pt = ptBR[key] ?? "";
      const english = en[key] ?? "";
      expect({ key, missing: pt.length === 0 || english.length === 0 }).toEqual({ key, missing: false });
    }
    // Os estados do túnel usados em template literal também existem nos dois.
    for (const state of ["not_configured", "stopped", "starting", "connected", "disconnected", "error", "unknown"]) {
      expect({ state, pt: `cloudflare.status.${state}` in ptBR, en: `cloudflare.status.${state}` in en }).toEqual({
        state,
        pt: true,
        en: true,
      });
    }
    expect("nav.cloudflare" in ptBR && "nav.cloudflare" in en).toBe(true);
  });
});
