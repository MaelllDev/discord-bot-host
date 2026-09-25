import type { ReactNode } from "react";
import { DEPLOY_PHASES, phaseStates } from "../deployPhases.ts";
import { useI18n } from "../i18n/index.tsx";
import { cn } from "./ui.tsx";
import { IconCheck, IconClose } from "./icons.tsx";

function Marker({ state, failed }: { state: "done" | "active" | "pending"; failed: boolean }) {
  if (state === "done") {
    return (
      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-600/80 text-white">
        <IconCheck className="h-3 w-3" />
      </span>
    );
  }
  if (state === "active") {
    return (
      <span
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded-full border-2 border-t-transparent",
          failed ? "border-rose-500 text-rose-400" : "animate-spin border-indigo-400",
        )}
      >
        {failed ? <IconClose className="h-2.5 w-2.5" /> : null}
      </span>
    );
  }
  return <span className="h-4 w-4 rounded-full border border-white/10" />;
}

/**
 * Mostra as etapas do deploy conforme o log real devolvido pela API. Usado no
 * assistente de nova aplicação e na atualização de código.
 */
export default function DeployProgress({
  log,
  finished,
  failed,
  extra,
}: {
  log: string;
  finished: boolean;
  failed: boolean;
  extra?: ReactNode;
}) {
  const { t } = useI18n();
  const states = phaseStates(log, finished, failed);
  return (
    <div className="space-y-3">
      <ol className="space-y-1.5">
        {DEPLOY_PHASES.map((phase, index) => {
          const state = states[index] ?? "pending";
          return (
            <li key={phase.titleKey} className="flex items-center gap-2 text-xs">
              <Marker state={state} failed={failed && state === "active"} />
              <span
                className={cn(
                  state === "pending" ? "text-slate-500" : state === "active" ? "text-slate-100" : "text-slate-400",
                  failed && state === "active" && "text-rose-300",
                )}
              >
                {t(phase.titleKey)}
              </span>
            </li>
          );
        })}
      </ol>
      {extra}
    </div>
  );
}
