import type { ButtonHTMLAttributes, ComponentPropsWithRef, ReactNode } from "react";
import { statusLabel } from "../format.ts";
import { IconAlert, IconCheck } from "./icons.tsx";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export const inputClass =
  "w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-indigo-400/60 focus:ring-4 focus:ring-indigo-500/15 disabled:cursor-not-allowed disabled:opacity-50";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "success";
type ButtonSize = "sm" | "md";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-950/40 hover:from-indigo-400 hover:to-violet-400",
  secondary: "border border-white/10 bg-white/5 text-slate-200 hover:border-white/20 hover:bg-white/10",
  danger: "border border-rose-500/25 bg-rose-500/10 text-rose-200 hover:border-rose-500/40 hover:bg-rose-500/20",
  ghost: "text-slate-300 hover:bg-white/5",
  success:
    "bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-lg shadow-emerald-950/40 hover:from-emerald-400 hover:to-teal-400",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export function Button({ variant = "secondary", size = "md", loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400/70 disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm",
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
      className={cn("inline-block animate-spin rounded-full border-2 border-current border-t-transparent", className ?? "h-4 w-4")}
      aria-hidden="true"
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span className={cn("block animate-pulse rounded-md bg-slate-800/80", className ?? "h-4 w-full")} />;
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card space-y-3 p-4">
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
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-4 w-full" />
      ))}
    </div>
  );
}

type BadgeTone = "slate" | "green" | "red" | "amber" | "indigo" | "sky";

const BADGE_TONES: Record<BadgeTone, string> = {
  slate: "border-white/10 bg-white/5 text-slate-300",
  green: "border-emerald-400/25 bg-emerald-500/10 text-emerald-300",
  red: "border-rose-400/25 bg-rose-500/10 text-rose-300",
  amber: "border-amber-400/25 bg-amber-500/10 text-amber-200",
  indigo: "border-indigo-400/25 bg-indigo-500/10 text-indigo-200",
  sky: "border-sky-400/25 bg-sky-500/10 text-sky-200",
};

export function Badge({ tone = "slate", children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] font-medium", BADGE_TONES[tone], className)}>
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
        <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", status === "running" ? "bg-emerald-400" : "bg-current")} />
      </span>
      {statusLabel(status)}
    </Badge>
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
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  footer?: ReactNode;
}) {
  return (
    <section className={cn("card overflow-hidden", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 px-4 py-3">
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-semibold text-slate-100">{title}</h2> : null}
            {subtitle ? <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      )}
      <div className={cn("p-4", bodyClassName)}>{children}</div>
      {footer ? <footer className="border-t border-white/5 px-4 py-3">{footer}</footer> : null}
    </section>
  );
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
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
  return <textarea {...props} className={cn(inputClass, "font-mono text-xs", props.className)} />;
}

export function Select(props: ComponentPropsWithRef<"select">) {
  return <select {...props} className={cn(inputClass, props.className)} />;
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn("flex items-start gap-2 text-left text-xs text-slate-300", disabled && "opacity-60")}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
    >
      <span
        className={cn(
          "relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition",
          checked ? "border-emerald-400/50 bg-emerald-500/80" : "border-white/10 bg-slate-800",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all",
            checked ? "left-[1.15rem]" : "left-0.5",
          )}
        />
      </span>
      {label}
    </button>
  );
}

export function ProgressBar({ percent, tone = "indigo" }: { percent: number; tone?: "indigo" | "amber" | "red" | "green" | "sky" }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const colors = {
    indigo: "bg-indigo-500",
    amber: "bg-amber-500",
    red: "bg-rose-500",
    green: "bg-emerald-500",
    sky: "bg-sky-500",
  } as const;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
      <div className={cn("h-full rounded-full transition-all", colors[tone])} style={{ width: `${clamped}%` }} />
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
  tone?: "indigo" | "amber" | "red" | "green" | "sky";
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[11px]">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono text-slate-300">{value}</span>
      </div>
      <ProgressBar percent={percent} tone={tone} />
      {hint ? <p className="text-[10.5px] text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function Alert({ tone = "slate", children, icon }: { tone?: BadgeTone; children: ReactNode; icon?: ReactNode }) {
  const tones: Record<BadgeTone, string> = {
    slate: "border-white/10 bg-white/5 text-slate-300",
    green: "border-emerald-400/20 bg-emerald-500/10 text-emerald-200",
    red: "border-rose-400/20 bg-rose-500/10 text-rose-200",
    amber: "border-amber-400/20 bg-amber-500/10 text-amber-200",
    indigo: "border-indigo-400/20 bg-indigo-500/10 text-indigo-200",
    sky: "border-sky-400/20 bg-sky-500/10 text-sky-200",
  };
  const fallback = tone === "green" ? <IconCheck className="h-3.5 w-3.5" /> : tone === "slate" ? null : <IconAlert className="h-3.5 w-3.5" />;
  const glyph = icon ?? fallback;
  return (
    <div className={cn("flex items-start gap-2 rounded-xl border px-3 py-2 text-xs leading-relaxed", tones[tone])}>
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
  if (!open) return null;
  return (
    <div
      className="fade-in fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/80 p-4 backdrop-blur-sm sm:p-8"
      role="dialog"
      aria-modal="true"
    >
      <div className={cn("card pop-in my-auto w-full", wide ? "max-w-3xl" : "max-w-xl")}>
        <header className="flex items-center justify-between border-b border-white/5 px-4 py-3">
          <h2 className="min-w-0 truncate text-sm font-semibold text-slate-100">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Fechar">
            ✕
          </Button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
        {footer ? <footer className="flex justify-end gap-2 border-t border-slate-800 px-4 py-3">{footer}</footer> : null}
      </div>
    </div>
  );
}

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
    <div className="flex flex-wrap gap-1 rounded-xl border border-white/10 bg-slate-950/40 p-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={cn(
            "rounded-lg px-3 py-1.5 text-xs font-medium transition",
            value === tab.id
              ? "bg-gradient-to-r from-indigo-500/25 to-violet-500/20 text-white ring-1 ring-inset ring-white/10"
              : "text-slate-400 hover:bg-white/5 hover:text-slate-200",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-800 px-6 py-10 text-center">
      <p className="text-sm font-medium text-slate-300">{title}</p>
      {description ? <p className="max-w-md text-xs text-slate-500">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Kpi({ label, value, hint, icon }: { label: ReactNode; value: ReactNode; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="card relative overflow-hidden px-4 py-3.5">
      <div className="pointer-events-none absolute inset-x-0 -top-16 h-24 bg-gradient-to-b from-indigo-500/15 to-transparent" />
      <p className="relative flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-slate-400">
        {icon ? <span className="text-indigo-300">{icon}</span> : null}
        {label}
      </p>
      <p className="relative mt-1.5 text-2xl font-semibold tracking-tight text-slate-50">{value}</p>
      {hint ? <p className="relative text-[11px] text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function InlineCode({ children }: { children: ReactNode }) {
  return <code className="rounded bg-slate-800/80 px-1 py-0.5 font-mono text-[11px] text-slate-300">{children}</code>;
}

export function DescriptionList({ items }: { items: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className="grid gap-3 text-xs sm:grid-cols-2">
      {items.map((item, index) => (
        <div key={index} className="min-w-0">
          <dt className="text-slate-500">{item.label}</dt>
          <dd className="mt-0.5 break-words text-slate-200">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
