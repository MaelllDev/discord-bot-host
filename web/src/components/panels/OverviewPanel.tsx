import { api } from "../../api.ts";
import type { AppStream } from "../../hooks.ts";
import { useAsync } from "../../hooks.ts";
import type { AppSummary } from "../../types.ts";
import { useI18n } from "../../i18n/index.tsx";
import {
  formatDateTime,
  humanBytes,
  humanCpu,
  humanDuration,
  humanRam,
  relativeTime,
  runtimeLabel,
} from "../../format.ts";
import { Alert, Badge, Button, Card, DescriptionList, InlineCode, Kpi, Meter, Spinner } from "../ui.tsx";

/**
 * Conteúdo informativo da aba Visão geral. A identidade (foto, nome, estado)
 * e as ações (iniciar/parar/reiniciar/atualizar/excluir) ficam no cabeçalho da
 * página — cada coisa aparece uma única vez.
 */
export default function OverviewPanel({
  app,
  stream,
  onReload,
}: {
  app: AppSummary;
  stream: AppStream;
  onReload: () => void;
}) {
  const { t } = useI18n();
  const commandsState = useAsync(() => api.commands(app.slug), [app.slug]);
  const deploymentsState = useAsync(() => api.deployments(app.slug), [app.slug], { pollMs: 15_000 });

  const resources = stream.connected ? stream.resources : app.resources;
  const status = stream.connected ? stream.status : app.status;
  const running = status === "running" || status === "starting" || status === "restarting";
  const dockerDown = stream.dockerUnavailable || status === "unknown";

  const cpuShare = resources ? Math.min(100, (resources.cpuPercent / Math.max(app.cpu, 0.1)) * 100) : 0;

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi
          label={t("metric.uptime")}
          value={humanDuration(resources?.uptimeSeconds)}
          hint={
            resources?.startedAt
              ? t("metric.since", { value: formatDateTime(resources.startedAt) })
              : t("common.unavailable")
          }
        />
        <Kpi
          label={t("metric.cpu")}
          value={resources ? `${resources.cpuPercent.toFixed(1)}%` : "—"}
          hint={t("metric.limitOf", { value: humanCpu(app.cpu) })}
        />
        <Kpi
          label={t("metric.memory")}
          value={resources ? humanBytes(resources.memoryBytes) : "—"}
          hint={t("metric.limitOf", { value: humanRam(app.memoryMb) })}
        />
      </div>

      {dockerDown ? (
        <Alert tone="red">
          {t("overview.dockerUnknown.before")} <strong>{t("status.unknown").toLowerCase()}</strong>{" "}
          {t("overview.dockerUnknown.after")}
        </Alert>
      ) : null}

      <Card
        title={t("overview.usage.title")}
        subtitle={stream.connected ? t("overview.usage.realtime") : t("overview.usage.stale")}
        actions={
          <div className="flex gap-2">
            <Button size="sm" onClick={onReload}>
              {t("common.refresh")}
            </Button>
            <Button size="sm" onClick={stream.refresh} disabled={!stream.connected}>
              {t("overview.reloadStream")}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Meter
            label={t("metric.cpu")}
            value={
              resources
                ? t("metric.ofLimit", { used: `${resources.cpuPercent.toFixed(1)}%`, limit: humanCpu(app.cpu) })
                : t("metric.noData")
            }
            percent={cpuShare}
            tone={cpuShare > 80 ? "amber" : "indigo"}
          />
          <Meter
            label={t("metric.memory")}
            value={
              resources
                ? t("metric.ofLimit", {
                    used: humanBytes(resources.memoryBytes),
                    limit: humanBytes(resources.memoryLimitBytes || app.memoryMb * 1024 * 1024),
                  })
                : t("metric.noData")
            }
            percent={resources?.memoryPercent ?? 0}
            tone={(resources?.memoryPercent ?? 0) > 85 ? "red" : (resources?.memoryPercent ?? 0) > 65 ? "amber" : "green"}
          />
          <div className="grid gap-3 text-[11px] sm:grid-cols-3">
            <div>
              <p className="text-slate-500">{t("overview.pids")}</p>
              <p className="font-mono text-slate-300">{resources ? resources.pids : "—"}</p>
            </div>
            <div>
              <p className="text-slate-500">{t("overview.exitCode")}</p>
              <p className="font-mono text-slate-300">
                {resources?.exitCode === null || resources?.exitCode === undefined ? "—" : resources.exitCode}
              </p>
            </div>
            <div>
              <p className="text-slate-500">{t("overview.diskUsage")}</p>
              <p className="font-mono text-slate-300">{humanBytes(app.diskBytes)}</p>
            </div>
          </div>

          {status === "crashed" && resources?.exitCode !== null && resources?.exitCode !== undefined ? (
            <Alert tone="red">
              {t("overview.crashed.before", { code: resources.exitCode })}{" "}
              <strong>{t("tabs.logs")}</strong> {t("overview.crashed.after")}
            </Alert>
          ) : null}
          {!running && !dockerDown ? (
            <Alert tone="amber">
              {t("overview.stopped.before")} <strong>{t("actions.start")}</strong> {t("overview.stopped.middle")}{" "}
              <InlineCode>/data</InlineCode> {t("overview.stopped.after")}
            </Alert>
          ) : null}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t("overview.containerInfo")} subtitle={t("overview.containerInfo.hint")}>
          <DescriptionList
            items={[
              { label: t("overview.container"), value: <span className="font-mono">botpanel-{app.slug}</span> },
              { label: t("overview.image"), value: <span className="font-mono">{app.image}</span> },
              { label: t("config.runtime"), value: runtimeLabel(app.runtime) },
              { label: t("overview.user"), value: <span className="font-mono">1000:1000 {t("overview.unprivileged")}</span> },
              { label: t("overview.network"), value: <span className="font-mono">botpanel-net-{app.slug} {t("overview.isolated")}</span> },
              {
                label: t("overview.codeMounted"),
                value: (
                  <span className="font-mono">
                    /app → releases/{app.activeRelease || "—"}
                  </span>
                ),
              },
              {
                label: t("overview.dataMounted"),
                value: <span className="font-mono">/data → apps/{app.slug}/shared</span>,
              },
              {
                label: t("config.ports"),
                value:
                  app.ports.length > 0 ? (
                    <span className="font-mono">{app.ports.join(", ")}</span>
                  ) : (
                    t("overview.none")
                  ),
              },
              {
                label: t("overview.restartPolicy"),
                value: app.autoRestart
                  ? app.autoStart
                    ? t("overview.policy.unlessStopped")
                    : t("overview.policy.onFailure")
                  : t("overview.policy.no"),
              },
              { label: t("config.pids"), value: <span className="font-mono">{app.pidsLimit}</span> },
            ]}
          />
        </Card>

        <Card title={t("overview.execution")} subtitle={t("overview.execution.hint")}>
          {commandsState.data?.commands.error ? (
            <Alert tone="red">{commandsState.data.commands.error}</Alert>
          ) : (
            <div className="space-y-3 text-xs">
              <div>
                <p className="text-slate-500">{t("overview.install")}</p>
                <p className="mt-0.5 break-all font-mono text-slate-200">
                  {commandsState.loading
                    ? "…"
                    : (commandsState.data?.commands.installCommand ?? t("overview.noDepsToInstall"))}
                </p>
              </div>
              <div>
                <p className="text-slate-500">{t("overview.start")}</p>
                <p className="mt-0.5 break-all font-mono text-slate-200">
                  {commandsState.loading ? "…" : (commandsState.data?.commands.startCommand ?? "—")}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                <Badge tone="indigo">{t("overview.capsDropped")}</Badge>
                <Badge tone="indigo">no-new-privileges</Badge>
                <Badge tone="indigo">{t("overview.noSwap")}</Badge>
                {app.autoStart ? (
                  <Badge tone="green">{t("overview.autoStartOn")}</Badge>
                ) : (
                  <Badge tone="amber">{t("overview.autoStartOff")}</Badge>
                )}
                {app.autoRestart ? (
                  <Badge tone="green">{t("overview.autoRestartOn")}</Badge>
                ) : (
                  <Badge tone="slate">{t("overview.autoRestartOff")}</Badge>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card title={t("overview.activeVersion")} subtitle={t("overview.activeVersion.hint")}>
        <div className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-slate-500">{t("overview.version")}</p>
            <p className="text-slate-200">{app.activeRelease > 0 ? `v${app.activeRelease}` : t("overview.nonePublished")}</p>
          </div>
          <div>
            <p className="text-slate-500">{t("overview.storedVersions")}</p>
            <p className="text-slate-200">{app.releaseCount}</p>
          </div>
          <div>
            <p className="text-slate-500">{t("overview.createdAt")}</p>
            <p className="text-slate-200">{formatDateTime(app.createdAt)}</p>
          </div>
          <div>
            <p className="text-slate-500">{t("overview.updatedAt")}</p>
            <p className="text-slate-200">
              {formatDateTime(app.updatedAt)} <span className="text-slate-500">({relativeTime(app.updatedAt)})</span>
            </p>
          </div>
        </div>

        {app.activeRelease > 0 ? (
          <div className="mt-4">
            <p className="mb-1 text-[11px] text-slate-500">{t("overview.activeReleaseFiles")}</p>
            <p className="font-mono text-[11px] text-slate-300">
              {app.entry || t("overview.ownCommand")} · {app.depsFile || t("overview.noDepsFile")}
            </p>
          </div>
        ) : null}
      </Card>

      <Card title={t("overview.lastDeploys")} subtitle={t("overview.lastDeploys.hint")} bodyClassName="p-0">
        {deploymentsState.loading ? (
          <div className="flex items-center gap-2 p-4 text-xs text-slate-400">
            <Spinner /> {t("common.loading")}
          </div>
        ) : (
          <ul className="divide-y divide-white/6 text-xs">
            {(deploymentsState.data?.deployments ?? []).slice(0, 6).map((deployment) => (
              <li key={deployment.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <span className="text-slate-300">
                  {deployment.kind === "deploy" ? t("overview.deployment") : deployment.kind}
                  {deployment.releaseSeq ? t("overview.versionOf", { value: deployment.releaseSeq }) : ""}
                </span>
                <Badge tone={deployment.status === "success" ? "green" : deployment.status === "failed" ? "red" : "amber"}>
                  {t(`deploy.status.${deployment.status}`)}
                </Badge>
                <span className="ml-auto text-slate-500">{relativeTime(deployment.startedAt)}</span>
              </li>
            ))}
            {(deploymentsState.data?.deployments.length ?? 0) === 0 ? (
              <li className="px-4 py-4 text-slate-500">{t("overview.noDeployments")}</li>
            ) : null}
          </ul>
        )}
      </Card>

    </div>
  );
}
