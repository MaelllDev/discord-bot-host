import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { errorText, useAsync } from "../hooks.ts";
import { useI18n } from "../i18n/index.tsx";
import { humanDuration, relativeTime } from "../format.ts";
import type { TunnelState, TunnelView } from "../types.ts";
import {
  Alert,
  Badge,
  Button,
  Card,
  DescriptionList,
  EmptyState,
  FeatureTile,
  Field,
  Hero,
  InlineCode,
  Input,
  PageHeader,
  SkeletonCard,
  Spinner,
  StatusBadge,
  Toggle,
} from "../components/ui.tsx";
import { IconAlert, IconCheck, IconCloud, IconRefresh, IconTrash } from "../components/icons.tsx";
import ConfirmDialog from "../components/ConfirmDialog.tsx";
import type { ConfirmState } from "../components/ConfirmDialog.tsx";
import { useToast } from "../components/Toasts.tsx";

/**
 * Chave de tradução do estado do túnel. `state` descreve a conexão com a
 * Cloudflare (não o container): o painel só mostra "conectado" quando há
 * evidência nos logs do `cloudflared`.
 */
const STATE_TONE: Record<TunnelState, "green" | "slate" | "indigo" | "amber" | "red"> = {
  connected: "green",
  starting: "amber",
  stopped: "slate",
  not_configured: "slate",
  disconnected: "amber",
  error: "red",
  unknown: "slate",
};

/**
 * Chave de tradução do código de erro do backend. O painel prefere o texto
 * redigido guardado junto (`lastError`) quando o código é desconhecido — nunca
 * troca uma explicação por uma chave crua.
 */
function errorKey(code: string | null): string | null {
  return code && code.startsWith("cloudflare.") ? `errors.${code}` : null;
}

export default function Cloudflare() {
  const { t } = useI18n();
  const toast = useToast();
  const state = useAsync(() => api.cloudflare(), [], { pollMs: 15_000 });
  const tunnel = state.data?.tunnel ?? null;

  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [replaceToken, setReplaceToken] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);

  // Preenche o formulário quando o estado chega. O token NUNCA é preenchido:
  // a tela só sabe que ele existe (`tokenSet`), nunca o valor.
  useEffect(() => {
    if (!tunnel || loaded) return;
    setEnabled(tunnel.enabled);
    setToken("");
    setReplaceToken(false);
    setLoaded(true);
  }, [tunnel, loaded]);

  /** Aplica o estado devolvido por uma ação, sem esperar o próximo polling. */
  const apply = (next: TunnelView): void => {
    state.setData({ tunnel: next });
  };

  const run = async (name: string, action: () => Promise<{ tunnel: TunnelView }>, successKey: string): Promise<void> => {
    setBusy(name);
    setFormError(null);
    try {
      const result = await action();
      apply(result.tunnel);
      toast.success(t(successKey));
    } catch (caught) {
      const message = errorText(caught);
      setFormError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<void> => {
    setBusy("save");
    setFormError(null);
    try {
      // Token vazio = manter o que já está salvo (a tela nunca o recebeu de volta).
      // Envia o token quando o campo está editável (ainda não há token salvo,
      // ou o usuário escolheu substituí-lo). Campo vazio = manter o que existe.
      const result = await api.saveCloudflare({
        enabled,
        ...(tokenEditable && token.trim().length > 0 ? { token: token.trim() } : {}),
      });
      apply(result.tunnel);
      setLoaded(false);
      setToken("");
      setReplaceToken(false);
      toast.success(t("cloudflare.saved"));
    } catch (caught) {
      const message = errorText(caught);
      setFormError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  };

  const loadLogs = async (): Promise<void> => {
    setLoadingLogs(true);
    try {
      const result = await api.cloudflareLogs(120);
      setLogs(result.lines);
    } catch (caught) {
      toast.error(errorText(caught));
    } finally {
      setLoadingLogs(false);
    }
  };

  const remove = (): void => {
    setConfirm({
      title: t("cloudflare.remove.title"),
      description: t("cloudflare.remove.description"),
      confirmLabel: t("cloudflare.actions.remove"),
      danger: true,
      run: async () => {
        try {
          const result = await api.removeCloudflare();
          apply(result.tunnel);
          setLoaded(false);
          setLogs(null);
          toast.success(t("cloudflare.removed"));
        } catch (caught) {
          toast.error(errorText(caught));
          throw caught;
        }
      },
    });
  };

  if (state.loading && !tunnel) {
    return (
      <div className="space-y-4">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (!tunnel) {
    return (
      <div className="space-y-3">
        <PageHeader title={t("cloudflare.title")} icon={<IconCloud className="h-4 w-4" />} />
        <Alert tone="red">{state.error ?? t("cloudflare.loadFailed")}</Alert>
      </div>
    );
  }

  const stateKey = `cloudflare.status.${tunnel.state}`;
  const problemKey = errorKey(tunnel.lastErrorCode);
  // Com token já salvo, o campo só reaparece quando o usuário pede para trocar.
  const tokenEditable = !tunnel.tokenSet || replaceToken;
  const healthy = tunnel.state === "connected";
  // Os botões seguem o CONTAINER (o que cada ação realmente opera), não o
  // estado do túnel: com o token errado, por exemplo, o container está no ar e
  // o que resolve é `Restart`/`Disconnect` — não `Connect`.
  const hasContainer = tunnel.containerStatus !== null;
  const containerRunning = tunnel.containerStatus === "running";

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("cloudflare.title")}
        icon={<IconCloud className="h-4 w-4" />}
        subtitle={t("cloudflare.description")}
        actions={
          <Button variant="outline" size="sm" onClick={() => void state.reload()}>
            <IconRefresh className="h-3.5 w-3.5" /> {t("common.refresh")}
          </Button>
        }
      />

      <Hero
        badge={
          <Badge tone={state.data ? STATE_TONE[tunnel.state] : "slate"}>
            {t(stateKey)}
          </Badge>
        }
        title={t("cloudflare.hero.title")}
        description={t("cloudflare.hero.description")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {tunnel.tokenSet && !containerRunning ? (
              <Button
                variant="primary"
                size="sm"
                loading={busy === "connect"}
                onClick={() => void run("connect", api.cloudflareConnect, "cloudflare.connected")}
              >
                {t("cloudflare.actions.connect")}
              </Button>
            ) : null}
            {containerRunning ? (
              <Button
                size="sm"
                loading={busy === "disconnect"}
                onClick={() => void run("disconnect", api.cloudflareDisconnect, "cloudflare.disconnected")}
              >
                {t("cloudflare.actions.disconnect")}
              </Button>
            ) : null}
            {hasContainer ? (
              <Button
                size="sm"
                loading={busy === "restart"}
                onClick={() => void run("restart", api.cloudflareRestart, "cloudflare.restarted")}
              >
                {t("cloudflare.actions.restart")}
              </Button>
            ) : null}
            {tunnel.tokenSet ? (
              <Button
                size="sm"
                loading={busy === "test"}
                onClick={() => void run("test", api.cloudflareTest, "cloudflare.testOk")}
              >
                {t("cloudflare.actions.test")}
              </Button>
            ) : null}
          </div>
        }
      />

      {!tunnel.dockerAvailable ? (
        <Alert tone="red" icon={<IconAlert className="h-3.5 w-3.5" />}>
          {t("errors.cloudflare.dockerUnavailable")}
        </Alert>
      ) : null}

      {tunnel.lastError ? (
        <Alert tone={healthy ? "amber" : "red"} icon={<IconAlert className="h-3.5 w-3.5" />}>
          {problemKey ? t(problemKey) : t("cloudflare.lastError")}
          <span className="mt-1 block text-[11px] text-slate-400">{tunnel.lastError}</span>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title={t("cloudflare.status.title")}
          subtitle={t("cloudflare.status.hint")}
          actions={<StatusBadge status={tunnel.containerStatus ?? "unknown"} />}
        >
          <DescriptionList
            items={[
              {
                label: t("cloudflare.status.connection"),
                value: (
                  <span className="inline-flex items-center gap-2">
                    <Badge tone={STATE_TONE[tunnel.state]}>{t(stateKey)}</Badge>
                  </span>
                ),
              },
              {
                label: t("cloudflare.status.configured"),
                value: tunnel.configured ? t("cloudflare.yes") : t("cloudflare.no"),
              },
              {
                label: t("cloudflare.status.container"),
                value: <InlineCode>{tunnel.containerName}</InlineCode>,
              },
              {
                label: t("cloudflare.status.restartPolicy"),
                value: <InlineCode>{tunnel.restartPolicy ?? t("cloudflare.unknown")}</InlineCode>,
              },
              {
                label: t("cloudflare.status.uptime"),
                value: tunnel.uptimeSeconds === null ? t("cloudflare.unknown") : humanDuration(tunnel.uptimeSeconds),
              },
              {
                label: t("cloudflare.status.lastConnected"),
                value: tunnel.lastConnectedAt ? relativeTime(tunnel.lastConnectedAt) : t("cloudflare.never"),
              },
              {
                label: t("cloudflare.status.image"),
                value: <InlineCode>{tunnel.image}</InlineCode>,
              },
              {
                label: t("cloudflare.status.exitCode"),
                value:
                  tunnel.containerStatus && tunnel.containerStatus !== "running"
                    ? String(tunnel.exitCode ?? t("cloudflare.unknown"))
                    : t("cloudflare.unknown"),
              },
            ]}
          />
        </Card>

        <Card title={t("cloudflare.config.title")} subtitle={t("cloudflare.config.hint")}>
          <div className="space-y-4">
            <Field
              label={t("cloudflare.token")}
              hint={
                tunnel.tokenSet
                  ? t("cloudflare.tokenConfigured", { hint: tunnel.tokenHint })
                  : t("cloudflare.token.hint")
              }
            >
              {!tokenEditable ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300">
                    <IconCheck className="h-3.5 w-3.5" /> {t("cloudflare.tokenConfiguredShort")}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setReplaceToken(true)}>
                    {t("cloudflare.replaceToken")}
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder={t("cloudflare.token.placeholder")}
                    className="min-w-48 flex-1 font-mono text-xs"
                  />
                  {tunnel.tokenSet ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setReplaceToken(false);
                        setToken("");
                      }}
                    >
                      {t("common.cancel")}
                    </Button>
                  ) : null}
                </div>
              )}
            </Field>

            <Toggle
              checked={enabled}
              onChange={setEnabled}
              label={
                <span>
                  {t("cloudflare.enableOnStartup")}
                  <span className="block text-[11px] text-slate-500">{t("cloudflare.enableOnStartup.hint")}</span>
                </span>
              }
            />

            {formError ? <Alert tone="red">{formError}</Alert> : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                loading={busy === "save"}
                onClick={() => void save()}
                disabled={tokenEditable && tunnel.tokenSet && token.trim().length === 0}
              >
                {t("cloudflare.actions.save")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setLoaded(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto text-rose-300 hover:text-rose-200"
                onClick={remove}
                disabled={!tunnel.configured && tunnel.containerStatus === null}
              >
                <IconTrash className="h-3.5 w-3.5" /> {t("cloudflare.actions.remove")}
              </Button>
            </div>
          </div>
        </Card>
      </div>

      <Card
        title={t("cloudflare.logs.title")}
        subtitle={t("cloudflare.logs.hint")}
        actions={
          <Button size="sm" variant="ghost" loading={loadingLogs} onClick={() => void loadLogs()}>
            <IconRefresh className="h-3.5 w-3.5" /> {t("cloudflare.logs.load")}
          </Button>
        }
      >
        {logs === null ? (
          <p className="text-xs text-slate-500">{t("cloudflare.logs.idle")}</p>
        ) : logs.length === 0 ? (
          <EmptyState title={t("cloudflare.logs.empty.title")} description={t("cloudflare.logs.empty.description")} />
        ) : (
          <div className="max-h-72 overflow-y-auto rounded-lg border border-white/10 bg-slate-950/60 p-3">
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate-300">
              {logs.join("\n")}
            </pre>
          </div>
        )}
        <p className="mt-2 text-[11px] text-slate-500">
          {t("cloudflare.logs.redacted")} {tunnel.tokenSet ? t("cloudflare.logs.redacted.hint") : ""}
        </p>
      </Card>

      <Card title={t("cloudflare.info.title")} subtitle={t("cloudflare.info.subtitle")}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <FeatureTile
            icon={<IconCloud className="h-4 w-4" />}
            title={t("cloudflare.info.prereq.title")}
            description={t("cloudflare.info.prereq.body")}
          />
          <FeatureTile
            icon={<IconCloud className="h-4 w-4" />}
            title={t("cloudflare.info.image.title")}
            description={
              <>
                {t("cloudflare.info.image.before")} <InlineCode>{tunnel.image}</InlineCode>
                {t("cloudflare.info.image.after")}
              </>
            }
          />
          <FeatureTile
            icon={<IconRefresh className="h-4 w-4" />}
            title={t("cloudflare.info.restart.title")}
            description={
              <>
                {t("cloudflare.info.restart.before")} <InlineCode>unless-stopped</InlineCode>
                {t("cloudflare.info.restart.after")}
              </>
            }
          />
          <FeatureTile
            icon={<IconCheck className="h-4 w-4" />}
            title={t("cloudflare.info.token.title")}
            description={t("cloudflare.info.token.body")}
          />
        </div>
      </Card>

      {state.loading ? (
        <p className="flex items-center gap-2 text-[11px] text-slate-500">
          <Spinner className="h-3.5 w-3.5" /> {t("cloudflare.refreshing")}
        </p>
      ) : null}

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
