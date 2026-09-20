import { useState } from "react";
import { Link } from "react-router-dom";
import type { AppSummary } from "../types.ts";
import { api } from "../api.ts";
import { errorText } from "../hooks.ts";
import { humanBytes, humanCpu, humanDuration, humanRam, relativeTime, runtimeLabel } from "../format.ts";
import { Alert, Badge, Button, Meter, StatusBadge } from "./ui.tsx";
import AppIcon from "./AppIcon.tsx";
import { IconPlay, IconRestart, IconStop } from "./icons.tsx";
import { useToast } from "./Toasts.tsx";

export function isLive(status: string): boolean {
  return status === "running" || status === "starting" || status === "restarting";
}

export default function AppCard({ app, onChanged }: { app: AppSummary; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const run = async (action: "start" | "stop" | "restart"): Promise<void> => {
    setBusy(action);
    setError(null);
    try {
      await api.action(app.slug, action);
      const label = action === "start" ? "iniciada" : action === "stop" ? "parada" : "reiniciada";
      toast.success(`Aplicação "${app.name}" ${label}.`);
      onChanged();
    } catch (caught) {
      const message = errorText(caught);
      setError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  };

  const live = isLive(app.status);
  const resources = app.resources;
  const cpuPercentOfLimit = resources ? Math.min(100, (resources.cpuPercent / Math.max(app.cpu, 0.1)) * 100) : 0;

  return (
    <div className="card card-interactive flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <AppIcon app={app} size="lg" />
          <div className="min-w-0">
            <Link to={`/apps/${app.slug}`} className="block truncate text-sm font-semibold text-slate-100 hover:text-indigo-300">
              {app.name}
            </Link>
            <p className="truncate text-[11px] text-slate-500">
              <span className="font-mono">{app.slug}</span> · {runtimeLabel(app.runtime)}
            </p>
          </div>
        </div>
        <StatusBadge status={app.status} />
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Badge tone="indigo">{runtimeLabel(app.runtime)}</Badge>
        <Badge>{humanCpu(app.cpu)}</Badge>
        <Badge>{humanRam(app.memoryMb)}</Badge>
        {app.activeRelease > 0 ? <Badge tone="sky">v{app.activeRelease}</Badge> : <Badge tone="amber">sem versão</Badge>}
        {live && resources ? <Badge>up {humanDuration(resources.uptimeSeconds)}</Badge> : null}
        {app.status === "unknown" ? <Badge tone="red">Docker inacessível</Badge> : null}
      </div>

      <div className="space-y-2.5">
        <Meter
          label="CPU"
          value={resources ? `${resources.cpuPercent.toFixed(1)}% de ${humanCpu(app.cpu)}` : "sem dados"}
          percent={cpuPercentOfLimit}
          tone={cpuPercentOfLimit > 80 ? "amber" : "indigo"}
        />
        <Meter
          label="Memória"
          value={
            resources
              ? `${humanBytes(resources.memoryBytes)} de ${humanRam(app.memoryMb)}`
              : `limite ${humanRam(app.memoryMb)}`
          }
          percent={resources?.memoryPercent ?? 0}
          tone={(resources?.memoryPercent ?? 0) > 85 ? "red" : (resources?.memoryPercent ?? 0) > 65 ? "amber" : "green"}
        />
      </div>

      <p className="text-[11px] text-slate-500">Atualizada {relativeTime(app.updatedAt)}</p>

      {error ? <Alert tone="red">{error}</Alert> : null}

      <div className="mt-auto flex flex-wrap gap-2">
        {live ? (
          <Button size="sm" loading={busy === "stop"} onClick={() => void run("stop")}>
            <IconStop className="h-3.5 w-3.5" /> Parar
          </Button>
        ) : (
          <Button size="sm" variant="success" loading={busy === "start"} onClick={() => void run("start")}>
            <IconPlay className="h-3.5 w-3.5" /> Iniciar
          </Button>
        )}
        <Button size="sm" loading={busy === "restart"} onClick={() => void run("restart")} disabled={!live}>
          <IconRestart className="h-3.5 w-3.5" /> Reiniciar
        </Button>
        <Link to={`/apps/${app.slug}`} className="ml-auto">
          <Button size="sm" variant="ghost">
            Gerenciar →
          </Button>
        </Link>
      </div>
    </div>
  );
}
