import { useState } from "react";
import { api } from "../api.ts";
import { useAsync, errorText } from "../hooks.ts";
import { useI18n } from "../i18n/index.tsx";
import { relativeTime } from "../format.ts";
import { Alert, Badge, Button, Card, Field, Input, Spinner, Toggle, cn } from "./ui.tsx";
import { IconPlus, IconTrash } from "./icons.tsx";
import { useToast } from "./Toasts.tsx";

interface WebhookRow {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  /** Identidade opcional da mensagem no Discord. */
  username: string;
  avatarUrl: string;
  /** Texto por evento; vazio = mensagem padrão do painel. */
  messages: Record<string, string>;
}

const EVENT_KEYS: Record<string, { labelKey: string; tone: "green" | "slate" | "indigo" | "red" }> = {
  started: { labelKey: "webhooks.event.started", tone: "green" },
  stopped: { labelKey: "webhooks.event.stopped", tone: "slate" },
  restarted: { labelKey: "webhooks.event.restarted", tone: "indigo" },
  crashed: { labelKey: "webhooks.event.crashed", tone: "red" },
};

function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Gerência dos webhooks de aviso (Discord). A URL é credencial: vem do servidor
 * mascarada e só é reenviada quando o usuário digita uma nova.
 */
export default function WebhooksCard() {
  const { t } = useI18n();
  const toast = useToast();
  const state = useAsync(() => api.webhooks(), []);
  const [drafts, setDrafts] = useState<WebhookRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const rows: WebhookRow[] =
    drafts ??
    (state.data?.webhooks ?? []).map((webhook) => ({
      id: webhook.id,
      name: webhook.name,
      url: "",
      events: webhook.events,
      enabled: webhook.enabled,
      username: webhook.username ?? "",
      avatarUrl: webhook.avatarUrl ?? "",
      messages: webhook.messages ?? {},
    }));

  const edit = (mutate: (current: WebhookRow[]) => WebhookRow[]): void => {
    setDrafts(mutate(rows));
  };

  const commit = async (): Promise<void> => {
    if (!drafts) return;
    setSaving(true);
    try {
      // URL vazia = manter a que já está salva no servidor.
      await api.saveWebhooks(
        drafts.map((row) => ({
          id: row.id,
          name: row.name,
          events: row.events,
          enabled: row.enabled,
          username: row.username.trim(),
          avatarUrl: row.avatarUrl.trim(),
          messages: row.messages,
          ...(row.url.trim() ? { url: row.url.trim() } : {}),
        })),
      );
      setDrafts(null);
      await state.reload();
      toast.success(t("webhooks.saved"));
    } catch (caught) {
      toast.error(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  const test = async (row: WebhookRow): Promise<void> => {
    const url = row.url.trim();
    if (!url) {
      toast.error(t("webhooks.needUrl"));
      return;
    }
    setTesting(row.id);
    try {
      const extra: { username?: string; avatarUrl?: string; message?: string } = {};
      if (row.username?.trim()) extra.username = row.username.trim();
      if (row.avatarUrl?.trim()) extra.avatarUrl = row.avatarUrl.trim();
      if (row.messages?.started?.trim()) extra.message = row.messages.started.trim();
      await api.testWebhook(url, extra);
      toast.success(t("webhooks.testSent"));
    } catch (caught) {
      toast.error(errorText(caught));
    } finally {
      setTesting(null);
    }
  };

  const hasChanges = drafts !== null;
  const invalid = drafts?.some((row) => row.name.trim().length === 0 || (row.url.trim().length > 0 && !row.url.trim().startsWith("https://discord")));

  return (
    <Card
      title={t("webhooks.title")}
      subtitle={t("webhooks.subtitle")}
      actions={
        <Button
          size="sm"
          onClick={() =>
            edit((current) => [
              ...current,
              { id: newId(), name: "", url: "", events: ["crashed"], enabled: true, username: "", avatarUrl: "", messages: {} },
            ])
          }
        >
          <IconPlus className="h-3.5 w-3.5" /> {t("webhooks.add")}
        </Button>
      }
    >
      <div className="space-y-3">
        {state.loading && !state.data ? (
          <div className="flex items-center gap-2 p-3 text-xs text-slate-400">
            <Spinner className="h-4 w-4" /> {t("common.loading")}
          </div>
        ) : null}

        {rows.length === 0 && state.data ? (
          <p className="p-3 text-xs text-slate-500">{t("webhooks.empty")}</p>
        ) : null}

        {rows.map((row, index) => {
          const meta = state.data?.webhooks.find((saved) => saved.id === row.id);
          return (
            <div key={row.id} className="space-y-3 rounded-lg border border-white/10 bg-white/[0.02] p-3.5">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("webhooks.name")}>
                  <Input
                    value={row.name}
                    onChange={(event) => edit((current) => current.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)))}
                    placeholder={t("webhooks.name.placeholder")}
                  />
                </Field>
                <Field label={t("webhooks.url")} hint={meta ? t("webhooks.url.saved", { value: meta.urlMasked }) : undefined}>
                  <Input
                    value={row.url}
                    onChange={(event) => edit((current) => current.map((item, i) => (i === index ? { ...item, url: event.target.value } : item)))}
                    placeholder="https://discord.com/api/webhooks/…"
                    className="font-mono text-xs"
                    autoComplete="off"
                  />
                </Field>
              </div>

              <div>
                <p className="mb-1.5 text-xs font-medium text-slate-300">{t("webhooks.events")}</p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(EVENT_KEYS).map(([event, config]) => {
                    const active = row.events.includes(event);
                    return (
                      <button
                        key={event}
                        type="button"
                        onClick={() =>
                          edit((current) =>
                            current.map((item, i) =>
                              i === index
                                ? { ...item, events: active ? item.events.filter((e) => e !== event) : [...item.events, event] }
                                : item,
                            ),
                          )
                        }
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                          active ? "border-indigo-400/30 bg-indigo-500/15 text-indigo-100" : "border-white/10 text-slate-400 hover:text-slate-200",
                        )}
                      >
                        {t(config.labelKey)}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Identidade opcional da mensagem: quem assina e com qual avatar. */}
              <details className="group rounded-lg border border-white/8 bg-slate-950/40">
                <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:text-slate-100">
                  {t("webhooks.customize")}
                  <span className="text-[10px] text-slate-500 group-open:hidden">{t("webhooks.customize.open")}</span>
                </summary>
                <div className="space-y-3 border-t border-white/8 px-3 py-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t("webhooks.username")} hint={t("webhooks.username.hint")}>
                      <Input
                        value={row.username}
                        onChange={(event) =>
                          edit((current) => current.map((item, i) => (i === index ? { ...item, username: event.target.value } : item)))
                        }
                        placeholder={t("webhooks.username.placeholder")}
                      />
                    </Field>
                    <Field label={t("webhooks.avatarUrl")} hint={t("webhooks.avatarUrl.hint")}>
                      <Input
                        value={row.avatarUrl}
                        onChange={(event) =>
                          edit((current) => current.map((item, i) => (i === index ? { ...item, avatarUrl: event.target.value } : item)))
                        }
                        placeholder="https://…/avatar.png"
                      />
                    </Field>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium text-slate-300">
                      {t("webhooks.messages")}
                      <span className="ml-2 font-normal text-slate-500">{t("webhooks.messages.hint")}</span>
                    </p>
                    {row.events.length === 0 ? (
                      <p className="text-[11px] text-slate-500">{t("webhooks.messages.noEvents")}</p>
                    ) : (
                      row.events.map((event) => (
                        <div key={event}>
                          <p className="mb-1 text-[11px] text-slate-400">{t(EVENT_KEYS[event]?.labelKey ?? event)}</p>
                          <Input
                            value={row.messages[event] ?? ""}
                            onChange={(event2) =>
                              edit((current) =>
                                current.map((item, i) =>
                                  i === index ? { ...item, messages: { ...item.messages, [event]: event2.target.value } } : item,
                                ),
                              )
                            }
                            placeholder={t(`webhooks.placeholder.${event}`)}
                            className="text-xs"
                          />
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </details>

              <div className="flex flex-wrap items-center gap-3">
                <Toggle
                  checked={row.enabled}
                  onChange={(enabled) => edit((current) => current.map((item, i) => (i === index ? { ...item, enabled } : item)))}
                  label={<span className="text-xs text-slate-300">{t("webhooks.enabled")}</span>}
                />
                <Button size="sm" variant="ghost" loading={testing === row.id} onClick={() => void test(row)}>
                  {t("webhooks.test")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-rose-300 hover:text-rose-200"
                  onClick={() => edit((current) => current.filter((_, i) => i !== index))}
                >
                  <IconTrash className="h-3.5 w-3.5" /> {t("common.remove")}
                </Button>
              </div>

              {meta?.lastResult ? (
                <p className="flex items-center gap-2 text-[11px]">
                  {meta.lastResult.ok ? (
                    <Badge tone="green">{t("webhooks.lastOk")}</Badge>
                  ) : (
                    <Badge tone="red">{t("webhooks.lastFail", { error: meta.lastResult.error ?? "" })}</Badge>
                  )}
                  <span className="text-slate-500">{relativeTime(meta.lastResult.at)}</span>
                </p>
              ) : null}
            </div>
          );
        })}

        {state.error ? <Alert tone="red">{state.error}</Alert> : null}
        {invalid ? <Alert tone="amber">{t("webhooks.invalid")}</Alert> : null}

        {hasChanges ? (
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setDrafts(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" loading={saving} disabled={invalid} onClick={() => void commit()}>
              {t("config.save")}
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
