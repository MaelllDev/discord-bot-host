import { useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.ts";
import { errorText, useAppStream, useAsync } from "../hooks.ts";
import { humanCpu, humanDuration, humanRam, runtimeLabel } from "../format.ts";
import {
  Alert,
  Badge,
  Button,
  Modal,
  PageHeader,
  SkeletonCard,
  Spinner,
  StatusBadge,
  Tabs,
} from "../components/ui.tsx";
import AppIcon from "../components/AppIcon.tsx";
import { IconPlay, IconRestart, IconStop, IconTrash, IconUpload } from "../components/icons.tsx";
import ConfirmDialog from "../components/ConfirmDialog.tsx";
import type { ConfirmState } from "../components/ConfirmDialog.tsx";
import UpdateCodeDialog from "../components/UpdateCodeDialog.tsx";
import DeploymentLogView from "../components/DeploymentLogView.tsx";
import { useToast } from "../components/Toasts.tsx";
import OverviewPanel from "../components/panels/OverviewPanel.tsx";
import StreamPanel from "../components/panels/StreamPanel.tsx";
import FilesPanel from "../components/panels/FilesPanel.tsx";
import ReleasesPanel from "../components/panels/ReleasesPanel.tsx";
import ConfigPanel from "../components/panels/ConfigPanel.tsx";
import BackupsPanel from "../components/panels/BackupsPanel.tsx";
import { useI18n } from "../i18n/index.tsx";

type Tab = "overview" | "logs" | "console" | "files" | "releases" | "backups" | "config";

export default function AppDetail() {
  const { t } = useI18n();
  const { slug = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();

  const initialDeployment = (location.state as { deploymentId?: number } | null)?.deploymentId ?? null;
  const [tab, setTab] = useState<Tab>(initialDeployment ? "releases" : "overview");
  const [deploymentId, setDeploymentId] = useState<number | null>(initialDeployment);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const appState = useAsync(() => api.app(slug), [slug], { pollMs: 5000 });
  const stream = useAppStream(slug);
  const app = appState.data?.app ?? null;

  const reload = async (): Promise<void> => {
    await appState.reload();
  };

  const run = async (action: "start" | "stop" | "restart"): Promise<void> => {
    setBusy(action);
    setError(null);
    try {
      await api.action(slug, action);
      toast.success(t("apps.detailActionDone", { action: t(`actions.${action}.done`) }));
      await reload();
      stream.refresh();
    } catch (caught) {
      const message = errorText(caught);
      setError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  };

  if (appState.loading && !app) {
    return (
      <div className="space-y-4">
        <SkeletonCard lines={2} />
        <SkeletonCard lines={5} />
      </div>
    );
  }

  if (!app) {
    return (
      <div className="space-y-3">
        <PageHeader title={t("app.singular")} />
        <Alert tone="red">{appState.error ?? t("app.notFound")}</Alert>
        <Link to="/apps">
          <Button>{t("app.backToApps")}</Button>
        </Link>
      </div>
    );
  }

  const liveStatus = stream.connected ? stream.status : app.status;
  const live = liveStatus === "running" || liveStatus === "starting" || liveStatus === "restarting";
  const resources = stream.connected ? stream.resources : app.resources;

  const askDelete = (): void => {
    setConfirm({
      title: t("app.delete.title", { name: app.name }),
      description: (
        <>
          <p>
            {t("app.delete.body.before")} <span className="font-mono">botpanel-{app.slug}</span>{" "}
            {t("app.delete.body.after")}
          </p>
          <p className="mt-2 text-slate-400">
            {t("app.delete.images.before")} <strong>{t("app.delete.images.not")}</strong>{" "}
            {t("app.delete.images.after")}
          </p>
        </>
      ),
      confirmLabel: t("config.deleteApp"),
      danger: true,
      checkbox: {
        label: (
          <span>
            {t("app.delete.checkbox")}
            <span className="block text-[11px] text-slate-500">
              {t("app.delete.checkbox.hint.before")} <span className="font-mono">/data</span>
              {t("app.delete.checkbox.hint.middle")} <span className="font-mono">apps/{app.slug}</span>{"."}
            </span>
          </span>
        ),
      },
      run: async (checked) => {
        try {
          await api.removeApp(app.slug, checked);
          toast.success(t("app.deleted", { name: app.name }));
          navigate("/apps");
        } catch (caught) {
          toast.error(errorText(caught));
          throw caught;
        }
      },
    });
  };

  return (
    <div className="space-y-5">
      <Link
        to="/apps"
        className="inline-flex items-center gap-1 text-[11px] text-slate-500 transition-colors hover:text-slate-300"
      >
        ← {t("nav.apps")}
      </Link>

      {/* Cartão de identidade: ícone grande, nome, estado e as ações da aplicação. */}
      <section className="card relative overflow-hidden p-5">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-24 h-56 w-56 rounded-full bg-indigo-500/12 blur-3xl"
        />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <AppIcon
              app={app}
              size="lg"
              className="ring-1 ring-indigo-400/20 shadow-[0_0_30px_-14px_rgb(124_92_255/0.8)]"
            />
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-xl font-semibold tracking-tight text-slate-50">{app.name}</h1>
                <StatusBadge status={liveStatus} />
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge>
                  <span className="font-mono">{app.slug}</span>
                </Badge>
                <Badge tone="indigo">{runtimeLabel(app.runtime)}</Badge>
                <Badge>{humanRam(app.memoryMb)} · {humanCpu(app.cpu)}</Badge>
                <Badge>
                  <span className="font-mono">{app.image}</span>
                </Badge>
                {app.activeRelease > 0 ? (
                  <Badge tone="indigo">{t("overview.versionTag", { value: app.activeRelease })}</Badge>
                ) : (
                  <Badge tone="amber">{t("app.noVersionPublished")}</Badge>
                )}
                {live && resources && resources.uptimeSeconds > 0 ? (
                  <Badge tone="green">{t("app.upFor", { value: humanDuration(resources.uptimeSeconds) })}</Badge>
                ) : null}
              </div>
              {app.description ? <p className="max-w-prose text-xs text-slate-400">{app.description}</p> : null}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {live ? (
              <Button variant="outline" loading={busy === "stop"} onClick={() => void run("stop")}>
                <IconStop className="h-3.5 w-3.5" /> {t("actions.stop")}
              </Button>
            ) : (
              <Button variant="success" loading={busy === "start"} onClick={() => void run("start")}>
                <IconPlay className="h-3.5 w-3.5" /> {t("actions.start")}
              </Button>
            )}
            <Button loading={busy === "restart"} onClick={() => void run("restart")} disabled={app.activeRelease === 0}>
              <IconRestart className="h-3.5 w-3.5" /> {t("actions.restart")}
            </Button>
            <Button variant="primary" onClick={() => setUpdateOpen(true)}>
              <IconUpload className="h-3.5 w-3.5" /> {t("actions.updateCode")}
            </Button>
            <Button variant="danger" onClick={askDelete}>
              <IconTrash className="h-3.5 w-3.5" /> {t("actions.delete")}
            </Button>
          </div>
        </div>
      </section>

      {error ? <Alert tone="red">{error}</Alert> : null}
      {app.activeRelease === 0 ? (
        <Alert tone="amber">
          {t("app.noReleaseAlert.before")} <strong>{t("actions.updateCode")}</strong>{" "}
          {t("app.noReleaseAlert.after")}
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "overview", label: t("tabs.overview") },
            { id: "console", label: t("tabs.console") },
            { id: "logs", label: t("tabs.logs") },
            { id: "files", label: t("tabs.files") },
            { id: "releases", label: t("tabs.releases", { count: app.releaseCount }) },
            { id: "backups", label: t("tabs.backups") },
            { id: "config", label: t("tabs.config") },
          ]}
        />
        <span className="flex items-center gap-2 text-[11px] text-slate-500">
          {stream.connected ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> {t("app.realtime.connected")}
            </>
          ) : stream.reconnecting ? (
            <>
              <Spinner className="h-3 w-3" /> {t("app.realtime.reconnecting")}
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-slate-600" /> {t("app.realtime.disconnected")}
            </>
          )}
        </span>
      </div>

      <div className="min-w-0 space-y-5">
        {tab === "overview" ? <OverviewPanel app={app} stream={stream} onReload={() => void reload()} /> : null}
        {tab === "logs" ? (
          <StreamPanel slug={slug} stream={stream} mode="logs" appStatus={liveStatus} appName={app.name} />
        ) : null}
        {tab === "console" ? (
          <StreamPanel slug={slug} stream={stream} mode="console" appStatus={liveStatus} appName={app.name} />
        ) : null}
        {tab === "files" ? <FilesPanel slug={slug} app={app} /> : null}
        {tab === "releases" ? (
          <ReleasesPanel
            slug={slug}
            app={app}
            onDeploymentStarted={(id) => setDeploymentId(id)}
            onReload={() => void reload()}
            onOpenUpdate={() => setUpdateOpen(true)}
          />
        ) : null}
        {tab === "backups" ? <BackupsPanel app={app} embedded /> : null}
        {tab === "config" ? (
          <ConfigPanel slug={slug} app={app} onReload={() => void reload()} onRequestDelete={askDelete} />
        ) : null}
      </div>

      <UpdateCodeDialog
        app={app}
        open={updateOpen}
        onClose={() => setUpdateOpen(false)}
        onDeployed={() => {
          void reload();
          stream.refresh();
        }}
      />

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />

      <Modal
        open={deploymentId !== null}
        title={t("app.publishModal")}
        onClose={() => setDeploymentId(null)}
        wide
        footer={
          <Button variant="ghost" onClick={() => setDeploymentId(null)}>
            {t("common.close")}
          </Button>
        }
      >
        {deploymentId !== null ? (
          <DeploymentLogView
            slug={slug}
            deploymentId={deploymentId}
            onFinished={() => {
              void reload();
            }}
          />
        ) : null}
      </Modal>
    </div>
  );
}
