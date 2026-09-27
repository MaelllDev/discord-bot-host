import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// O React 19 só trata `act(...)` como ambiente de teste quando este sinal está
// ligado — sem ele os efeitos não são liberados de forma síncrona.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { I18nProvider } from "../src/i18n/index.tsx";
import ThemeSwitch from "../src/components/ThemeSwitch.tsx";
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  ThemeProvider,
  applyTheme,
  detectTheme,
} from "../src/theme.tsx";

describe("camada de tema", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("padrão é o tema claro, e a preferência salva tem precedência", () => {
    expect(detectTheme()).toBe(DEFAULT_THEME);
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(detectTheme()).toBe("dark");
    localStorage.setItem(THEME_STORAGE_KEY, "legacy");
    expect(detectTheme()).toBe("legacy");
  });

  it("migra o nome antigo do tema claro (`default`)", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "default");
    expect(detectTheme()).toBe("light");
  });

  it("ignora um valor inválido salvo", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "neon");
    expect(detectTheme()).toBe(DEFAULT_THEME);
  });

  it("aplica o tema no `<html>` e ajusta o color-scheme", () => {
    applyTheme("legacy");
    expect(document.documentElement.dataset.theme).toBe("legacy");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });
});

describe("troca de tema na interface", () => {
  let roots: { root: Root; container: HTMLElement }[] = [];

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("botpanel-language", "pt-BR");
  });

  afterEach(async () => {
    for (const { root, container } of roots) {
      await act(async () => root.unmount());
      container.remove();
    }
    roots = [];
  });

  async function renderSwitch(): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push({ root, container });
    await act(async () => {
      root.render(
        <ThemeProvider>
          <I18nProvider>
            <ThemeSwitch />
          </I18nProvider>
        </ThemeProvider>,
      );
    });
    return container;
  }

  const buttonLabelled = (container: HTMLElement, text: string) =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === text);

  it("oferece claro, escuro e legacy, com o claro marcado por padrão", async () => {
    const container = await renderSwitch();

    expect(buttonLabelled(container, "Claro")?.getAttribute("aria-pressed")).toBe("true");
    expect(buttonLabelled(container, "Escuro")?.getAttribute("aria-pressed")).toBe("false");
    expect(buttonLabelled(container, "Legacy")?.getAttribute("aria-pressed")).toBe("false");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("troca para o modo escuro sem recarregar e persiste a escolha", async () => {
    const container = await renderSwitch();

    await act(async () => {
      buttonLabelled(container, "Escuro")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    // Sem reload: o mesmo componente passou a marcar o outro tema.
    expect(buttonLabelled(container, "Escuro")?.getAttribute("aria-pressed")).toBe("true");
  });
});
