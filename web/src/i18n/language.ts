import { en } from "./en.ts";
import { ptBR } from "./pt-BR.ts";

export type Language = "pt-BR" | "en";

/** Ordem em que os idiomas aparecem no seletor. */
export const LANGUAGES: Language[] = ["pt-BR", "en"];

/** Chave própria da preferência local (nunca enviada ao backend). */
export const LANGUAGE_STORAGE_KEY = "botpanel-language";

/** Nome de cada idioma escrito nele mesmo — não é traduzido. */
export const LANGUAGE_NAMES: Record<Language, string> = {
  "pt-BR": "Português",
  en: "English",
};

/** Etiquetas curtas, para o seletor compacto da barra superior. */
export const LANGUAGE_SHORT: Record<Language, string> = {
  "pt-BR": "PT",
  en: "EN",
};

/** Locale usada por `toLocaleString` para datas e números. */
export const LANGUAGE_LOCALES: Record<Language, string> = {
  "pt-BR": "pt-BR",
  en: "en-US",
};

/**
 * As duas tabelas de mensagens. O `pt-BR` é a fonte: ele é o idioma em que a
 * interface foi escrita, então também serve de fallback quando falta uma chave.
 */
const DICTIONARIES: Record<Language, Record<string, string>> = {
  "pt-BR": ptBR,
  en,
};

export function isLanguage(value: unknown): value is Language {
  return value === "pt-BR" || value === "en";
}

/**
 * Idioma inicial, na ordem pedida: preferência salva → idioma do navegador
 * (`pt`/`pt-*` = português, qualquer outro = inglês) → inglês.
 */
export function detectLanguage(): Language {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isLanguage(saved)) return saved;
  } catch {
    // armazenamento indisponível (modo privado, política do navegador)
  }

  if (typeof navigator !== "undefined") {
    const candidates = [navigator.language, ...(navigator.languages ?? [])];
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || candidate.length === 0) continue;
      const normalized = candidate.toLowerCase();
      return normalized === "pt" || normalized.startsWith("pt-") ? "pt-BR" : "en";
    }
  }

  return "en";
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/**
 * Traduz uma chave. Quando existe a variante de plural (`chave.one`/`chave.other`)
 * e `vars.count` está presente, a escolha é automática:
 *
 *   t("apps.count", { count: 3 })   // → "3 aplicações" / "3 applications"
 */
export function translate(
  language: Language,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const dictionary = DICTIONARIES[language] ?? DICTIONARIES["pt-BR"];
  const fallback = DICTIONARIES["pt-BR"];

  if (vars && typeof vars.count === "number") {
    const pluralKey = `${key}.${vars.count === 1 ? "one" : "other"}`;
    const plural = dictionary[pluralKey] ?? fallback[pluralKey];
    if (plural !== undefined) return interpolate(plural, vars);
  }

  const template = dictionary[key] ?? fallback[key];
  // Chave inexistente: devolve a própria chave, que é visível e fácil de achar.
  return interpolate(template ?? key, vars);
}

// ---------------------------------------------------------------------------
// Idioma ativo
//
// Módulo (e não só contexto) porque há textos criados fora da árvore React —
// rótulos de status e de runtime, etapas de deploy, a linha que o painel escreve
// no console quando o container reinicia. O `I18nProvider` mantém este valor em
// sincronia com o estado, então tudo que for renderizado depois já sai no idioma
// certo.
// ---------------------------------------------------------------------------
let activeLanguage: Language | null = null;

export function getLanguage(): Language {
  if (activeLanguage === null) activeLanguage = detectLanguage();
  return activeLanguage;
}

export function setActiveLanguage(language: Language): void {
  activeLanguage = language;
}

/** Locale do idioma ativo (datas e números). */
export function activeLocale(): string {
  return LANGUAGE_LOCALES[getLanguage()];
}

/** Tradução fora de componente: usa o idioma ativo no momento da chamada. */
export function tActive(key: string, vars?: Record<string, string | number>): string {
  return translate(getLanguage(), key, vars);
}
