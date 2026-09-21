import { api } from "../../api.ts";
import type { AppStream } from "../../hooks.ts";
import { useAsync } from "../../hooks.ts";
import type { AppSummary } from "../../types.ts";
import {
  formatDateTime,
  humanBytes,
  humanCpu,
  humanDuration,
  humanRam,
  relativeTime,
  runtimeLabel,
} from "../../format.ts";
import {
  Alert,
  Badge,
  Button,
  Card,
  DescriptionList,
  InlineCode,
  Kpi,
  Meter,
  Spinner,
  StatusBadge,
} from "../ui.tsx";
import { IconPlay, IconRestart, IconStop, IconTrash, IconUpload } from "../icons.tsx";
import AppIcon from "../AppIcon.tsx";

export default function OverviewPanel({
  app,
  stream,
  onReload,
  onUpdateCode,
  onDelete,
  onEditIcon,
  onAction,
  busyAction,
}: {
  app: AppSummary;
  stream: AppStream;
  onReload: () => void;
  onUpdateCode: () => void;
  onDelete: () => void;
  /** Leva para a aba Configuração, onde a URL do ícone é editada. */
  onEditIcon: () => void;
  onAction: (action: "start" | "stop" | "restart") => void;
  busyAction: string | null;
}) {
  const commandsState = useAsync(() => api.commands(app.slug), [app.slug]);
  const deploymentsState = useAsync(() => api.deployments(app.slug), [app.slug], { pollMs: 15_000 });

  const resources = stream.connected ? stream.resources : app.resources;
  const status = stream.connected ? stream.status : app.status;
  const running = status === "running" || status === "starting" || status === "restarting";
  const dockerDown = stream.dockerUnavailable || status === "unknown";

  const cpuShare = resources ? Math.min(100, (resources.cpuPercent / Math.max(app.cpu, 0.1)) * 100) : 0;

  return (
    <div className="space-y-5">
      {/* Bloco de identidade: o ícone do bot em destaque, com nome, descrição e
          os limites configurados. */}
      <Card>
        <div className="flex flex-wrap items-center gap-5">
          <AppIcon
            app={app}
            size="xl"
            className="ring-1 ring-indigo-400/20 shadow-[0_0_38px_-16px_rgb(124_92_255/0.8)]"
          />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-100">{app.name}</h2>
              <StatusBadge status={status} />
              {app.activeRelease > 0 ? (
                <Badge tone="indigo">versão {app.activeRelease}</Badge>
              ) : (
                <Badge tone="amber">sem versão</Badge>
              )}
            </div>
            {app.description ? <p className="text-xs text-slate-400">{app.description}</p> : null}
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="indigo">{runtimeLabel(app.runtime)}</Badge>
              <Badge>{humanCpu(app.cpu)}</Badge>
              <Badge>{humanRam(app.memoryMb)}</Badge>
              <Badge>
                <span className="font-mono">{app.slug}</span>
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[11px] text-slate-500">
                {app.iconUrl ? (
                  <>
                    Ícone próprio: <span className="break-all font-mono">{app.iconUrl}</span>
                  </>
                ) : (
                  <>Sem ícone próprio — o painel usa as iniciais do nome.</>
                )}
              </p>
              <Button size="sm" variant="ghost" onClick={onEditIcon}>
                {app.iconUrl ? "Alterar ícone" : "Definir ícone"}
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Status"
          value={<StatusBadge status={status} />}
          hint={stream.connected ? "tempo real" : "última leitura do painel"}
        />
        <Kpi
          label="Uptime"
          value={humanDuration(resources?.uptimeSeconds)}
          hint={resources?.startedAt ? `desde ${formatDateTime(resources.startedAt)}` : "indisponível"}
        />
        <Kpi label="CPU" value={resources ? `${resources.cpuPercent.toFixed(1)}%` : "—"} hint={`limite de ${humanCpu(app.cpu)}`} />
        <Kpi
          label="Memória"
          value={resources ? humanBytes(resources.memoryBytes) : "—"}
          hint={`limite de ${humanRam(app.memoryMb)}`}
        />
      </div>

      {dockerDown ? (
        <Alert tone="red">
          O painel não conseguiu falar com o Docker, então o estado real desta aplicação é{" "}
          <strong>desconhecido</strong> — ela pode estar rodando normalmente. As métricas voltam assim que o daemon
          responder.
        </Alert>
      ) : null}

      <Card
        title="Consumo e limites"
        subtitle={stream.connected ? "atualizado a cada 2 segundos" : "tempo real desconectado — valores da última leitura"}
        actions={
          <div className="flex gap-2">
            <Button size="sm" onClick={onReload}>
              Atualizar
            </Button>
            <Button size="sm" onClick={stream.refresh} disabled={!stream.connected}>
              Recarregar stream
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Meter
            label="CPU"
            value={resources ? `${resources.cpuPercent.toFixed(1)}% de ${humanCpu(app.cpu)}` : "sem dados"}
            percent={cpuShare}
            tone={cpuShare > 80 ? "amber" : "indigo"}
          />
          <Meter
            label="Memória"
            value={
              resources
                ? `${humanBytes(resources.memoryBytes)} de ${humanBytes(resources.memoryLimitBytes || app.memoryMb * 1024 * 1024)}`
                : "sem dados"
            }
            percent={resources?.memoryPercent ?? 0}
            tone={(resources?.memoryPercent ?? 0) > 85 ? "red" : (resources?.memoryPercent ?? 0) > 65 ? "amber" : "green"}
          />
          <div className="grid gap-3 text-[11px] sm:grid-cols-3">
            <div>
              <p className="text-slate-500">Processos no container</p>
              <p className="font-mono text-slate-300">{resources ? resources.pids : "—"}</p>
            </div>
            <div>
              <p className="text-slate-500">Saída do processo</p>
              <p className="font-mono text-slate-300">
                {resources?.exitCode === null || resources?.exitCode === undefined ? "—" : resources.exitCode}
              </p>
            </div>
            <div>
              <p className="text-slate-500">Uso em disco</p>
              <p className="font-mono text-slate-300">{humanBytes(app.diskBytes)}</p>
            </div>
          </div>

          {status === "crashed" && resources?.exitCode !== null && resources?.exitCode !== undefined ? (
            <Alert tone="red">
              O processo terminou com código {resources.exitCode}. Veja os <strong>Logs</strong> — com a política de
              reinício automático, o Docker tenta subir de novo sozinho.
            </Alert>
          ) : null}
          {!running && !dockerDown ? (
            <Alert tone="amber">
              A aplicação não está em execução. Use <strong>Iniciar</strong> para subir o container; o volume{" "}
              <InlineCode>/data</InlineCode> é preservado.
            </Alert>
          ) : null}
        </div>
      </Card>

      <Card title="Ações" subtitle="Controle do ciclo de vida desta aplicação">
        <div className="flex flex-wrap gap-2">
          {running ? (
            <Button variant="secondary" loading={busyAction === "stop"} onClick={() => onAction("stop")}>
              <IconStop className="h-3.5 w-3.5" /> Parar
            </Button>
          ) : (
            <Button variant="success" loading={busyAction === "start"} onClick={() => onAction("start")} disabled={app.activeRelease === 0}>
              <IconPlay className="h-3.5 w-3.5" /> Iniciar
            </Button>
          )}
          <Button loading={busyAction === "restart"} onClick={() => onAction("restart")} disabled={app.activeRelease === 0}>
            <IconRestart className="h-3.5 w-3.5" /> Reiniciar
          </Button>
          <Button variant="primary" onClick={onUpdateCode}>
            <IconUpload className="h-3.5 w-3.5" /> Atualizar código
          </Button>
          <Button variant="danger" className="sm:ml-auto" onClick={onDelete}>
            <IconTrash className="h-3.5 w-3.5" /> Excluir
          </Button>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Informações do container" subtitle="Configuração aplicada ao processo em execução">
          <DescriptionList
            items={[
              { label: "Container", value: <span className="font-mono">botpanel-{app.slug}</span> },
              { label: "Imagem", value: <span className="font-mono">{app.image}</span> },
              { label: "Runtime", value: runtimeLabel(app.runtime) },
              { label: "Usuário", value: <span className="font-mono">1000:1000 (sem privilégios)</span> },
              { label: "Rede", value: <span className="font-mono">botpanel-net-{app.slug} (isolada)</span> },
              {
                label: "Código montado em",
                value: (
                  <span className="font-mono">
                    /app → releases/{app.activeRelease || "—"}
                  </span>
                ),
              },
              { label: "Dados persistentes", value: <span className="font-mono">/data → apps/{app.slug}/shared</span> },
              { label: "Portas publicadas", value: app.ports.length > 0 ? <span className="font-mono">{app.ports.join(", ")}</span> : "nenhuma" },
              {
                label: "Política de reinício",
                value: app.autoRestart
                  ? app.autoStart
                    ? "volta após erro e junto com a VPS (unless-stopped)"
                    : "volta após erro, mas não sobe junto com a VPS (on-failure)"
                  : "nunca reinicia sozinho (no)",
              },
              { label: "Limite de processos", value: <span className="font-mono">{app.pidsLimit}</span> },
            ]}
          />
        </Card>

        <Card title="Execução configurada" subtitle="O que o painel roda para instalar e iniciar">
          {commandsState.data?.commands.error ? (
            <Alert tone="red">{commandsState.data.commands.error}</Alert>
          ) : (
            <div className="space-y-3 text-xs">
              <div>
                <p className="text-slate-500">Instalação</p>
                <p className="mt-0.5 break-all font-mono text-slate-200">
                  {commandsState.loading ? "…" : (commandsState.data?.commands.installCommand ?? "nenhuma dependência a instalar")}
                </p>
              </div>
              <div>
                <p className="text-slate-500">Start</p>
                <p className="mt-0.5 break-all font-mono text-slate-200">
                  {commandsState.loading ? "…" : (commandsState.data?.commands.startCommand ?? "—")}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                <Badge tone="indigo">capabilities removidas</Badge>
                <Badge tone="indigo">no-new-privileges</Badge>
                <Badge tone="indigo">sem swap</Badge>
                {app.autoStart ? (
                  <Badge tone="green">inicia com o sistema</Badge>
                ) : (
                  <Badge tone="amber">não inicia com o sistema</Badge>
                )}
                {app.autoRestart ? (
                  <Badge tone="green">reinício automático</Badge>
                ) : (
                  <Badge tone="slate">sem reinício automático</Badge>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Versão ativa"
        subtitle="Código em execução e publicação mais recente"
        actions={
          <Button size="sm" onClick={onUpdateCode}>
            Publicar nova versão
          </Button>
        }
      >
        <div className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-slate-500">Versão</p>
            <p className="text-slate-200">{app.activeRelease > 0 ? `v${app.activeRelease}` : "nenhuma publicada"}</p>
          </div>
          <div>
            <p className="text-slate-500">Versões guardadas</p>
            <p className="text-slate-200">{app.releaseCount}</p>
          </div>
          <div>
            <p className="text-slate-500">Criada em</p>
            <p className="text-slate-200">{formatDateTime(app.createdAt)}</p>
          </div>
          <div>
            <p className="text-slate-500">Última atualização</p>
            <p className="text-slate-200">
              {formatDateTime(app.updatedAt)} <span className="text-slate-500">({relativeTime(app.updatedAt)})</span>
            </p>
          </div>
        </div>

        {app.activeRelease > 0 ? (
          <div className="mt-4">
            <p className="mb-1 text-[11px] text-slate-500">Arquivo principal e dependências do release ativo</p>
            <p className="font-mono text-[11px] text-slate-300">
              {app.entry || "comando próprio"} · {app.depsFile || "sem arquivo de dependências"}
            </p>
          </div>
        ) : null}
      </Card>

      <Card title="Últimos deploys" subtitle="Histórico de publicações desta aplicação" bodyClassName="p-0">
        {deploymentsState.loading ? (
          <div className="flex items-center gap-2 p-4 text-xs text-slate-400">
            <Spinner /> carregando…
          </div>
        ) : (
          <ul className="divide-y divide-white/6 text-xs">
            {(deploymentsState.data?.deployments ?? []).slice(0, 6).map((deployment) => (
              <li key={deployment.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <span className="text-slate-300">
                  {deployment.kind === "deploy" ? "Publicação" : deployment.kind}
                  {deployment.releaseSeq ? ` · versão ${deployment.releaseSeq}` : ""}
                </span>
                <Badge tone={deployment.status === "success" ? "green" : deployment.status === "failed" ? "red" : "amber"}>
                  {deployment.status === "success" ? "concluído" : deployment.status === "failed" ? "falhou" : "em andamento"}
                </Badge>
                <span className="ml-auto text-slate-500">{relativeTime(deployment.startedAt)}</span>
              </li>
            ))}
            {(deploymentsState.data?.deployments.length ?? 0) === 0 ? (
              <li className="px-4 py-4 text-slate-500">Nenhuma publicação registrada.</li>
            ) : null}
          </ul>
        )}
      </Card>

    </div>
  );
}
