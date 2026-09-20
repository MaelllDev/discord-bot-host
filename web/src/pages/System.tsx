import { api } from "../api.ts";
import { useAsync } from "../hooks.ts";
import { humanBytes, humanDuration, humanPercent, relativeTime } from "../format.ts";
import {
  Alert,
  Badge,
  Button,
  Card,
  DescriptionList,
  EmptyState,
  InlineCode,
  Kpi,
  Meter,
  SkeletonCard,
  Spinner,
} from "../components/ui.tsx";
import { IconAlert, IconBox, IconCpu, IconDisk, IconMemory, IconServer } from "../components/icons.tsx";

export default function SystemPage() {
  const systemState = useAsync(() => api.system(), [], { pollMs: 10_000 });
  const eventsState = useAsync(() => api.events(20), [], { pollMs: 20_000 });
  const usageState = useAsync(() => api.usage(), [], { pollMs: 60_000 });

  const system = systemState.data;
  const dockerOk = system?.docker.available ?? true;

  if (systemState.loading && !system) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (!system) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold text-slate-100">Sistema</h1>
        <Alert tone="red">{systemState.error ?? "Não foi possível ler as informações do sistema."}</Alert>
      </div>
    );
  }

  const disk = system.host.disk;
  const memoryUsed = system.host.memoryTotalBytes - system.host.memoryFreeBytes;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Sistema</h1>
          <p className="mt-1 text-xs text-slate-500">
            Estado do Docker, recursos do host e configuração em uso pelo painel.
          </p>
        </div>
        <Button onClick={() => void systemState.reload()}>Atualizar</Button>
      </header>

      {!dockerOk ? (
        <Alert tone="red" icon={<IconAlert className="h-3.5 w-3.5" />}>
          O daemon do Docker está <strong>inacessível</strong>. Por isso os contadores de containers e de aplicações em
          execução aparecem como <em>desconhecidos</em> em vez de zero — o painel não inventa um estado.
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Docker"
          value={dockerOk ? (system.docker.version ?? "conectado") : "indisponível"}
          hint={dockerOk ? `API ${system.docker.apiVersion ?? "?"}` : "não foi possível falar com o daemon"}
          icon={<IconServer className="h-3.5 w-3.5" />}
        />
        <Kpi
          label="Containers"
          value={system.docker.containers === null ? "desconhecido" : system.docker.containers}
          hint={system.docker.containers === null ? "daemon inacessível" : "no daemon Docker"}
          icon={<IconBox className="h-3.5 w-3.5" />}
        />
        <Kpi
          label="Aplicações em execução"
          value={system.apps.running === null ? "desconhecido" : `${system.apps.running} de ${system.apps.total}`}
          hint={system.apps.running === null ? "daemon inacessível" : "segundo o Docker"}
          icon={<IconServer className="h-3.5 w-3.5" />}
        />
        <Kpi
          label="Painel"
          value={`v${system.panel.version ?? "?"}`}
          hint={`no ar há ${humanDuration(system.panel.uptimeSeconds)}`}
          icon={<IconServer className="h-3.5 w-3.5" />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Recursos do host" subtitle={system.host.platform}>
          <div className="space-y-4">
            <Meter
              label="CPU"
              value={`${system.host.cpuCount} núcleo(s)`}
              hint={system.host.cpuModel ?? undefined}
              percent={Math.min(100, ((system.host.loadAverage[0] ?? 0) / Math.max(system.host.cpuCount, 1)) * 100)}
              tone="sky"
            />
            <div className="grid grid-cols-3 gap-3 text-[11px]">
              <div>
                <p className="text-slate-500">Carga 1 min</p>
                <p className="font-mono text-slate-300">{system.host.loadAverage[0].toFixed(2)}</p>
              </div>
              <div>
                <p className="text-slate-500">Carga 5 min</p>
                <p className="font-mono text-slate-300">{system.host.loadAverage[1].toFixed(2)}</p>
              </div>
              <div>
                <p className="text-slate-500">Carga 15 min</p>
                <p className="font-mono text-slate-300">{system.host.loadAverage[2].toFixed(2)}</p>
              </div>
            </div>
            <Meter
              label="Memória"
              value={`${humanBytes(memoryUsed)} de ${humanBytes(system.host.memoryTotalBytes)}`}
              hint={`${humanBytes(system.host.memoryFreeBytes)} livres · ${humanPercent((memoryUsed / system.host.memoryTotalBytes) * 100)} em uso`}
              percent={(memoryUsed / Math.max(system.host.memoryTotalBytes, 1)) * 100}
              tone={memoryUsed / system.host.memoryTotalBytes > 0.85 ? "red" : "green"}
            />
            {disk ? (
              <Meter
                label="Disco do painel"
                value={`${humanBytes(disk.usedBytes)} de ${humanBytes(disk.totalBytes)}`}
                hint={
                  <>
                    <InlineCode>{disk.path}</InlineCode> · {humanBytes(disk.freeBytes)} livres
                  </>
                }
                percent={(disk.usedBytes / Math.max(disk.totalBytes, 1)) * 100}
                tone={disk.usedBytes / disk.totalBytes > 0.9 ? "red" : "indigo"}
              />
            ) : (
              <p className="text-[11px] text-slate-500">Espaço em disco indisponível neste sistema.</p>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <Badge>
                <IconCpu className="h-3 w-3" /> {system.host.cpuCount} núcleos
              </Badge>
              <Badge>
                <IconMemory className="h-3 w-3" /> {humanBytes(system.host.memoryTotalBytes)}
              </Badge>
              {disk ? (
                <Badge>
                  <IconDisk className="h-3 w-3" /> {humanBytes(disk.freeBytes)} livres
                </Badge>
              ) : null}
              <Badge>{system.host.arch}</Badge>
            </div>
          </div>
        </Card>

        <Card title="Painel e ambiente" subtitle="Valores efetivos em execução (somente leitura)">
          <DescriptionList
            items={[
              { label: "Nome do painel", value: system.panelName },
              { label: "Versão do painel", value: `v${system.panel.version ?? "?"}` },
              { label: "Node.js", value: <span className="font-mono">{system.panel.nodeVersion}</span> },
              { label: "Iniciado em", value: `${relativeTime(system.panel.startedAt)} (${humanDuration(system.panel.uptimeSeconds)} no ar)` },
              { label: "Diretório de dados", value: <span className="font-mono">{system.dataDir}</span> },
              { label: "Socket do Docker", value: <span className="font-mono">{system.config.dockerSocket}</span> },
              { label: "Servindo em", value: <span className="font-mono">{system.config.host}:{system.config.port}</span> },
              { label: "Instância do painel", value: <span className="font-mono">{system.config.instanceId}</span> },
              { label: "Retenção de versões", value: system.config.keepReleases === 0 ? "todas" : `últimas ${system.config.keepReleases}` },
              { label: "Limite de upload", value: `${system.config.maxUploadMb} MB` },
              { label: "Usuário nos containers", value: <span className="font-mono">{system.config.runUid}:{system.config.runGid}</span> },
              { label: "Cookie seguro (HTTPS)", value: system.config.cookieSecure ? "ativado" : "desativado" },
            ]}
          />
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Imagens Docker (${system.images.length})`} subtitle="Imagens de runtime disponíveis localmente">
          {system.images.length === 0 ? (
            <p className="text-xs text-slate-500">
              {dockerOk
                ? "Nenhuma imagem baixada ainda — o primeiro deploy de cada runtime baixa a imagem necessária."
                : "Não foi possível listar as imagens porque o daemon está inacessível."}
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {system.images.map((image) => (
                <li key={image}>
                  <Badge>
                    <span className="font-mono">{image}</span>
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Espaço usado por aplicação" subtitle="Código de todos os releases + volume /data">
          {usageState.loading && usageState.data === null ? (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Spinner /> medindo uso em disco…
            </div>
          ) : (usageState.data?.usage.length ?? 0) === 0 ? (
            <EmptyState title="Nenhuma aplicação instalada" description="O uso em disco aparece aqui quando houver aplicações." />
          ) : (
            <ul className="divide-y divide-slate-800/70 text-xs">
              {usageState.data?.usage
                .slice()
                .sort((a, b) => b.bytes - a.bytes)
                .map((entry) => (
                  <li key={entry.slug} className="flex items-center justify-between gap-3 py-2">
                    <span className="font-mono text-slate-300">{entry.slug}</span>
                    <span className="text-slate-400">{humanBytes(entry.bytes)}</span>
                  </li>
                ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Eventos do painel" subtitle="Últimos registros do sistema" bodyClassName="p-0">
        <ul className="divide-y divide-slate-800/70">
          {(eventsState.data?.events ?? []).map((event) => (
            <li key={event.id} className="flex items-start gap-3 px-4 py-2.5 text-xs">
              <span
                className={
                  event.level === "error"
                    ? "mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500"
                    : "mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                }
              />
              <span className="flex-1 text-slate-300">{event.message}</span>
              <span className="shrink-0 text-slate-500">{relativeTime(event.createdAt)}</span>
            </li>
          ))}
          {(eventsState.data?.events.length ?? 0) === 0 ? (
            <li className="px-4 py-4 text-xs text-slate-500">Nenhum evento registrado.</li>
          ) : null}
        </ul>
      </Card>
    </div>
  );
}
