import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.ts";
import { useAsync } from "../hooks.ts";
import { humanBytes, humanCpu, humanDuration, humanRam, relativeTime } from "../format.ts";
import AppCard, { isLive } from "../components/AppCard.tsx";
import { useI18n } from "../i18n/index.tsx";
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
  const { t } = useI18n();
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
        title={t("nav.dashboard")}
        subtitle={
          system
            ? t("dashboard.subtitle", {
                apps: system.apps.total,
                docker: system.docker.version ?? "?",
                host: system.host.platform,
              })
            : t("dashboard.loadingSystem")
        }
        icon={<IconActivity className="h-4 w-4" />}
        actions={
          <>
            {lastSync ? (
              <span className="hidden text-[11px] text-slate-500 sm:inline">
                {t("dashboard.synced", { value: relativeTime(lastSync) })}
              </span>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void appsState.reload();
                void systemState.reload();
              }}
            >
              {t("common.refresh")}
            </Button>
          </>
        }
      />

      {!dockerOk ? (
        <Alert tone="red" icon={<IconAlert className="h-3.5 w-3.5" />}>
          {t("dashboard.dockerDown.before")} <strong>{t("status.unknown").toLowerCase()}</strong>{" "}
          {t("dashboard.dockerDown.middle")}{" "}
          <code>{system?.config.dockerSocket ?? "/var/run/docker.sock"}</code>. {t("dashboard.dockerDown.use")}{" "}
          <code>systemctl status docker</code> {t("dashboard.dockerDown.after")}
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label={t("nav.apps")}
          value={apps.length}
          hint={t("dashboard.kpi.apps.hint", { count: system?.apps.total ?? apps.length })}
          icon={<IconApps className="h-4 w-4" />}
          tone="neutral"
        />
        <Kpi
          label={t("dashboard.kpi.online")}
          value={online}
          hint={t("dashboard.kpi.online.hint")}
          icon={<IconActivity className="h-4 w-4" />}
          tone="green"
        />
        <Kpi
          label={t("dashboard.kpi.stopped")}
          value={stopped}
          hint={t("dashboard.kpi.stopped.hint")}
          icon={<IconAlert className="h-4 w-4" />}
          tone="amber"
        />
        <Kpi
          label={t("dashboard.kpi.unknown")}
          value={unknown}
          hint={unknown > 0 ? t("dashboard.kpi.unknown.hint") : t("overview.none")}
          icon={<IconAlert className="h-4 w-4" />}
          tone={unknown > 0 ? "red" : "neutral"}
        />
      </div>

      {!loading && apps.length === 0 ? (
        <Hero
        badge={t("dashboard.hero.badge")}
        title={t("dashboard.hero.title")}
        description={t("dashboard.hero.description")}
          actions={
            <>
              <Link to="/apps/new">
                <Button variant="primary">
                  <IconPlus className="h-4 w-4" /> {t("dashboard.hero.create")}
                </Button>
              </Link>
              <Link to="/system">
                <Button variant="outline">
                  <IconServer className="h-4 w-4" /> {t("dashboard.hero.viewSystem")}
                </Button>
              </Link>
            </>
          }
          footnote={t("dashboard.hero.footnote")}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FeatureTile
          title={t("dashboard.feature.zip.title")}
          description={t("dashboard.feature.zip.description")}
              icon={<IconLayers className="h-4 w-4" />}
            />
            <FeatureTile
          title={t("dashboard.feature.isolated.title")}
          description={t("dashboard.feature.isolated.description")}
              icon={<IconApps className="h-4 w-4" />}
            />
            <FeatureTile
          title={t("dashboard.feature.versions.title")}
          description={t("dashboard.feature.versions.description")}
              icon={<IconArchive className="h-4 w-4" />}
            />
            <FeatureTile
          title={t("dashboard.feature.ai.title")}
          description={t("dashboard.feature.ai.description")}
              icon={<IconSparkles className="h-4 w-4" />}
            />
          </div>
        </Hero>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          title={t("dashboard.usage.title")}
          subtitle={t("dashboard.usage.hint")}
          icon={<IconCpu className="h-4 w-4" />}
          className="lg:col-span-2"
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <Meter
              label={t("dashboard.usage.cpu")}
              value={dockerOk ? `${cpuInUse.toFixed(1)}%` : t("common.unavailable")}
              hint={
                hostCpu !== null
                  ? t("dashboard.usage.coresHint", {
                      count: hostCpu,
                      load: system?.host.loadAverage[0]?.toFixed(2) ?? "—",
                    })
                  : undefined
              }
              percent={hostCpu ? Math.min(100, (cpuInUse / 100 / hostCpu) * 100) : 0}
              tone={cpuInUse > 80 ? "amber" : "indigo"}
            />
            <Meter
              label={t("dashboard.usage.memory")}
              value={dockerOk ? humanBytes(memoryInUse) : t("common.unavailable")}
              hint={hostMemory !== null ? t("dashboard.usage.hostHint", { value: humanBytes(hostMemory) }) : undefined}
              percent={hostMemory ? Math.min(100, (memoryInUse / hostMemory) * 100) : 0}
              tone="green"
            />
          </div>
          <div className="mt-5 flex flex-wrap gap-2 text-[11px] text-slate-500">
            <Badge tone="indigo">
              <IconCpu className="h-3 w-3" />{" "}
              {t("dashboard.usage.allocatedCpu", { value: humanCpu(apps.reduce((total, app) => total + app.cpu, 0)) })}
            </Badge>
            <Badge tone="indigo">
              <IconMemory className="h-3 w-3" />{" "}
              {t("dashboard.usage.allocatedRam", {
                value: humanRam(apps.reduce((total, app) => total + app.memoryMb, 0)),
              })}
            </Badge>
            {system?.host.disk ? (
              <Badge>
                <IconDisk className="h-3 w-3" />{" "}
                {t("dashboard.usage.diskBadge", {
                  used: humanBytes(system.host.disk.usedBytes),
                  total: humanBytes(system.host.disk.totalBytes),
                })}
              </Badge>
            ) : null}
          </div>
        </Card>

        <Card
        title={t("dashboard.capacity.title")}
        subtitle={t("dashboard.capacity.hint")}
        icon={<IconServer className="h-4 w-4" />}
      >
          {system ? (
            <div className="space-y-5">
              <Meter
                label={t("metric.cpu")}
                value={t("dashboard.cores", { count: system.host.cpuCount })}
                hint={system.host.cpuModel ?? undefined}
                percent={Math.min(100, ((system.host.loadAverage[0] ?? 0) / Math.max(system.host.cpuCount, 1)) * 100)}
                tone="sky"
              />
              <Meter
                label={t("metric.memory")}
                value={
                  hostMemoryUsed !== null
                    ? t("metric.ofLimit", {
                        used: humanBytes(hostMemoryUsed),
                        limit: humanBytes(hostMemory),
                      })
                    : "—"
                }
                percent={hostMemory ? ((hostMemoryUsed ?? 0) / hostMemory) * 100 : 0}
                tone={hostMemory && (hostMemoryUsed ?? 0) / hostMemory > 0.85 ? "red" : "green"}
              />
              {system.host.disk ? (
                <Meter
                  label={t("dashboard.disk")}
                  value={`${humanBytes(system.host.disk.usedBytes)} de ${humanBytes(system.host.disk.totalBytes)}`}
                  hint={<span className="font-mono">{system.host.disk.path}</span>}
                  percent={(system.host.disk.usedBytes / Math.max(system.host.disk.totalBytes, 1)) * 100}
                  tone={system.host.disk.usedBytes / system.host.disk.totalBytes > 0.9 ? "red" : "indigo"}
                />
              ) : (
                <p className="text-[11px] text-slate-500">{t("dashboard.diskUnavailable")}</p>
              )}
              <p className="text-[11px] text-slate-500">
          {t("dashboard.panelLine", {
            version: system.panel.version ?? "?",
            node: system.panel.nodeVersion,
            uptime: humanDuration(system.panel.uptimeSeconds),
          })}
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
          title={t("nav.apps")}
          hint={apps.length > 0 ? t("dashboard.appsHint", { count: apps.length }) : undefined}
          action={
            <Link to="/apps" className="text-[11px] font-medium text-indigo-300 transition-colors hover:text-indigo-200">
              {t("dashboard.viewAll")}
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
        title={t("dashboard.empty.title")}
        description={t("dashboard.empty.description")}
            action={
              <Link to="/apps/new">
                <Button variant="primary">
                  <IconPlus className="h-4 w-4" /> {t("dashboard.empty.create")}
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

      <Card
        title={t("dashboard.activity.title")}
        subtitle={t("dashboard.activity.hint")}
        bodyClassName="p-0"
        icon={<IconActivity className="h-4 w-4" />}
      >
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
            <li className="px-5 py-5 text-xs text-slate-500">{t("dashboard.activity.empty")}</li>
          ) : null}
        </ul>
      </Card>
    </div>
  );
}
