import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.ts";
import { useAsync } from "../hooks.ts";
import { humanBytes, humanCpu, humanDuration, humanRam, relativeTime } from "../format.ts";
import AppCard, { isLive } from "../components/AppCard.tsx";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Kpi,
  Meter,
  SkeletonCard,
  Spinner,
  cn,
} from "../components/ui.tsx";
import {
  IconActivity,
  IconAlert,
  IconApps,
  IconCpu,
  IconDisk,
  IconMemory,
  IconPlus,
} from "../components/icons.tsx";

export default function Dashboard() {
  const appsState = useAsync(() => api.apps(), [], { pollMs: 5000 });
  const systemState = useAsync(() => api.system(), [], { pollMs: 15_000 });
  const eventsState = useAsync(() => api.events(12), [], { pollMs: 20_000 });

  // Marca o instante da última leitura bem-sucedida (a lista renova sozinha).
  const [lastSync, setLastSync] = useState<string | null>(null);
  const appsRef = useRef(appsState.data);
  useEffect(() => {
    if (appsState.data && appsState.data !== appsRef.current) {
      appsRef.current = appsState.data;
      setLastSync(new Date().toISOString());
    }
  }, [appsState.data]);

  const apps = appsState.data?.apps ?? [];
  const system = systemState.data;
  const loading = appsState.loading && appsState.data === null;

  const online = apps.filter((app) => isLive(app.status)).length;
  const stopped = apps.filter((app) => app.status === "stopped" || app.status === "crashed").length;
  const unknown = apps.filter((app) => app.status === "unknown").length;

  const cpuInUse = apps.reduce((total, app) => total + (app.resources?.cpuPercent ?? 0), 0);
  const memoryInUse = apps.reduce((total, app) => total + (app.resources?.memoryBytes ?? 0), 0);

  const hostCpu = system ? system.host.cpuCount : null;
  const hostMemory = system ? system.host.memoryTotalBytes : null;
  const hostMemoryFree = system ? system.host.memoryFreeBytes : null;
  const hostMemoryUsed = hostMemory !== null && hostMemoryFree !== null ? hostMemory - hostMemoryFree : null;
  const dockerOk = system?.docker.available ?? true;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Dashboard</h1>
          <p className="mt-1 text-xs text-slate-500">
            {system
              ? `${system.apps.total} aplicação(ões) · Docker ${system.docker.version ?? "?"} · host ${system.host.platform}`
              : "carregando informações do sistema…"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastSync ? (
            <span className="hidden text-[11px] text-slate-500 sm:inline">sincronizado {relativeTime(lastSync)}</span>
          ) : null}
          <Link to="/apps/new">
            <Button variant="primary">
              <IconPlus className="h-4 w-4" /> Nova aplicação
            </Button>
          </Link>
        </div>
      </header>

      {!dockerOk ? (
        <Alert tone="red" icon={<IconAlert className="h-3.5 w-3.5" />}>
          O Docker não está acessível. O estado real das aplicações é <strong>desconhecido</strong> — o painel não
          consegue falar com <code>{system?.config.dockerSocket ?? "/var/run/docker.sock"}</code>. Use <code>systemctl status docker</code> na
          VPS. Os botões de controle ficam indisponíveis até o daemon voltar.
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Aplicações" value={apps.length} hint={`${system?.apps.total ?? apps.length} registradas`} icon={<IconApps className="h-3.5 w-3.5" />} />
        <Kpi
          label="Online"
          value={<span className="text-emerald-300">{online}</span>}
          hint="em execução ou subindo"
          icon={<IconActivity className="h-3.5 w-3.5" />}
        />
        <Kpi label="Paradas" value={stopped} hint="paradas manualmente ou encerradas" icon={<IconAlert className="h-3.5 w-3.5" />} />
        <Kpi
          label="Desconhecidas"
          value={<span className={unknown > 0 ? "text-rose-300" : undefined}>{unknown}</span>}
          hint={unknown > 0 ? "Docker inacessível: estado real desconhecido" : "nenhuma"}
          icon={<IconAlert className="h-3.5 w-3.5" />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Uso das aplicações" subtitle="Somatório do consumo real reportado pelos containers" className="lg:col-span-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <Meter
              label="CPU em uso"
              value={dockerOk ? `${cpuInUse.toFixed(1)}%` : "indisponível"}
              hint={
                hostCpu !== null
                  ? `VPS com ${hostCpu} núcleo(s) · carga média ${system?.host.loadAverage[0]?.toFixed(2) ?? "—"}`
                  : undefined
              }
              percent={hostCpu ? Math.min(100, (cpuInUse / 100 / hostCpu) * 100) : 0}
              tone={cpuInUse > 80 ? "amber" : "indigo"}
            />
            <Meter
              label="Memória em uso"
              value={dockerOk ? humanBytes(memoryInUse) : "indisponível"}
              hint={
                hostMemory !== null
                  ? `de ${humanBytes(hostMemory)} na VPS`
                  : undefined
              }
              percent={hostMemory ? Math.min(100, (memoryInUse / hostMemory) * 100) : 0}
              tone="green"
            />
          </div>
          <div className="mt-4 flex flex-wrap gap-2 text-[11px] text-slate-500">
            <Badge tone="indigo">
              <IconCpu className="h-3 w-3" /> {humanCpu(apps.reduce((total, app) => total + app.cpu, 0))} alocados
            </Badge>
            <Badge tone="indigo">
              <IconMemory className="h-3 w-3" /> {humanRam(apps.reduce((total, app) => total + app.memoryMb, 0))} alocados
            </Badge>
            {system?.host.disk ? (
              <Badge>
                <IconDisk className="h-3 w-3" /> dados: {humanBytes(system.host.disk.usedBytes)} de{" "}
                {humanBytes(system.host.disk.totalBytes)}
              </Badge>
            ) : null}
          </div>
        </Card>

        <Card title="Capacidade da VPS" subtitle="Recursos do host que executa o painel">
          {system ? (
            <div className="space-y-4">
              <Meter
                label="CPU"
                value={`${system.host.cpuCount} núcleo(s)`}
                hint={system.host.cpuModel ?? undefined}
                percent={Math.min(100, ((system.host.loadAverage[0] ?? 0) / Math.max(system.host.cpuCount, 1)) * 100)}
                tone="sky"
              />
              <Meter
                label="Memória"
                value={hostMemoryUsed !== null ? `${humanBytes(hostMemoryUsed)} de ${humanBytes(hostMemory)}` : "—"}
                percent={hostMemory ? (hostMemoryUsed ?? 0) / hostMemory * 100 : 0}
                tone={hostMemory && (hostMemoryUsed ?? 0) / hostMemory > 0.85 ? "red" : "green"}
              />
              {system.host.disk ? (
                <Meter
                  label="Disco do painel"
                  value={`${humanBytes(system.host.disk.usedBytes)} de ${humanBytes(system.host.disk.totalBytes)}`}
                  hint={<span className="font-mono">{system.host.disk.path}</span>}
                  percent={(system.host.disk.usedBytes / Math.max(system.host.disk.totalBytes, 1)) * 100}
                  tone={system.host.disk.usedBytes / system.host.disk.totalBytes > 0.9 ? "red" : "indigo"}
                />
              ) : (
                <p className="text-[11px] text-slate-500">Informação de disco indisponível neste sistema.</p>
              )}
              <p className="text-[11px] text-slate-500">
                Painel v{system.panel.version ?? "?"} · Node {system.panel.nodeVersion} · no ar há{" "}
                {humanDuration(system.panel.uptimeSeconds)}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <Spinner className="h-4 w-4" />
            </div>
          )}
        </Card>
      </div>

      {appsState.error ? <Alert tone="red">{appsState.error}</Alert> : null}

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-100">Aplicações</h2>
          <Link to="/apps" className="text-[11px] text-indigo-300 hover:text-indigo-200">
            ver todas
          </Link>
        </div>

        {loading ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <SkeletonCard key={index} />
            ))}
          </div>
        ) : null}

        {!loading && apps.length === 0 ? (
          <EmptyState
            title="Nenhuma aplicação hospedada ainda"
            description="Envie o ZIP do seu bot, confirme o runtime e o painel cuida de instalar as dependências, rodar 24/7 com limites de RAM/CPU e manter o histórico de versões."
            action={
              <Link to="/apps/new">
                <Button variant="primary">
                  <IconPlus className="h-4 w-4" /> Criar a primeira aplicação
                </Button>
              </Link>
            }
          />
        ) : null}

        {apps.length > 0 ? (
          <div className={cn("grid gap-4 md:grid-cols-2 xl:grid-cols-3")}>
            {apps.map((app) => (
              <AppCard key={app.id} app={app} onChanged={() => void appsState.reload()} />
            ))}
          </div>
        ) : null}
      </section>

      <Card title="Atividade recente" subtitle="Eventos registrados pelo painel" bodyClassName="p-0">
        <ul className="divide-y divide-slate-800/70">
          {(eventsState.data?.events ?? []).map((event) => (
            <li key={event.id} className="flex items-start gap-3 px-4 py-2.5 text-xs">
              <span
                className={cn(
                  "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                  event.level === "error" ? "bg-rose-500" : "bg-emerald-500",
                )}
              />
              <span className="flex-1 text-slate-300">{event.message}</span>
              <span className="shrink-0 text-slate-500">{relativeTime(event.createdAt)}</span>
            </li>
          ))}
          {(eventsState.data?.events.length ?? 0) === 0 ? (
            <li className="px-4 py-4 text-xs text-slate-500">Nenhum evento registrado ainda.</li>
          ) : null}
        </ul>
      </Card>
    </div>
  );
}
