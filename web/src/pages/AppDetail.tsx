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

type Tab = "overview" | "logs" | "console" | "files" | "releases" | "backups" | "config";

export default function AppDetail() {
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
      const label = action === "start" ? "iniciada" : action === "stop" ? "parada" : "reiniciada";
      toast.success(`Aplicação ${label}.`);
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
        <PageHeader title="Aplicação" />
        <Alert tone="red">{appState.error ?? "Aplicação não encontrada."}</Alert>
        <Link to="/apps">
          <Button>Voltar para as aplicações</Button>
        </Link>
      </div>
    );
  }

  const liveStatus = stream.connected ? stream.status : app.status;
  const live = liveStatus === "running" || liveStatus === "starting" || liveStatus === "restarting";
  const resources = stream.connected ? stream.resources : app.resources;

  const askDelete = (): void => {
    setConfirm({
      title: `Excluir "${app.name}"?`,
      description: (
        <>
          <p>
            Serão removidos a aplicação do painel, o container{" "}
            <span className="font-mono">botpanel-{app.slug}</span> e a rede isolada dela.
          </p>
          <p className="mt-2 text-slate-400">
            As imagens Docker <strong>não</strong> são removidas: são compartilhadas entre aplicações e ficam em cache no
            host. Escolha abaixo o que fazer com os arquivos em disco.
          </p>
        </>
      ),
      confirmLabel: "Excluir aplicação",
      danger: true,
      checkbox: {
        label: (
          <span>
            Apagar também os arquivos em disco
            <span className="block text-[11px] text-slate-500">
              Código de todas as versões e o volume <span className="font-mono">/data</span>. Se desmarcado, eles
              permanecem em <span className="font-mono">apps/{app.slug}</span>.
            </span>
          </span>
        ),
      },
      run: async (checked) => {
        try {
          await api.removeApp(app.slug, checked);
          toast.success(`Aplicação "${app.name}" excluída.`);
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
        ← Aplicações
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
                <Badge>
                  <span className="font-mono">{app.image}</span>
                </Badge>
                {app.activeRelease > 0 ? (
                  <Badge tone="indigo">versão {app.activeRelease}</Badge>
                ) : (
                  <Badge tone="amber">nenhuma versão publicada</Badge>
                )}
                {live && resources && resources.uptimeSeconds > 0 ? (
                  <Badge tone="green">no ar há {humanDuration(resources.uptimeSeconds)}</Badge>
                ) : null}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {live ? (
              <Button variant="outline" loading={busy === "stop"} onClick={() => void run("stop")}>
                <IconStop className="h-3.5 w-3.5" /> Parar
              </Button>
            ) : (
              <Button variant="success" loading={busy === "start"} onClick={() => void run("start")}>
                <IconPlay className="h-3.5 w-3.5" /> Iniciar
              </Button>
            )}
            <Button loading={busy === "restart"} onClick={() => void run("restart")} disabled={app.activeRelease === 0}>
              <IconRestart className="h-3.5 w-3.5" /> Reiniciar
            </Button>
            <Button variant="primary" onClick={() => setUpdateOpen(true)}>
              <IconUpload className="h-3.5 w-3.5" /> Atualizar código
            </Button>
            <Button variant="danger" onClick={askDelete}>
              <IconTrash className="h-3.5 w-3.5" /> Excluir
            </Button>
          </div>
        </div>
      </section>

      {error ? <Alert tone="red">{error}</Alert> : null}
      {app.activeRelease === 0 ? (
        <Alert tone="amber">
          Nenhuma versão publicada ainda. Use <strong>Atualizar código</strong> para enviar o ZIP — o container só é
          criado depois do primeiro release.
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "overview", label: "Visão geral" },
            { id: "console", label: "Console" },
            { id: "logs", label: "Logs" },
            { id: "files", label: "Arquivos" },
            { id: "releases", label: `Versões (${app.releaseCount})` },
            { id: "backups", label: "Backups" },
            { id: "config", label: "Configuração" },
          ]}
        />
        <span className="flex items-center gap-2 text-[11px] text-slate-500">
          {stream.connected ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> tempo real conectado
            </>
          ) : stream.reconnecting ? (
            <>
              <Spinner className="h-3 w-3" /> reconectando ao painel…
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-slate-600" /> tempo real desconectado
            </>
          )}
        </span>
      </div>

      <div className="min-w-0 space-y-5">
        {tab === "overview" ? (
          <OverviewPanel
            app={app}
            stream={stream}
            onReload={() => void reload()}
            onUpdateCode={() => setUpdateOpen(true)}
            onDelete={askDelete}
            onEditIcon={() => setTab("config")}
            onAction={(action) => void run(action)}
            busyAction={busy}
          />
        ) : null}
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
        title="Publicando nova versão"
        onClose={() => setDeploymentId(null)}
        wide
        footer={
          <Button variant="ghost" onClick={() => setDeploymentId(null)}>
            Fechar
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
