import { LANGUAGES, LANGUAGE_NAMES, LANGUAGE_SHORT, useI18n } from "../i18n/index.tsx";
import { cn } from "./ui.tsx";

/**
 * Seletor de idioma. Usa exatamente o mesmo desenho do controle segmentado do
 * sistema de design (mesmas classes de `<Tabs>`), então não introduz nenhum
 * elemento visual novo — só troca de idioma na hora, sem recarregar a página.
 *
 * `compact` mostra "PT"/"EN" (barra superior); sem ele, o nome do idioma
 * escrito nele mesmo (Configurações).
 */
export default function LanguageSwitch({
  compact,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const { language, setLanguage, t } = useI18n();

  return (
    <div
      role="group"
      aria-label={t("language.title")}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-md border border-white/10 bg-slate-950/60 p-0.5",
        className,
      )}
    >
      {LANGUAGES.map((item) => {
        const active = language === item;
        return (
          <button
            key={item}
            type="button"
            onClick={() => setLanguage(item)}
            aria-pressed={active}
            title={LANGUAGE_NAMES[item]}
            className={cn(
              "rounded-sm px-2 py-1 text-[11px] font-medium transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50",
              active
                ? "bg-slate-800 text-white shadow-[0_0_0_1px_rgb(255_255_255/0.06)]"
                : "text-slate-400 hover:text-slate-200",
            )}
          >
            {compact ? LANGUAGE_SHORT[item] : LANGUAGE_NAMES[item]}
          </button>
        );
      })}
    </div>
  );
}
