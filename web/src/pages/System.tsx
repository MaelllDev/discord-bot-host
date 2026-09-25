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
  PageHeader,
  SkeletonCard,
  Spinner,
} from "../components/ui.tsx";
import { IconAlert, IconBox, IconCpu, IconDisk, IconMemory, IconServer } from "../components/icons.tsx";
import { useI18n } from "../i18n/index.tsx";

export default function SystemPage() {
  const { t } = useI18n();
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
        <PageHeader title={t("nav.system")} icon={<IconServer className="h-4 w-4" />} />
        <Alert tone="red">{systemState.error ?? t("system.readFailed")}</Alert>
      </div>
    );
  }

  const disk = system.host.disk;
  const memoryUsed = system.host.memoryTotalBytes - system.host.memoryFreeBytes;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("nav.system")}
        icon={<IconServer className="h-4 w-4" />}
        subtitle={t("system.subtitle")}
        actions={
          <Button variant="outline" size="sm" onClick={() => void systemState.reload()}>
            {t("common.refresh")}
          </Button>
        }
      />

      {!dockerOk ? (
        <Alert tone="red" icon={<IconAlert className="h-3.5 w-3.5" />}>
          {t("system.docker.down.before")} <strong>{t("system.docker.down.strong")}</strong>
          {t("system.docker.down.middle")} <em>{t("system.docker.down.unknown")}</em>{" "}
          {t("system.docker.down.after")}
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Docker"
          value={dockerOk ? (system.docker.version ?? t("system.docker.connected")) : t("common.unavailable")}
          hint={
            dockerOk
              ? t("system.docker.apiHint", { value: system.docker.apiVersion ?? "?" })
              : t("system.docker.apiHintUnavailable")
          }
          icon={<IconServer className="h-3.5 w-3.5" />}
        />
        <Kpi
          label={t("system.kpi.containers")}
          value={system.docker.containers === null ? t("system.unknown") : system.docker.containers}
          hint={system.docker.containers === null ? t("system.kpi.containers.hintDown") : t("system.kpi.containers.hint")}
          icon={<IconBox className="h-3.5 w-3.5" />}
        />
        <Kpi
          label={t("system.kpi.running")}
          value={
            system.apps.running === null
              ? t("system.unknown")
              : t("system.kpi.running.value", { running: system.apps.running, total: system.apps.total })
          }
          hint={system.apps.running === null ? t("system.kpi.containers.hintDown") : t("system.kpi.running.hint")}
          icon={<IconServer className="h-3.5 w-3.5" />}
        />
        <Kpi
          label={t("system.kpi.panel")}
          value={`v${system.panel.version ?? "?"}`}
          hint={t("system.kpi.panel.hint", { value: humanDuration(system.panel.uptimeSeconds) })}
          icon={<IconServer className="h-3.5 w-3.5" />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t("system.host.title")} subtitle={system.host.platform}>
          <div className="space-y-4">
            <Meter
              label={t("metric.cpu")}
              value={t("dashboard.cores", { count: system.host.cpuCount })}
              hint={system.host.cpuModel ?? undefined}
              percent={Math.min(100, ((system.host.loadAverage[0] ?? 0) / Math.max(system.host.cpuCount, 1)) * 100)}
              tone="sky"
            />
            <div className="grid grid-cols-3 gap-3 text-[11px]">
              <div>
                <p className="text-slate-500">{t("system.load1")}</p>
                <p className="font-mono text-slate-300">{system.host.loadAverage[0].toFixed(2)}</p>
              </div>
              <div>
                <p className="text-slate-500">{t("system.load5")}</p>
                <p className="font-mono text-slate-300">{system.host.loadAverage[1].toFixed(2)}</p>
              </div>
              <div>
                <p className="text-slate-500">{t("system.load15")}</p>
                <p className="font-mono text-slate-300">{system.host.loadAverage[2].toFixed(2)}</p>
              </div>
            </div>
            <Meter
              label={t("metric.memory")}
              value={t("metric.ofLimit", {
                used: humanBytes(memoryUsed),
                limit: humanBytes(system.host.memoryTotalBytes),
              })}
              hint={t("system.memory.hint", {
                free: humanBytes(system.host.memoryFreeBytes),
                percent: humanPercent((memoryUsed / system.host.memoryTotalBytes) * 100),
              })}
              percent={(memoryUsed / Math.max(system.host.memoryTotalBytes, 1)) * 100}
              tone={memoryUsed / system.host.memoryTotalBytes > 0.85 ? "red" : "green"}
            />
            {disk ? (
              <Meter
                label={t("dashboard.disk")}
                value={t("metric.ofLimit", {
                  used: humanBytes(disk.usedBytes),
                  limit: humanBytes(disk.totalBytes),
                })}
                hint={
                  <>
                    <InlineCode>{disk.path}</InlineCode> · {t("system.disk.free", { value: humanBytes(disk.freeBytes) })}
                  </>
                }
                percent={(disk.usedBytes / Math.max(disk.totalBytes, 1)) * 100}
                tone={disk.usedBytes / disk.totalBytes > 0.9 ? "red" : "indigo"}
              />
            ) : (
              <p className="text-[11px] text-slate-500">{t("system.disk.unavailable")}</p>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <Badge>
                <IconCpu className="h-3 w-3" /> {t("system.cores", { count: system.host.cpuCount })}
              </Badge>
              <Badge>
                <IconMemory className="h-3 w-3" /> {humanBytes(system.host.memoryTotalBytes)}
              </Badge>
              {disk ? (
                <Badge>
                  <IconDisk className="h-3 w-3" /> {t("system.disk.free", { value: humanBytes(disk.freeBytes) })}
                </Badge>
              ) : null}
              <Badge>{system.host.arch}</Badge>
            </div>
          </div>
        </Card>

        <Card title={t("system.env.title")} subtitle={t("system.env.hint")}>
          <DescriptionList
            items={[
              { label: t("system.env.panelName"), value: system.panelName },
              { label: t("system.env.panelVersion"), value: `v${system.panel.version ?? "?"}` },
              { label: "Node.js", value: <span className="font-mono">{system.panel.nodeVersion}</span> },
              {
                label: t("system.env.startedAt"),
                value: t("system.env.startedAt.value", {
                  when: relativeTime(system.panel.startedAt),
                  uptime: humanDuration(system.panel.uptimeSeconds),
                }),
              },
              { label: t("system.env.dataDir"), value: <span className="font-mono">{system.dataDir}</span> },
              { label: t("system.env.dockerSocket"), value: <span className="font-mono">{system.config.dockerSocket}</span> },
              { label: t("system.env.servingAt"), value: <span className="font-mono">{system.config.host}:{system.config.port}</span> },
              { label: t("system.env.instanceId"), value: <span className="font-mono">{system.config.instanceId}</span> },
              {
                label: t("system.env.keepReleases"),
                value:
                  system.config.keepReleases === 0
                    ? t("system.env.keepAll")
                    : t("system.env.keepLast", { count: system.config.keepReleases }),
              },
              { label: t("system.env.maxUpload"), value: `${system.config.maxUploadMb} MB` },
              { label: t("system.env.runUser"), value: <span className="font-mono">{system.config.runUid}:{system.config.runGid}</span> },
              {
                label: t("system.env.cookieSecure"),
                value: system.config.cookieSecure ? t("system.env.enabled") : t("system.env.disabled"),
              },
            ]}
          />
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title={t("system.images.title", { count: system.images.length })}
          subtitle={t("system.images.hint")}
        >
          {system.images.length === 0 ? (
            <p className="text-xs text-slate-500">
              {dockerOk ? t("system.images.none") : t("system.images.unavailable")}
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

        <Card title={t("system.usage.title")} subtitle={t("system.usage.hint")}>
          {usageState.loading && usageState.data === null ? (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Spinner /> {t("system.usage.measuring")}
            </div>
          ) : (usageState.data?.usage.length ?? 0) === 0 ? (
            <EmptyState title={t("system.usage.empty.title")} description={t("system.usage.empty.description")} />
          ) : (
            <ul className="divide-y divide-white/6 text-xs">
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

      <Card title={t("system.events.title")} subtitle={t("system.events.hint")} bodyClassName="p-0">
        <ul className="divide-y divide-white/6">
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
            <li className="px-4 py-4 text-xs text-slate-500">{t("system.events.empty")}</li>
          ) : null}
        </ul>
      </Card>
    </div>
  );
}
