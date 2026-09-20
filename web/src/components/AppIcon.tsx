import { useEffect, useState } from "react";
import { cn } from "./ui.tsx";
import { runtimeLabel } from "../format.ts";

type IconSize = "sm" | "md" | "lg" | "xl";

const SIZES: Record<IconSize, string> = {
  sm: "h-8 w-8 rounded-lg text-[11px]",
  md: "h-10 w-10 rounded-xl text-sm",
  lg: "h-14 w-14 rounded-2xl text-lg",
  xl: "h-20 w-20 rounded-3xl text-2xl",
};

/**
 * Ícone da aplicação: usa a URL configurada e, quando ela está vazia ou falha ao
 * carregar, cai para as iniciais do nome — assim nunca aparece um “quadrado
 * quebrado” na interface.
 */
export default function AppIcon({
  app,
  size = "md",
  className,
}: {
  app: { name: string; iconUrl?: string; runtime: string };
  size?: IconSize;
  className?: string;
}) {
  const url = (app.iconUrl ?? "").trim();
  const [failed, setFailed] = useState(false);

  // Ao trocar a URL (ou de aplicação), tenta carregar de novo.
  useEffect(() => setFailed(false), [url]);

  if (url.length > 0 && !failed) {
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        // A imagem vem de um host externo: não vaza a URL do painel no referer.
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn("shrink-0 border border-white/10 bg-slate-950/60 object-cover", SIZES[size], className)}
      />
    );
  }

  const initials =
    app.name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?";

  return (
    <span
      title={runtimeLabel(app.runtime)}
      className={cn(
        "flex shrink-0 items-center justify-center border border-white/10 bg-gradient-to-br from-indigo-500/30 via-violet-500/15 to-transparent font-semibold text-indigo-100",
        SIZES[size],
        className,
      )}
    >
      {initials}
    </span>
  );
}
