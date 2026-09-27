import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

/**
 * Tema visual do painel.
 *
 * - `light`  — tema novo em canvas claro, destaque esmeralda.
 * - `dark`   — o mesmo sistema de design em superfícies escuras.
 * - `legacy` — a identidade anterior: escura, com destaque roxo.
 *
 * A escolha é uma preferência local do navegador (chave `botpanel-theme`), igual
 * à do idioma: nunca vai para o backend. O tema ativo é publicado como
 * `data-theme` no `<html>`, que é onde o `index.css` troca os tokens.
 */
export type Theme = "light" | "dark" | "legacy";

export const DEFAULT_THEME: Theme = "light";

/** Ordem em que os temas aparecem no seletor. */
export const THEMES: Theme[] = ["light", "dark", "legacy"];

/** Chave própria da preferência local (nunca enviada ao backend). */
export const THEME_STORAGE_KEY = "botpanel-theme";

/** Cor da barra do navegador em cada tema (espelha o fundo do painel). */
const THEME_COLOR: Record<Theme, string> = {
  light: "#fafafa",
  dark: "#171717",
  legacy: "#070a0d",
};

/** Nome antigo do tema claro, aceito para não perder a preferência já salva. */
const LEGACY_STORAGE_ALIAS: Record<string, Theme> = { default: "light" };

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "legacy";
}

/** Tema inicial: preferência salva → padrão (o tema claro). */
export function detectTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(saved)) return saved;
    if (typeof saved === "string" && saved in LEGACY_STORAGE_ALIAS) {
      return LEGACY_STORAGE_ALIAS[saved] ?? DEFAULT_THEME;
    }
  } catch {
    // armazenamento indisponível (modo privado, política do navegador)
  }
  return DEFAULT_THEME;
}

/**
 * Aplica o tema no documento. `color-scheme` acompanha para que controles
 * nativos (select, scrollbar, autofill) e a barra do navegador combinem.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme === "light" ? "light" : "dark";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLOR[theme]);
}

interface ThemeApi {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

/** Sem provider o seletor ainda funciona (lê e aplica direto no documento). */
const ThemeContext = createContext<ThemeApi>({
  theme: detectTheme(),
  setTheme: applyTheme,
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => detectTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    if (!isTheme(next)) return;
    applyTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // sem armazenamento: a escolha vale só para esta sessão
    }
    setThemeState(next);
  }, []);

  const value = useMemo<ThemeApi>(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeApi {
  return useContext(ThemeContext);
}
