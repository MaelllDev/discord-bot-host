import type { AppContext } from "../context.ts";
import type { Store } from "../db.ts";
import { nowIso } from "../db.ts";
import type { DockerService } from "../docker/service.ts";
import { NotFoundError } from "../errors.ts";
import { containerNameFor } from "./spec.ts";
import type { AppRecord } from "../types.ts";

/**
 * Histórico de métricas: a cada intervalo, percorre as aplicações e guarda uma
 * amostra de CPU/RAM por container. As amostras vivem no SQLite, são podadas
 * pela própria inserção (≈25 h por aplicação) e alimentam o gráfico de 24 h na
 * página da aplicação — sem elas, um vazamento de memória só aparece quando o
 * OOM já matou o container.
 *
 * A amostragem nunca derruba o processo: erro de rede/daemon vira apenas uma
 * iteração perdida, e o banco fechado (encerramento) é silenciosamente ignorado.
 */
export class MetricsService {
  private readonly store: Store;
  private readonly docker: DockerService;
  private readonly running = new Set<string>();

  constructor(store: Store, docker: DockerService) {
    this.store = store;
    this.docker = docker;
  }

  /** Amostras recentes de uma aplicação, em ordem cronológica. */
  history(slug: string): ReturnType<Store["listMetricSamples"]> {
    const app = this.mustGet(slug);
    return this.store.listMetricSamples(app.id);
  }

  /** Coleta uma rodada de amostras para todas as aplicações. */
  async sampleOnce(): Promise<void> {
    let apps: AppRecord[];
    try {
      apps = this.store.listApps();
    } catch {
      // Banco fechado (encerramento do painel): a rodada simplesmente não roda.
      return;
    }
    await Promise.all(apps.map((app) => this.sampleApp(app)));
  }

  private async sampleApp(app: AppRecord): Promise<void> {
    // Uma amostra em curso não pode ser atravessada por outra (locks.run da
    // aplicação não cobre este caminho, então a guarda é própria).
    if (this.running.has(app.slug)) return;
    this.running.add(app.slug);
    try {
      if (app.activeRelease <= 0) return;
      const resources = await this.docker.resources(containerNameFor(app.slug));
      if (!resources) return;
      this.store.insertMetricSample({
        appId: app.id,
        ts: nowIso(),
        status: resources.status,
        cpuPercent: resources.cpuPercent,
        memoryBytes: resources.memoryBytes,
        memoryLimitBytes: resources.memoryLimitBytes,
        memoryPercent: resources.memoryPercent,
        pids: resources.pids,
      });
    } catch {
      // Amostra perdida não é problema: a série continua na próxima rodada.
    } finally {
      this.running.delete(app.slug);
    }
  }

  private mustGet(slug: string): AppRecord {
    const app = this.store.getApp(slug);
    if (!app) throw new NotFoundError(`Aplicação \"${slug}\" não encontrada.`);
    return app;
  }
}

/** Registra o coletor periódico (usado por server.ts e pelos testes). */
export function startMetricsSampler(context: AppContext, intervalMs = 60_000): void {
  const timer = setInterval(() => void context.metrics.sampleOnce().catch(() => undefined), intervalMs);
  timer.unref?.();
  void context.metrics.sampleOnce().catch(() => undefined);
}
