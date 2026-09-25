import { useI18n } from "../i18n/index.tsx";
import { cn } from "./ui.tsx";
import { IconHeart } from "./icons.tsx";

/**
 * Autor do projeto. Os créditos ficam visíveis no painel porque o BotPanel é
 * distribuído para self-host: quem instala precisa saber de quem é o projeto.
 */
export const CREATOR = {
  name: "MaelllDev",
  github: "https://github.com/MaelllDev",
  discord: "https://discord.com/invite/xykJqCUeNt",
  youtube: "https://www.youtube.com/@ManoshzDev",
  instagram: "https://www.instagram.com/omaelldev/",
} as const;

export const CREATOR_LINKS: { label: string; href: string }[] = [
  { label: "GitHub", href: CREATOR.github },
  { label: "Discord", href: CREATOR.discord },
  { label: "YouTube", href: CREATOR.youtube },
  { label: "Instagram", href: CREATOR.instagram },
];

/** Página de apoio ao projeto (Pix). */
export const SUPPORT_URL = "https://pixgg.com/maelldev";

/**
 * Botão de doação. Abre em outra aba e não envia o caminho do painel como
 * referer — é um link externo como qualquer outro crédito.
 */
export function SupportLink({
  className,
  compact,
  iconOnly,
}: {
  className?: string;
  compact?: boolean;
  /** Só o coração (sidebar minimizada), sem o texto. */
  iconOnly?: boolean;
}) {
  const { t } = useI18n();
  return (
    <a
      href={SUPPORT_URL}
      target="_blank"
      rel="noreferrer noopener"
      title={t("credits.support.title")}
      className={cn(
        "inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-amber-400/25 bg-amber-500/10 font-medium text-amber-100 transition hover:bg-amber-500/20",
        compact ? "px-2.5 py-2 text-[11px]" : "px-3.5 py-2 text-xs",
        iconOnly && "lg:px-0",
        className,
      )}
    >
      <IconHeart className="h-3.5 w-3.5" />
      <span className={cn(iconOnly && "lg:hidden")}>{t("credits.support.label")}</span>
    </a>
  );
}

/** Links do criador como “pílulas” (usado na página de Configurações). */
export function CreatorLinks({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {CREATOR_LINKS.map((link) => (
        <a
          key={link.href}
          href={link.href}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-slate-800/60 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:border-indigo-700 hover:bg-indigo-950/40 hover:text-indigo-200"
        >
          {link.label}
          <span aria-hidden="true" className="text-[10px] text-slate-500">
            ↗
          </span>
        </a>
      ))}
    </div>
  );
}

/** Linha compacta de crédito, para o rodapé da sidebar. */
export function CreatorCredit({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <p className={cn("text-[10.5px] leading-relaxed text-slate-600", className)}>
      {t("credits.createdBy")}{" "}
      <a
        href={CREATOR.github}
        target="_blank"
        rel="noreferrer noopener"
        className="font-medium text-slate-400 transition hover:text-indigo-300"
      >
        {CREATOR.name}
      </a>{" "}
      ·{" "}
      {CREATOR_LINKS.map((link, index) => (
        <span key={link.href}>
          {index > 0 ? " · " : null}
          <a
            href={link.href}
            target="_blank"
            rel="noreferrer noopener"
            className="transition hover:text-slate-300"
          >
            {link.label}
          </a>
        </span>
      ))}
    </p>
  );
}
