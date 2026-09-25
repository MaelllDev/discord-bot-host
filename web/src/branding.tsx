import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api } from "./api.ts";

const DEFAULT_NAME = "BotPanel";
const FALLBACK_ICON = "/logo.png";

interface Branding {
  name: string;
  iconUrl: string;
}

interface BrandingApi extends Branding {
  /** Aplica nome/ícone novos na hora (sem reload). */
  apply: (branding: Branding) => void;
  /** Restaura o ícone padrão (logo.png). */
  resetIcon: () => void;
}

const BrandingContext = createContext<BrandingApi | null>(null);

function applyFavicon(iconUrl: string): void {
  const href = iconUrl || FALLBACK_ICON;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.append(link);
    const apple = document.createElement("link");
    apple.rel = "apple-touch-icon";
    apple.href = href;
    document.head.append(apple);
  }
  link.href = href;
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [branding, setBranding] = useState<Branding>({ name: DEFAULT_NAME, iconUrl: FALLBACK_ICON });

  const apply = useCallback((next: Branding) => {
    setBranding({ name: next.name || DEFAULT_NAME, iconUrl: next.iconUrl });
  }, []);

  const resetIcon = useCallback(() => {
    setBranding((current) => ({ ...current, iconUrl: FALLBACK_ICON }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .branding()
      .then((result) => {
        if (!cancelled) setBranding({ name: result.branding.name || DEFAULT_NAME, iconUrl: result.branding.iconUrl });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Favicon sempre espelha o ícone configurado (fallback: logo.png). O título
  // da aba fica por conta das telas (Layout/Login), que conhecem a página atual.
  useEffect(() => applyFavicon(branding.iconUrl), [branding.iconUrl]);

  const value = useMemo<BrandingApi>(() => ({ ...branding, apply, resetIcon }), [branding, apply, resetIcon]);
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): BrandingApi {
  const context = useContext(BrandingContext);
  if (!context) throw new Error("useBranding precisa do BrandingProvider");
  return context;
}
