import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import RouteErrorBoundary from "../src/components/ErrorBoundary.tsx";
import { I18nProvider } from "../src/i18n/index.tsx";

let roots: { root: Root; container: HTMLElement }[] = [];

/** Renderiza dentro de um router (o boundary observa a rota para se recuperar). */
async function render(element: ReactElement): Promise<string> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => {
    root.render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/settings"]}>{element}</MemoryRouter>
      </I18nProvider>,
    );
  });
  return container.textContent ?? "";
}

function Boom(): ReactElement {
  throw new Error("falha proposital de render");
}

beforeEach(() => {
  roots = [];
  localStorage.setItem("botpanel-language", "pt-BR");
  // O React imprime o erro no console do navegador; aqui isso só polui a saída.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const { root, container } of roots) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

describe("error boundary de página", () => {
  it("mostra a mensagem de erro em vez de tela em branco", async () => {
    const text = await render(
      <RouteErrorBoundary>
        <Boom />
      </RouteErrorBoundary>,
    );

    expect(text).toContain("Não foi possível exibir esta página");
    expect(text).toContain("falha proposital de render");
    expect(text).toContain("Recarregar painel");
  });

  it("renderiza o conteúdo normalmente quando não há erro", async () => {
    const text = await render(
      <RouteErrorBoundary>
        <p>conteúdo saudável</p>
      </RouteErrorBoundary>,
    );

    expect(text).toContain("conteúdo saudável");
  });
});
