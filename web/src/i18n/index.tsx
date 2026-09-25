import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  LANGUAGE_LOCALES,
  LANGUAGE_STORAGE_KEY,
  detectLanguage,
  isLanguage,
  setActiveLanguage,
  translate,
} from "./language.ts";
import type { Language } from "./language.ts";

export type TranslateVars = Record<string, string | number>;

/**
 * Assinatura da tradução. Aceita qualquer string para que chaves montadas em
 * tempo de execução continuem válidas (`t(\`status.${status}\`)`); a existência
 * das chaves é verificada por `web/tests/i18n.test.tsx`, que varre o código.
 */
export type Translate = (key: string, vars?: TranslateVars) => string;

export interface I18nContextValue {
  language: Language;
  locale: string;
  setLanguage: (language: Language) => void;
  t: Translate;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * Provê o idioma da interface. A preferência é local (localStorage, chave
 * `botpanel-language`) e nunca vai para o backend — é só apresentação.
 *
 * O idioma ativo também é publicado no módulo `language.ts` (fora do React)
 * para que rótulos criados fora da renderização — status, runtime, etapas de
 * deploy — saiam no idioma correto.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => detectLanguage());

  // Antes dos filhos renderizarem, para que as traduções feitas fora do React
  // (e o primeiro render) já usem o idioma escolhido.
  setActiveLanguage(language);

  const setLanguage = useCallback((next: Language) => {
    if (!isLanguage(next)) return;
    setActiveLanguage(next);
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    } catch {
      // sem armazenamento: a escolha vale só para esta sessão
    }
    setLanguageState(next);
  }, []);

  useEffect(() => {
    // O atributo `lang` do documento acompanha a interface (leitor de tela,
    // hifenização e corretor ortográfico do navegador).
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      locale: LANGUAGE_LOCALES[language],
      setLanguage,
      t: (key, vars) => translate(language, key, vars),
    }),
    [language, setLanguage],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n precisa estar dentro de <I18nProvider>");
  return context;
}

/** Atalho para o caso mais comum: só a função de tradução. */
export function useTranslate(): Translate {
  return useI18n().t;
}

export { LANGUAGES, LANGUAGE_NAMES, LANGUAGE_SHORT, detectLanguage, isLanguage } from "./language.ts";
export type { Language } from "./language.ts";
