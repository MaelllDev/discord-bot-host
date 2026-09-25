import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { en } from "../src/i18n/en.ts";
import { ptBR } from "../src/i18n/pt-BR.ts";
import { detectLanguage, LANGUAGE_STORAGE_KEY, translate } from "../src/i18n/language.ts";
import { I18nProvider, useI18n } from "../src/i18n/index.tsx";
import LanguageSwitch from "../src/components/LanguageSwitch.tsx";

/** Todos os arquivos de `src/`, para varrer as chaves usadas no código. */
function sourceFiles(): string[] {
  const root = join(process.cwd(), "src");
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) files.push(path);
    }
  })(root);
  return files;
}

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();

describe("camada de tradução", () => {
  it("pt-BR e en têm exatamente as mesmas chaves", () => {
    const pt = Object.keys(ptBR).sort();
    const english = Object.keys(en).sort();
    expect(english).toEqual(pt);
  });

  it("cada par de mensagens usa os mesmos marcadores", () => {
    for (const key of Object.keys(ptBR)) {
      const ptMarkers = placeholders(ptBR[key] ?? "");
      const enMarkers = placeholders(en[key] ?? "");
      expect({ key, enMarkers }).toEqual({ key, enMarkers: ptMarkers });
    }
  });

  it("toda chave usada no código existe nos dois idiomas", () => {
    const missingInPt: string[] = [];
    const missingInEn: string[] = [];
    // Também cobre chaves montadas em template literal (`status.${x}`, ...).
    const dynamic = [
      ...["running", "starting", "restarting", "stopped", "crashed", "paused", "deploying", "unknown"].map(
        (status) => `status.${status}`,
      ),
      ...["node", "python", "custom"].map((runtime) => `runtime.${runtime}`),
      ...["success", "failed", "running", "pending"].map((status) => `deploy.status.${status}`),
      ...["start", "stop", "restart"].map((action) => `actions.${action}.done`),
    ];

    for (const file of sourceFiles()) {
      // Comentários fora: `language.ts` documenta o uso de `t("apps.count")`, e
      // isso não é uma chave exigida em tempo de execução.
      const text = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const match of text.matchAll(/\bt\(\s*"([^"]+)"/g)) {
        const key = match[1] ?? "";
        if (!(key in ptBR)) missingInPt.push(`${key} (${file})`);
        if (!(key in en)) missingInEn.push(`${key} (${file})`);
      }
    }
    for (const key of dynamic) {
      if (!(key in ptBR)) missingInPt.push(key);
      if (!(key in en)) missingInEn.push(key);
    }

    expect({ missingInPt, missingInEn }).toEqual({ missingInPt: [], missingInEn: [] });
  });

  it("escolhe a variante de plural pelo `count`", () => {
    expect(translate("pt-BR", "apps.count", { count: 1 })).toBe("1 aplicação");
    expect(translate("pt-BR", "apps.count", { count: 4 })).toBe("4 aplicações");
    expect(translate("en", "apps.count", { count: 1 })).toBe("1 application");
    expect(translate("en", "apps.count", { count: 4 })).toBe("4 applications");
  });

  it("interpola os marcadores", () => {
    expect(translate("pt-BR", "metric.ofLimit", { used: "120 MB", limit: "512 MB" })).toBe("120 MB de 512 MB");
    expect(translate("en", "metric.ofLimit", { used: "120 MB", limit: "512 MB" })).toBe("120 MB of 512 MB");
  });

  it("devolve a própria chave quando ela não existe (falha visível, não silenciosa)", () => {
    expect(translate("pt-BR", "chave.que.nao.existe")).toBe("chave.que.nao.existe");
  });
});

describe("idioma inicial", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("usa a preferência salva quando existe", () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "pt-BR");
    expect(detectLanguage()).toBe("pt-BR");
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
    expect(detectLanguage()).toBe("en");
  });

  it("ignora um valor inválido salvo", () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "klingon");
    expect(["pt-BR", "en"]).toContain(detectLanguage());
  });

  it("cai para pt-BR quando o navegador é pt-* e para en em qualquer outro", () => {
    localStorage.clear();
    vi.spyOn(navigator, "language", "get").mockReturnValue("pt-BR");
    expect(detectLanguage()).toBe("pt-BR");

    vi.spyOn(navigator, "language", "get").mockReturnValue("fr-FR");
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr-FR"]);
    expect(detectLanguage()).toBe("en");
  });
});

describe("troca de idioma na interface", () => {
  let roots: { root: Root; container: HTMLElement }[] = [];

  afterEach(async () => {
    for (const { root, container } of roots) {
      await act(async () => root.unmount());
      container.remove();
    }
    roots = [];
    vi.restoreAllMocks();
    localStorage.clear();
  });

  /** Renderiza um texto traduzido e o seletor, para trocar na hora. */
  function Harness() {
    const { t } = useI18n();
    return (
      <div>
        <span data-testid="label">{t("nav.apps")}</span>
        <LanguageSwitch compact />
      </div>
    );
  }

  async function renderHarness(): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push({ root, container });
    await act(async () => {
      root.render(
        <I18nProvider>
          <Harness />
        </I18nProvider>,
      );
    });
    return container;
  }

  it("troca o texto sem recarregar a página e persiste a escolha", async () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "pt-BR");
    const container = await renderHarness();

    expect(container.querySelector("[data-testid='label']")?.textContent).toBe("Aplicações");
    expect(document.documentElement.lang).toBe("pt-BR");

    const enButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "EN");
    expect(enButton).toBeTruthy();

    await act(async () => {
      enButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Sem reload: o mesmo nó passou a mostrar o texto em inglês.
    expect(container.querySelector("[data-testid='label']")?.textContent).toBe("Applications");
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });
});
