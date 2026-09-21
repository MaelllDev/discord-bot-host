import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { IconAlert, IconCheck, IconClose } from "./icons.tsx";
import { cn } from "./ui.tsx";

type ToastTone = "success" | "error" | "info";

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONES: Record<ToastTone, { card: string; tile: string }> = {
  success: {
    card: "border-emerald-400/20",
    tile: "border-emerald-400/25 bg-emerald-500/12 text-emerald-300",
  },
  error: {
    card: "border-rose-400/20",
    tile: "border-rose-400/25 bg-rose-500/12 text-rose-300",
  },
  info: {
    card: "border-white/10",
    tile: "border-indigo-400/25 bg-indigo-500/12 text-indigo-300",
  },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-3), { id, tone, message }]);
      const timer = window.setTimeout(() => dismiss(id), tone === "error" ? 8000 : 4500);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  const value = useMemo<ToastApi>(
    () => ({
      success: (message) => push("success", message),
      error: (message) => push("error", message),
      info: (message) => push("info", message),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={cn(
              "pop-in pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border bg-slate-900 p-3.5 shadow-[0_24px_48px_-24px_rgb(0_0_0/0.9)]",
              TONES[toast.tone].card,
            )}
          >
            <span
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border",
                TONES[toast.tone].tile,
              )}
            >
              {toast.tone === "success" ? <IconCheck className="h-4 w-4" /> : <IconAlert className="h-4 w-4" />}
            </span>
            <p className="flex-1 pt-1 text-xs leading-relaxed text-slate-200">{toast.message}</p>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="shrink-0 rounded-sm p-1 text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-200"
              aria-label="Fechar notificação"
            >
              <IconClose className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast precisa do ToastProvider");
  return context;
}
