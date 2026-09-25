import type { ButtonHTMLAttributes, ComponentPropsWithRef, ReactNode } from "react";
import { statusLabel } from "../format.ts";
import { useI18n } from "../i18n/index.tsx";
import { IconAlert, IconCheck } from "./icons.tsx";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export const inputClass =
  "h-9 w-full rounded-md border border-white/10 bg-slate-950/60 px-3 text-sm text-slate-100 outline-none transition-colors duration-200 placeholder:text-slate-500 hover:border-white/20 focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-500/25 disabled:cursor-not-allowed disabled:opacity-50";

export const textareaClass = cn(
  inputClass,
  "h-auto min-h-24 resize-y py-2 font-mono text-xs leading-relaxed",
);

type ButtonVariant = "primary" | "secondary" | "outline" | "danger" | "ghost" | "success";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-indigo-600 text-white shadow-[0_10px_26px_-14px_rgb(124_92_255/0.95)] hover:bg-indigo-500 focus-visible:ring-indigo-400/60",
  secondary:
    "border border-white/10 bg-white/[0.04] text-slate-100 hover:border-white/20 hover:bg-white/[0.08] focus-visible:ring-white/30",
  outline:
    "border border-white/10 bg-slate-950/50 text-slate-200 hover:border-white/20 hover:bg-white/[0.06] focus-visible:ring-white/30",
  danger:
    "border border-rose-500/30 bg-rose-500/10 text-rose-200 hover:border-rose-500/40 hover:bg-rose-500/20 hover:text-rose-100 focus-visible:ring-rose-400/50",
  ghost: "text-slate-300 hover:bg-white/[0.06] hover:text-white focus-visible:ring-white/30",
  success:
    "bg-emerald-600 text-white shadow-[0_10px_26px_-14px_rgb(16_185_129/0.9)] hover:bg-emerald-500 focus-visible:ring-emerald-400/60",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 active:scale-[0.985] disabled:pointer-events-none disabled:opacity-50",
        BUTTON_SIZES[size],
        BUTTON_VARIANTS[variant],
        className,
      )}
    >
      {loading ? <Spinner className="h-3.5 w-3.5" /> : null}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block animate-spin rounded-full border-2 border-current border-t-transparent",
        className ?? "h-4 w-4",
      )}
      aria-hidden="true"
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span className={cn("skeleton block", className ?? "h-4 w-full")} />;
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card space-y-3 p-5">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-5 w-24" />
      </div>
      <Skeleton className="h-3 w-48" />
      <div className="space-y-2 pt-1">
        {Array.from({ length: lines }).map((_, index) => (
          <Skeleton key={index} className="h-2 w-full" />
        ))}
      </div>
    </div>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2.5 p-5">
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-4 w-full" />
      ))}
    </div>
  );
}

type BadgeTone = "slate" | "green" | "red" | "amber" | "indigo" | "sky";

const BADGE_TONES: Record<BadgeTone, string> = {
  slate: "border-white/10 bg-white/[0.04] text-slate-300",
  green: "border-emerald-400/25 bg-emerald-500/10 text-emerald-300",
  red: "border-rose-400/25 bg-rose-500/10 text-rose-300",
  amber: "border-amber-400/25 bg-amber-500/10 text-amber-200",
  indigo: "border-indigo-400/25 bg-indigo-500/12 text-indigo-200",
  sky: "border-sky-400/25 bg-sky-500/10 text-sky-200",
};

export function Badge({
  tone = "slate",
  children,
  className,
  pill,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  /** Etiqueta curta em caixa alta, para rótulos como “novo” e “beta”. */
  pill?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 border font-medium",
        pill ? "rounded-sm px-1.5 py-0.5 text-[10px] uppercase tracking-wide" : "rounded-md px-2 py-0.5 text-[11px]",
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function statusTone(status: string): BadgeTone {
  switch (status) {
    case "running":
      return "green";
    case "starting":
    case "restarting":
    case "deploying":
      return "amber";
    case "crashed":
      return "red";
    case "paused":
      return "sky";
    default:
      return "slate";
  }
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={statusTone(status)}>
      <span className="relative flex h-1.5 w-1.5">
        <span
          className={cn(
            "absolute inline-flex h-full w-full rounded-full",
            status === "running" ? "animate-ping bg-emerald-400" : "bg-current opacity-70",
          )}
        />
        <span
          className={cn(
            "relative inline-flex h-1.5 w-1.5 rounded-full",
            status === "running" ? "bg-emerald-400" : "bg-current",
          )}
        />
      </span>
      {statusLabel(status)}
    </Badge>
  );
}

/** Cabeçalho de página: título grande, contexto e ações à direita. */
export function PageHeader({
  title,
  subtitle,
  actions,
  icon,
  breadcrumb,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  breadcrumb?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3">
      {breadcrumb}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          {icon ? <span className="icon-tile icon-tile-md">{icon}</span> : null}
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight text-slate-50 sm:text-2xl">{title}</h1>
            {subtitle ? <p className="mt-1 text-xs leading-relaxed text-slate-500">{subtitle}</p> : null}
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

/** Título de seção dentro da página, com ação opcional à direita. */
export function SectionHeader({ title, action, hint }: { title: ReactNode; action?: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight text-slate-100">{title}</h2>
        {hint ? <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
  footer,
  icon,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  footer?: ReactNode;
  icon?: ReactNode;
}) {
  // Quem passa o próprio padding no corpo (tabelas, listas) não recebe o padrão.
  const bodyPadding = bodyClassName && /\bp[xy]?-/.test(bodyClassName) ? "" : "p-5";
  return (
    <section className={cn("card overflow-hidden", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            {icon ? <span className="icon-tile icon-tile-sm icon-tile-neutral">{icon}</span> : null}
            <div className="min-w-0">
              {title ? (
                <h2 className="truncate text-sm font-semibold tracking-tight text-slate-100">{title}</h2>
              ) : null}
              {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
            </div>
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      )}
      <div className={cn(bodyPadding, bodyClassName)}>{children}</div>
      {footer ? (
        <footer className="border-t border-white/8 bg-slate-950/40 px-5 py-3.5">{footer}</footer>
      ) : null}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block space-y-1.5", className)}>
      <span className="block text-xs font-medium text-slate-300">{label}</span>
      {children}
      {hint ? <span className="block text-[11px] leading-snug text-slate-500">{hint}</span> : null}
    </label>
  );
}

export function Input(props: ComponentPropsWithRef<"input">) {
  return <input {...props} className={cn(inputClass, props.className)} />;
}

export function Textarea(props: ComponentPropsWithRef<"textarea">) {
  return <textarea {...props} className={cn(textareaClass, props.className)} />;
}

export function Select(props: ComponentPropsWithRef<"select">) {
  return <select {...props} className={cn(inputClass, "pr-8", props.className)} />;
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        "group flex items-start gap-2.5 rounded-md text-left text-xs text-slate-300 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-indigo-400/50",
        disabled && "opacity-60",
      )}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
    >
      <span
        className={cn(
          "relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors duration-200",
          checked ? "border-indigo-400/50 bg-indigo-500" : "border-white/10 bg-slate-800 group-hover:bg-slate-700",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-all duration-200",
            checked ? "left-[1.15rem]" : "left-0.5",
          )}
        />
      </span>
      {label}
    </button>
  );
}

const METER_TONES = {
  indigo: "bg-indigo-500",
  amber: "bg-amber-500",
  red: "bg-rose-500",
  green: "bg-emerald-500",
  sky: "bg-sky-500",
} as const;

type MeterTone = keyof typeof METER_TONES;

export function ProgressBar({ percent, tone = "indigo" }: { percent: number; tone?: MeterTone }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
      <div
        className={cn("h-full rounded-full transition-all duration-300", METER_TONES[tone])}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

/** Linha "rótulo — valor" com barra de progresso, usada em métricas. */
export function Meter({
  label,
  value,
  hint,
  percent,
  tone = "indigo",
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  percent: number;
  tone?: MeterTone;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[11px]">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono text-slate-200 tabular-nums">{value}</span>
      </div>
      <ProgressBar percent={percent} tone={tone} />
      {hint ? <p className="text-[10.5px] leading-snug text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function Alert({
  tone = "slate",
  children,
  icon,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  icon?: ReactNode;
}) {
  const tones: Record<BadgeTone, string> = {
    slate: "border-white/10 bg-white/[0.04] text-slate-300",
    green: "border-emerald-400/20 bg-emerald-500/10 text-emerald-200",
    red: "border-rose-400/20 bg-rose-500/10 text-rose-200",
    amber: "border-amber-400/20 bg-amber-500/10 text-amber-200",
    indigo: "border-indigo-400/20 bg-indigo-500/10 text-indigo-200",
    sky: "border-sky-400/20 bg-sky-500/10 text-sky-200",
  };
  const fallback =
    tone === "green" ? (
      <IconCheck className="h-3.5 w-3.5" />
    ) : tone === "slate" ? null : (
      <IconAlert className="h-3.5 w-3.5" />
    );
  const glyph = icon ?? fallback;
  return (
    <div className={cn("flex items-start gap-2.5 rounded-md border px-3.5 py-2.5 text-xs leading-relaxed", tones[tone])}>
      {glyph ? <span className="mt-0.5 shrink-0">{glyph}</span> : null}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const { t } = useI18n();
  if (!open) return null;
  return (
    <div
      className="fade-in fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/80 p-4 backdrop-blur-md sm:p-8"
      role="dialog"
      aria-modal="true"
    >
      <div className={cn("card pop-in my-auto w-full", wide ? "max-w-3xl" : "max-w-xl")}>
        <header className="flex items-center justify-between gap-3 border-b border-white/8 px-5 py-3.5">
          <h2 className="min-w-0 truncate text-sm font-semibold tracking-tight text-slate-100">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label={t("common.close")}>
            ✕
          </Button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto p-5">{children}</div>
        {footer ? (
          <footer className="flex justify-end gap-2 border-t border-white/8 bg-slate-950/40 px-5 py-3.5">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

/** Controle segmentado: a aba ativa parece uma peça encaixada. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="inline-flex flex-wrap items-center gap-1 rounded-md border border-white/10 bg-slate-950/60 p-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={cn(
            "rounded-sm px-3 py-1.5 text-xs font-medium transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50",
            value === tab.id
              ? "bg-slate-800 text-white shadow-[0_0_0_1px_rgb(255_255_255/0.06)]"
              : "text-slate-400 hover:text-slate-200",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed border-white/12 bg-slate-900/40 px-6 py-12 text-center">
      {icon ? <span className="icon-tile icon-tile-lg">{icon}</span> : null}
      <p className="text-sm font-medium text-slate-200">{title}</p>
      {description ? <p className="max-w-md text-xs leading-relaxed text-slate-500">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

const TILE_TONES = {
  accent: "icon-tile",
  neutral: "icon-tile icon-tile-neutral",
  green: "icon-tile border-emerald-400/20 bg-emerald-500/10 text-emerald-300",
  red: "icon-tile border-rose-400/20 bg-rose-500/10 text-rose-300",
  amber: "icon-tile border-amber-400/20 bg-amber-500/10 text-amber-200",
  sky: "icon-tile border-sky-400/20 bg-sky-500/10 text-sky-200",
} as const;

/** Métrica em tile: bloco de ícone, número grande e rótulo com descrição. */
export function StatTile({
  label,
  value,
  hint,
  icon,
  tone = "accent",
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: keyof typeof TILE_TONES;
}) {
  return (
    <div className="card card-interactive flex flex-col gap-3.5 p-4">
      <div className="flex items-start justify-between gap-3">
        {icon ? <span className={TILE_TONES[tone]}>{icon}</span> : null}
        <p className="text-2xl font-semibold tracking-tight text-slate-50 tabular-nums">{value}</p>
      </div>
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium text-slate-200">{label}</p>
        {hint ? <p className="text-[11px] leading-snug text-slate-500">{hint}</p> : null}
      </div>
    </div>
  );
}

/** `Kpi` é o nome histórico do tile de métrica. */
export const Kpi = StatTile;

/** Bloco de destaque no topo de uma página (boas-vindas, onboarding). */
export function Hero({
  badge,
  title,
  description,
  actions,
  footnote,
  children,
}: {
  badge?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footnote?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="hero-card p-6 sm:p-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-indigo-500/20 blur-3xl"
      />
      <div className="relative flex flex-col gap-7">
        <div className="flex max-w-2xl flex-col gap-3">
          {badge ? (
            <span className="inline-flex w-fit items-center gap-1.5 rounded-sm border border-indigo-400/30 bg-indigo-500/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-indigo-200">
              {badge}
            </span>
          ) : null}
          <h2 className="text-2xl font-bold tracking-tight text-balance text-slate-50 sm:text-3xl">{title}</h2>
          {description ? (
            <p className="text-sm leading-relaxed text-pretty text-slate-400">{description}</p>
          ) : null}
          {actions ? <div className="mt-1 flex flex-wrap items-center gap-2">{actions}</div> : null}
          {footnote ? <p className="text-[11px] text-slate-500">{footnote}</p> : null}
        </div>
        {children}
      </div>
    </section>
  );
}

/** Tile menor, usado nas grades de recursos do bloco de destaque. */
export function FeatureTile({
  title,
  description,
  icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-white/8 bg-slate-950/40 p-3.5">
      {icon ? <span className="icon-tile icon-tile-sm">{icon}</span> : null}
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-semibold text-slate-100">{title}</span>
        {description ? <span className="text-[11px] leading-relaxed text-slate-500">{description}</span> : null}
      </div>
    </div>
  );
}

export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-sm border border-white/10 bg-slate-950/70 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">
      {children}
    </code>
  );
}

export function DescriptionList({ items }: { items: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-4 text-xs sm:grid-cols-2">
      {items.map((item, index) => (
        <div key={index} className="min-w-0">
          <dt className="text-[11px] uppercase tracking-wide text-slate-500">{item.label}</dt>
          <dd className="mt-1 break-words text-slate-200">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
