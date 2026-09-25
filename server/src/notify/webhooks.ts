import type { AppContext } from "../context.ts";
import type { Store } from "../db.ts";
import type { AppRecord } from "../types.ts";
import type { AppStatus } from "../types.ts";
import { errorMessage } from "../errors.ts";

/** Eventos que um webhook pode assinar. */
export type NotifyKind = "started" | "stopped" | "restarted" | "crashed";

export const NOTIFY_KINDS: NotifyKind[] = ["started", "stopped", "restarted", "crashed"];

export interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  events: NotifyKind[];
  enabled: boolean;
  /** Nome que assina a mensagem no Discord (vazio = nome do painel). */
  username?: string;
  /** Avatar da mensagem no Discord (URL de imagem; vazio = padrão do webhook). */
  avatarUrl?: string;
  /** Texto por evento; placeholders `{app}`, `{slug}` e `{code}`. */
  messages?: Partial<Record<NotifyKind, string>>;
}

export interface WebhookDelivery {
  at: string;
  ok: boolean;
  error?: string;
}

type StoredWebhook = WebhookConfig;

/** Webhooks do Discord (inclui ptb/canary). A URL carrega o token dela. */
export const DISCORD_WEBHOOK_PATTERN =
  /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

const SETTINGS_KEY = "notify.webhooks";
const INTENT_TTL_MS = 90_000;
/** Anti-spam em crash-loop: mesmo evento para a mesma aplicação tem cooldown. */
const SAME_EVENT_COOLDOWN_MS = 60_000;

/**
 * Entrega de avisos para webhooks do Discord configurados pelo administrador.
 * A lista vive na tabela `settings` (persistente) e a entrega nunca bloqueia o
 * fluxo que a disparou: falha de webhook é registrada, não propagada.
 */
export class NotifyService {
  private readonly store: Store;
  private readonly panelName: () => string;
  private readonly intents = new Map<string, number>();
  private readonly deliveries = new Map<string, WebhookDelivery>();

  constructor(store: Store, panelName: () => string) {
    this.store = store;
    this.panelName = panelName;
  }

  list(): StoredWebhook[] {
    const raw = this.store.getSetting(SETTINGS_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as StoredWebhook[];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item) => typeof item?.url === "string" && typeof item?.id === "string");
    } catch {
      return [];
    }
  }

  save(list: StoredWebhook[]): void {
    this.store.setSetting(SETTINGS_KEY, JSON.stringify(list));
  }

  /** Resultado da última entrega de cada webhook (para a interface). */
  lastResult(id: string): WebhookDelivery | null {
    return this.deliveries.get(id) ?? null;
  }

  /**
   * Marca que uma ação manual acabou de acontecer nesta aplicação: o
   * observador de status ignora transições nesse período — quem já notifica é
   * a própria ação, com o tipo exato (evita "reiniciou" virar "caiu + voltou").
   */
  noteIntent(slug: string): void {
    this.intents.set(slug, Date.now());
  }

  hasFreshIntent(slug: string): boolean {
    const at = this.intents.get(slug);
    if (at === undefined) return false;
    if (Date.now() - at > INTENT_TTL_MS) {
      this.intents.delete(slug);
      return false;
    }
    return true;
  }

  /** Envia o aviso para todos os webhooks habilitados que assinam o evento. */
  async dispatch(
    kind: NotifyKind,
    app: { name: string; slug: string; autoRestart?: boolean },
    exitCode?: number | null,
  ): Promise<void> {
    const webhooks = this.list().filter((webhook) => webhook.enabled && webhook.events.includes(kind));
    await Promise.all(webhooks.map((webhook) => this.deliver(webhook, kind, app, exitCode)));
  }

  /** Preenche `{app}`, `{slug}` e `{code}` no texto personalizado. */
  private interpolate(template: string, name: string, slug: string, exitCode: number | null | undefined): string {
    const code = typeof exitCode === "number" ? String(exitCode) : "—";
    return template
      .replace(/\{app\}/g, name)
      .replace(/\{slug\}/g, slug)
      .replace(/\{code\}/g, code)
      .trim();
  }

  /** Envia para um webhook específico (usado pelo botão "testar"). */
  async deliver(
    webhook: StoredWebhook,
    kind: NotifyKind,
    app?: { name: string; slug: string; autoRestart?: boolean },
    exitCode?: number | null,
  ): Promise<boolean> {
    const payload = this.payload(webhook, kind, app, exitCode);
    try {
      const response = await fetch(webhook.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.deliveries.set(webhook.id, { at: new Date().toISOString(), ok: true });
      return true;
    } catch (error) {
      const message = errorMessage(error);
      this.deliveries.set(webhook.id, { at: new Date().toISOString(), ok: false, error: message });
      this.store.addEvent(null, "error", `Falha ao enviar webhook "${webhook.name}": ${message}`);
      return false;
    }
  }

  /**
   * Mensagem no formato de embed do Discord, com cor por tipo de evento. O
   * texto pode ser substituído por webhook (`messages.<evento>`) mantendo o
   * título/cor que identificam o tipo; username e avatar também são por
   * webhook.
   */
  private payload(
    webhook: StoredWebhook,
    kind: NotifyKind,
    app?: { name: string; slug: string; autoRestart?: boolean },
    exitCode?: number | null,
  ): unknown {
    const name = app?.name ?? "Teste";
    const slug = app?.slug ?? "—";
    const footer = { text: this.panelName() };
    const timestamp = new Date().toISOString();
    const custom = webhook.messages?.[kind];
    const author = webhook.username?.trim() || this.panelName();
    const avatar = webhook.avatarUrl?.trim();

    const defaults: Record<NotifyKind, () => string> = {
      started: () => `**${name}** (\`${slug}\`) está em execução.`,
      stopped: () => `**${name}** (\`${slug}\`) foi desligada.`,
      restarted: () => `**${name}** (\`${slug}\`) foi reiniciada.`,
      crashed: () => {
        const code = typeof exitCode === "number" ? ` (código de saída ${exitCode})` : "";
        const hint = app?.autoRestart ? "\nO Docker vai reiniciá-la automaticamente." : "";
        return `**${name}** (\`${slug}\`) falhou${code}.${hint}`;
      },
    };
    const titles: Record<NotifyKind, { title: string; color: number }> = {
      started: { title: "🟢 Aplicação online", color: 0x22c55e },
      stopped: { title: "⚪ Aplicação parada", color: 0x94a3b8 },
      restarted: { title: "🔄 Aplicação reiniciada", color: 0x7c5cff },
      crashed: { title: "🔴 Aplicação caiu", color: 0xef4444 },
    };
    const { title, color } = titles[kind];
    const description = custom?.trim() ? this.interpolate(custom, name, slug, exitCode) : defaults[kind]();

    return {
      username: author,
      ...(avatar ? { avatar_url: avatar } : {}),
      embeds: [{ title, description, color, footer, timestamp }],
    };
  }
}

/**
 * Observador de status: percorre as aplicações periodicamente e detecta o que
 * ninguém viu — o bot que caiu (ou voltou) sem ninguém ter apertado nada. As
 * ações manuais notificam por conta própria (`onLifecycle` no AppService) e
 * marcam uma "intenção" que faz este observador se calar por alguns segundos.
 *
 * A primeira observação de cada aplicação é silenciosa: sem isso, reiniciar o
 * painel dispararia "online" para todos os bots de uma vez.
 */
export function startStatusWatcher(context: AppContext, intervalMs = 10_000): void {
  const last = new Map<string, AppStatus>();
  const seeded = new Set<string>();
  const lastEmit = new Map<string, number>();
  const isLive = (status: AppStatus): boolean => status === "running" || status === "starting";

  const cooled = (slug: string, kind: NotifyKind): boolean => {
    const key = `${slug}:${kind}`;
    const at = lastEmit.get(key) ?? 0;
    if (Date.now() - at < SAME_EVENT_COOLDOWN_MS) return false;
    lastEmit.set(key, Date.now());
    return true;
  };

  const tick = async (): Promise<void> => {
    let apps: AppRecord[];
    try {
      apps = context.store.listApps();
    } catch {
      // Banco fechado (encerramento do painel/fim dos testes): o intervalo
      // continua vivo por uns instantes e não pode derrubar o processo com
      // uma rejeição não tratada.
      return;
    }
    for (const app of apps) {
      try {
        if (app.activeRelease <= 0) {
          last.delete(app.slug);
          seeded.delete(app.slug);
          continue;
        }
        const status = await context.docker.status(context.apps.containerName(app.slug));
        // Daemon fora: estado desconhecido — não atualiza nem notifica.
        if (status === "unknown") continue;

        if (!seeded.has(app.slug)) {
          seeded.add(app.slug);
          last.set(app.slug, status);
          continue;
        }
        const prev = last.get(app.slug) ?? status;
        if (prev === status) continue;
        last.set(app.slug, status);
        if (context.notify.hasFreshIntent(app.slug)) continue;

        const liveBefore = isLive(prev);
        const liveNow = isLive(status);
        const emit = (kind: NotifyKind): void => {
          if (cooled(app.slug, kind)) void context.notify.dispatch(kind, app);
        };

        if (liveBefore && !liveNow) {
          if (status === "restarting") {
            // Política de reinício ativa após uma falha.
            emit("crashed");
            continue;
          }
          const resources = await context.docker.resources(context.apps.containerName(app.slug)).catch(() => null);
          const exit = resources?.exitCode ?? null;
          if (!app.stoppedByUser && exit !== null && exit !== 0) emit("crashed");
          else emit("stopped");
        } else if (!liveBefore && liveNow) {
          // Recuperação automática (crash → Docker reiniciou) ou início fora
          // de uma ação do painel.
          emit("started");
        }
      } catch {
        // Uma aplicação com problema não pode parar o ciclo das outras.
      }
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
}

/** Tipo auxiliar para a assinatura usada pelo AppService. */
export type LifecycleHook = (kind: NotifyKind, app: { name: string; slug: string; autoRestart: boolean }) => void;
