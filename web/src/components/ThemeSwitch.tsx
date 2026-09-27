import type { ComponentType } from "react";
import { useI18n } from "../i18n/index.tsx";
import { THEMES, useTheme } from "../theme.tsx";
import type { Theme } from "../theme.tsx";
import { cn } from "./ui.tsx";
import { IconArchive, IconMoon, IconSun } from "./icons.tsx";

/**
 * Seletor de tema: claro, escuro e legacy. Usa exatamente o desenho do controle
 * segmentado do sistema (as mesmas classes de `<Tabs>`), então não introduz
 * nenhum elemento visual novo — só troca de tema na hora, sem recarregar.
 *
 * `compact` mostra só o ícone de cada tema (barra superior e login); sem ele, o
 * nome escrito (Configurações).
 */
const ICONS: Record<Theme, ComponentType<{ className?: string }>> = {
  light: IconSun,
  dark: IconMoon,
  legacy: IconArchive,
};

export default function ThemeSwitch({
  compact,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();

  const label = (item: Theme): string => {
    if (item === "dark") return t("theme.dark");
    if (item === "legacy") return t("theme.legacy");
    return t("theme.light");
  };

  return (
    <div
      role="group"
      aria-label={t("theme.title")}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-md border border-white/10 bg-slate-950/60 p-0.5",
        className,
      )}
    >
      {THEMES.map((item) => {
        const active = theme === item;
        const Icon = ICONS[item];
        return (
          <button
            key={item}
            type="button"
            onClick={() => setTheme(item)}
            aria-pressed={active}
            aria-label={label(item)}
            title={t("theme.switchTo", { name: label(item) })}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-[11px] font-medium transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50",
              active
                ? "tab-active-ring bg-slate-800 text-white"
                : "text-slate-400 hover:text-slate-200",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {compact ? null : label(item)}
          </button>
        );
      })}
    </div>
  );
}
