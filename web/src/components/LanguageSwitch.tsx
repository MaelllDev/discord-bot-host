import { useEffect, useRef, useState } from "react";
import { LANGUAGES, LANGUAGE_NAMES, useI18n } from "../i18n/index.tsx";
import { cn } from "./ui.tsx";
import { IconCheck, IconGlobe } from "./icons.tsx";

/**
 * Seletor de idioma: um botão de globo que abre a lista. Fecha ao escolher, ao
 * clicar fora e no Esc — o idioma ativo fica marcado com um "check".
 *
 * `compact` mostra só o globo (barra superior, login e sidebar); sem ele, o
 * botão também exibe o nome do idioma atual (Configurações). `direction="up"`
 * abre a lista para cima, para quem vive no rodapé da sidebar.
 */
export default function LanguageSwitch({
  compact,
  className,
  direction = "down",
}: {
  compact?: boolean;
  className?: string;
  direction?: "up" | "down";
}) {
  const { language, setLanguage, t } = useI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("language.title")}
        title={t("language.title")}
        className={cn(
          "inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border border-white/10 bg-slate-950/60 px-2 text-[11px] font-medium text-slate-300 transition-colors outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-indigo-400/50",
          (open || !compact) && "text-white",
        )}
      >
        <IconGlobe className="h-3.5 w-3.5 shrink-0" />
        {compact ? null : <span className="truncate">{LANGUAGE_NAMES[language]}</span>}
      </button>

      {open ? (
        <div
          role="menu"
          aria-label={t("language.title")}
          className={cn(
            "card pop-in absolute left-0 z-50 min-w-40 p-1",
            direction === "up" ? "bottom-full mb-2" : "top-full mt-2",
          )}
        >
          {LANGUAGES.map((item) => {
            const active = language === item;
            return (
              <button
                key={item}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  setLanguage(item);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-xs transition-colors outline-none",
                  active
                    ? "bg-indigo-500/15 text-white"
                    : "text-slate-300 hover:bg-white/[0.06] hover:text-white",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{LANGUAGE_NAMES[item]}</span>
                {active ? <IconCheck className="h-3.5 w-3.5 shrink-0" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
