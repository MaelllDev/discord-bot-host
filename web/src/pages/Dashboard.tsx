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
  FeatureTile,
  Hero,
  Kpi,
  Meter,
  PageHeader,
  SectionHeader,
  SkeletonCard,
  Spinner,
  cn,
} from "../components/ui.tsx";
import {
  IconActivity,
  IconAlert,
  IconApps,
  IconArchive,
  IconCpu,
  IconDisk,
  IconLayers,
  IconMemory,
  IconPlus,
  IconServer,
  IconSparkles,
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
      <PageHeader
        title="Dashboard"
        subtitle={
          system
            ? `${system.apps.total} aplicação(ões) · Docker ${system.docker.version ?? "?"} · host ${system.host.platform}`
            : "carregando informações do sistema…"
        }
        icon={<IconActivity className="h-4 w-4" />}
        actions={
          <>
            {lastSync ? (
              <span className="hidden text-[11px] text-slate-500 sm:inline">sincronizado {relativeTime(lastSync)}</span>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void appsState.reload();
                void systemState.reload();
              }}
            >
              Atualizar
            </Button>
          </>
        }
      />

      {!dockerOk ? (
        <Alert tone="red" icon={<IconAlert className="h-3.5 w-3.5" />}>
          O Docker não está acessível. O estado real das aplicações é <strong>desconhecido</strong> — o painel não
          consegue falar com <code>{system?.config.dockerSocket ?? "/var/run/docker.sock"}</code>. Use{" "}
          <code>systemctl status docker</code> na VPS. Os botões de controle ficam indisponíveis até o daemon voltar.
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Aplicações"
          value={apps.length}
          hint={`${system?.apps.total ?? apps.length} registradas`}
          icon={<IconApps className="h-4 w-4" />}
          tone="neutral"
        />
        <Kpi
          label="Online"
          value={online}
          hint="em execução ou subindo"
          icon={<IconActivity className="h-4 w-4" />}
          tone="green"
        />
        <Kpi
          label="Paradas"
          value={stopped}
          hint="paradas manualmente ou encerradas"
          icon={<IconAlert className="h-4 w-4" />}
          tone="amber"
        />
        <Kpi
          label="Desconhecidas"
          value={unknown}
          hint={unknown > 0 ? "Docker inacessível: estado real desconhecido" : "nenhuma"}
          icon={<IconAlert className="h-4 w-4" />}
          tone={unknown > 0 ? "red" : "neutral"}
        />
      </div>

      {!loading && apps.length === 0 ? (
        <Hero
          badge="Primeiros passos"
          title="Hospede seus bots e aplicações nesta VPS"
          description="Envie um ZIP com o código, confirme o runtime detectado e o painel cuida do resto: dependências, container isolado, limites de CPU e RAM, logs ao vivo, versões com rollback e backups."
          actions={
            <>
              <Link to="/apps/new">
                <Button variant="primary">
                  <IconPlus className="h-4 w-4" /> Criar aplicação
                </Button>
              </Link>
              <Link to="/system">
                <Button variant="outline">
                  <IconServer className="h-4 w-4" /> Ver o sistema
                </Button>
              </Link>
            </>
          }
          footnote="Tudo roda na sua própria VPS — nenhum serviço externo é necessário."
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FeatureTile
              title="Deploy por ZIP"
              description="Upload do projeto inteiro, com progresso e detecção automática do runtime."
              icon={<IconLayers className="h-4 w-4" />}
            />
            <FeatureTile
              title="Container isolado"
              description="Cada aplicação em seu próprio container, com limites de CPU, RAM e processos."
              icon={<IconApps className="h-4 w-4" />}
            />
            <FeatureTile
              title="Versões e rollback"
              description="Releases imutáveis: volte para a versão anterior sem perder os dados de /data."
              icon={<IconArchive className="h-4 w-4" />}
            />
            <FeatureTile
              title="IA nos logs"
              description="Análise opcional das últimas linhas com o provedor de IA que você configurar."
              icon={<IconSparkles className="h-4 w-4" />}
            />
          </div>
        </Hero>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          title="Uso das aplicações"
          subtitle="Somatório do consumo real reportado pelos containers"
          icon={<IconCpu className="h-4 w-4" />}
          className="lg:col-span-2"
        >
          <div className="grid gap-5 sm:grid-cols-2">
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
              hint={hostMemory !== null ? `de ${humanBytes(hostMemory)} na VPS` : undefined}
              percent={hostMemory ? Math.min(100, (memoryInUse / hostMemory) * 100) : 0}
              tone="green"
            />
          </div>
          <div className="mt-5 flex flex-wrap gap-2 text-[11px] text-slate-500">
            <Badge tone="indigo">
              <IconCpu className="h-3 w-3" /> {humanCpu(apps.reduce((total, app) => total + app.cpu, 0))} alocados
            </Badge>
            <Badge tone="indigo">
              <IconMemory className="h-3 w-3" /> {humanRam(apps.reduce((total, app) => total + app.memoryMb, 0))}{" "}
              alocados
            </Badge>
            {system?.host.disk ? (
              <Badge>
                <IconDisk className="h-3 w-3" /> dados: {humanBytes(system.host.disk.usedBytes)} de{" "}
                {humanBytes(system.host.disk.totalBytes)}
              </Badge>
            ) : null}
          </div>
        </Card>

        <Card title="Capacidade da VPS" subtitle="Recursos do host que executa o painel" icon={<IconServer className="h-4 w-4" />}>
          {system ? (
            <div className="space-y-5">
              <Meter
                label="CPU"
                value={`${system.host.cpuCount} núcleo(s)`}
                hint={system.host.cpuModel ?? undefined}
                percent={Math.min(100, ((system.host.loadAverage[0] ?? 0) / Math.max(system.host.cpuCount, 1)) * 100)}
                tone="sky"
              />
              <Meter
                label="Memória"
                value={
                  hostMemoryUsed !== null ? `${humanBytes(hostMemoryUsed)} de ${humanBytes(hostMemory)}` : "—"
                }
                percent={hostMemory ? ((hostMemoryUsed ?? 0) / hostMemory) * 100 : 0}
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
        <SectionHeader
          title="Aplicações"
          hint={apps.length > 0 ? `${apps.length} hospedada(s) nesta instância` : undefined}
          action={
            <Link to="/apps" className="text-[11px] font-medium text-indigo-300 transition-colors hover:text-indigo-200">
              ver todas →
            </Link>
          }
        />

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

      <Card title="Atividade recente" subtitle="Eventos registrados pelo painel" bodyClassName="p-0" icon={<IconActivity className="h-4 w-4" />}>
        <ul className="divide-y divide-white/6">
          {(eventsState.data?.events ?? []).map((event) => (
            <li key={event.id} className="flex items-start gap-3 px-5 py-3 text-xs transition-colors hover:bg-white/[0.02]">
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
            <li className="px-5 py-5 text-xs text-slate-500">Nenhum evento registrado ainda.</li>
          ) : null}
        </ul>
      </Card>
    </div>
  );
}
