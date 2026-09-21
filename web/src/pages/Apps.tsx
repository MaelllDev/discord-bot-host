import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.ts";
import { useAsync, errorText } from "../hooks.ts";
import type { AppSummary } from "../types.ts";
import { humanBytes, humanCpu, humanRam, relativeTime, runtimeLabel } from "../format.ts";
import AppCard, { isLive } from "../components/AppCard.tsx";
import { useToast } from "../components/Toasts.tsx";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  PageHeader,
  Select,
  SkeletonRows,
  StatusBadge,
  cn,
} from "../components/ui.tsx";
import AppIcon from "../components/AppIcon.tsx";
import { IconApps, IconPlay, IconPlus, IconRestart, IconSearch, IconStop } from "../components/icons.tsx";

type Filter = "all" | "online" | "stopped" | "unknown";

function matches(app: AppSummary, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "online") return isLive(app.status);
  if (filter === "unknown") return app.status === "unknown";
  return !isLive(app.status) && app.status !== "unknown";
}

function RowActions({ app, onChanged }: { app: AppSummary; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const live = isLive(app.status);

  const run = async (action: "start" | "stop" | "restart"): Promise<void> => {
    setBusy(action);
    try {
      await api.action(app.slug, action);
      onChanged();
    } catch (caught) {
      toast.error(errorText(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex justify-end gap-1">
      {live ? (
        <Button size="sm" variant="ghost" loading={busy === "stop"} onClick={() => void run("stop")} title="Parar">
          <IconStop className="h-3.5 w-3.5" />
        </Button>
      ) : (
        <Button size="sm" variant="ghost" loading={busy === "start"} onClick={() => void run("start")} title="Iniciar">
          <IconPlay className="h-3.5 w-3.5" />
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        loading={busy === "restart"}
        onClick={() => void run("restart")}
        disabled={!live}
        title="Reiniciar"
      >
        <IconRestart className="h-3.5 w-3.5" />
      </Button>
      <Link to={`/apps/${app.slug}`}>
        <Button size="sm" variant="ghost">
          Abrir
        </Button>
      </Link>
    </div>
  );
}

export default function Apps() {
  const appsState = useAsync(() => api.apps(), [], { pollMs: 5000 });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const apps = appsState.data?.apps ?? [];
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return apps
      .filter((app) => matches(app, filter))
      .filter(
        (app) =>
          needle.length === 0 ||
          app.name.toLowerCase().includes(needle) ||
          app.slug.toLowerCase().includes(needle) ||
          app.runtime.toLowerCase().includes(needle),
      );
  }, [apps, filter, search]);

  const loading = appsState.loading && appsState.data === null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Aplicações"
        icon={<IconApps className="h-4 w-4" />}
        subtitle={`${apps.length} aplicação(ões) · ${apps.filter((app) => isLive(app.status)).length} em execução`}
        actions={
          <Link to="/apps/new">
            <Button variant="primary">
              <IconPlus className="h-4 w-4" /> Nova aplicação
            </Button>
          </Link>
        }
      />

      {appsState.error ? <Alert tone="red">{appsState.error}</Alert> : null}

      <div className="card flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-56 flex-1">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="buscar por nome, identificador ou runtime…"
            className="pl-9"
          />
        </div>
        <Select value={filter} onChange={(event) => setFilter(event.target.value as Filter)} className="w-auto">
          <option value="all">Todos os estados</option>
          <option value="online">Online</option>
          <option value="stopped">Paradas</option>
          <option value="unknown">Desconhecidas</option>
        </Select>
      </div>

      {loading ? (
        <Card bodyClassName="p-0">
          <SkeletonRows rows={6} />
        </Card>
      ) : null}

      {!loading && apps.length === 0 ? (
        <EmptyState
          title="Nenhuma aplicação ainda"
          description="Crie a primeira aplicação enviando um ZIP com o código do seu bot."
          action={
            <Link to="/apps/new">
              <Button variant="primary">
                <IconPlus className="h-4 w-4" /> Nova aplicação
              </Button>
            </Link>
          }
        />
      ) : null}

      {!loading && apps.length > 0 && visible.length === 0 ? (
        <EmptyState title="Nenhum resultado" description="Ajuste a busca ou o filtro de estado." />
      ) : null}

      {/* Tabela (desktop) */}
      {visible.length > 0 ? (
        <Card bodyClassName="p-0" className="hidden lg:block">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/8 text-[10.5px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-5 py-3.5 font-semibold">Aplicação</th>
                  <th className="px-3 py-3 font-medium">Estado</th>
                  <th className="px-3 py-3 font-medium">Runtime</th>
                  <th className="px-3 py-3 font-medium">Versão</th>
                  <th className="px-3 py-3 font-medium">RAM</th>
                  <th className="px-3 py-3 font-medium">CPU</th>
                  <th className="px-3 py-3 font-medium">Uso agora</th>
                  <th className="px-3 py-3 font-medium">Atualizada</th>
                  <th className="px-3 py-3 text-right font-medium">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/6">
                {visible.map((app) => (
                  <tr key={app.id} className="transition-colors hover:bg-white/[0.03]">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <AppIcon app={app} size="sm" />
                        <div className="min-w-0">
                          <Link to={`/apps/${app.slug}`} className="font-medium text-slate-100 hover:text-indigo-300">
                            {app.name}
                          </Link>
                          <p className="font-mono text-[11px] text-slate-500">{app.slug}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <StatusBadge status={app.status} />
                    </td>
                    <td className="px-3 py-3 text-slate-300">{runtimeLabel(app.runtime)}</td>
                    <td className="px-3 py-3">
                      {app.activeRelease > 0 ? (
                        <Badge tone="indigo">v{app.activeRelease}</Badge>
                      ) : (
                        <Badge tone="amber">sem versão</Badge>
                      )}
                    </td>
                    <td className="px-3 py-3 font-mono text-slate-300">{humanRam(app.memoryMb)}</td>
                    <td className="px-3 py-3 font-mono text-slate-300">{humanCpu(app.cpu)}</td>
                    <td className="px-3 py-3">
                      {app.resources ? (
                        <span className="font-mono text-slate-300">
                          {app.resources.cpuPercent.toFixed(1)}% · {humanBytes(app.resources.memoryBytes)}
                        </span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-slate-500">{relativeTime(app.updatedAt)}</td>
                    <td className="px-3 py-3">
                      <RowActions app={app} onChanged={() => void appsState.reload()} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {/* Cards (mobile) */}
      {visible.length > 0 ? (
        <div className={cn("grid gap-4 md:grid-cols-2 lg:hidden")}>
          {visible.map((app) => (
            <AppCard key={app.id} app={app} onChanged={() => void appsState.reload()} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
