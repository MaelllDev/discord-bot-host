import type { Writable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { isAuthenticated } from "../routes/auth.ts";
import { errorMessage } from "../errors.ts";
import { isDockerUnavailable } from "../docker/service.ts";
import { applyStopIntent } from "../apps/status.ts";

const MAX_STDIN_CHARS = 4096;

interface ClientMessage {
  type?: string;
  data?: string;
}

/**
 * Instante em que a execução atual do container começou. Devolve `null` quando o
 * container nunca subiu (o Docker usa `0001-01-01T00:00:00Z` nesse caso).
 *
 * É o identificador de "qual execução" uma linha de log pertence: o cliente usa
 * isso para limpar a tela quando o bot reinicia em vez de misturar os logs de
 * todas as tentativas (num crash-loop, o mesmo erro aparecia repetido).
 */
function runStartedAt(value: unknown): string | null {
  if (typeof value !== "string" || !/^[12]\d{3}-/.test(value)) return null;
  return value;
}

/**
 * Canal em tempo real da aplicação: logs com follow, métricas a cada 2s e
 * envio de comandos para o stdin do processo (console).
 */
export function registerStreamRoute(server: FastifyInstance, context: AppContext): void {
  server.get("/api/apps/:slug/stream", { websocket: true }, (socket, request: FastifyRequest) => {
    if (!isAuthenticated(request, context)) {
      socket.close(1008, "unauthorized");
      return;
    }

    const slug = (request.params as { slug: string }).slug;
    const app = context.store.getApp(slug);
    const containerName = context.apps.containerName(slug);

    const send = (payload: unknown): void => {
      if (socket.readyState === 1) socket.send(JSON.stringify(payload));
    };

    let closed = false;
    let stopLogs: (() => void) | null = null;
    let stdin: Writable | null = null;
    let statsTimer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      stopLogs?.();
      stopLogs = null;
      if (statsTimer) clearInterval(statsTimer);
      statsTimer = null;
      try {
        stdin?.end();
      } catch {
        // ignora
      }
      stdin = null;
    };

    const publishStats = async (): Promise<void> => {
      if (closed) return;
      try {
        const resources = await context.docker.resources(containerName);
        // Mesma regra do resumo REST: um bot parado pelo usuário sai com código
        // 137 (igual a um processo morto à força) e seria exibido como "Falhou"
        // com aviso de reinício automático. O status do WebSocket sobrepõe o da
        // API enquanto a conexão está aberta, então a intenção precisa ser
        // aplicada aqui também.
        const record = context.store.getApp(slug);
        const status = applyStopIntent(resources?.status ?? "stopped", record?.stoppedByUser ?? false);
        send({
          type: "stats",
          status,
          resources: resources ? { ...resources, status } : null,
        });
      } catch {
        send({ type: "stats", status: "unknown", resources: null });
      }
    };

    const attachLogs = async (tail: number): Promise<void> => {
      const inspected = await context.docker.inspect(containerName);
      if (!inspected) {
        send({
          type: "log",
          stream: "system",
          line: "[painel] nenhum container ativo — publique um release para iniciar a aplicação",
        });
        return;
      }
      // Só a execução atual: o histórico acumulado em restarts anteriores fica
      // de fora, então recarregar a página nunca traz os logs de uma tentativa
      // que já morreu.
      const startedAt = runStartedAt(inspected.State?.StartedAt);
      stopLogs?.();
      stopLogs = await context.docker.followLogs(
        containerName,
        tail,
        (line, streamName) => {
          send({ type: "log", stream: streamName, line, startedAt });
        },
        startedAt ? { since: startedAt } : {},
      );
    };

    /**
     * Avisa no próprio console quando não é possível ler os logs. Sem isto a
     * área de logs fica muda com o daemon fora, e o usuário não distingue
     * "sem saída" de "não consegui buscar a saída".
     */
    const attachLogsSafely = async (tail: number): Promise<void> => {
      try {
        await attachLogs(tail);
      } catch (error) {
        send({
          type: "log",
          stream: "system",
          line: isDockerUnavailable(error)
            ? `[painel] o Docker não está respondendo em "${context.config.dockerSocket}" — não é possível ler os logs agora`
            : `[painel] falha ao ler os logs: ${errorMessage(error)}`,
        });
      }
    };

    const bootstrap = async (): Promise<void> => {
      send({ type: "ready", slug, app: app ? { name: app.name, runtime: app.runtime } : null });
      await publishStats();
      await attachLogsSafely(200);
      // As métricas continuam sendo publicadas mesmo quando os logs falharam.
      statsTimer = setInterval(() => {
        void publishStats();
      }, 2000);
      statsTimer.unref?.();
    };

    void bootstrap();

    socket.on("message", (raw: Buffer | string) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as ClientMessage;
      } catch {
        return;
      }

      if (message.type === "ping") {
        send({ type: "pong" });
        return;
      }

      if (message.type === "refresh") {
        void attachLogsSafely(200);
        void publishStats();
        return;
      }

      if (message.type === "clear") {
        send({ type: "cleared" });
        return;
      }

      if (message.type === "stdin") {
        const data = (message.data ?? "").slice(0, MAX_STDIN_CHARS);
        void (async () => {
          try {
            if (!stdin) {
              const inspected = await context.docker.inspect(containerName);
              if (!inspected) {
                send({ type: "log", stream: "system", line: "[painel] container não está em execução" });
                return;
              }
              stdin = await context.docker.attachStdin(containerName);
              stdin.on("error", () => {
                stdin = null;
              });
            }
            stdin.write(data.endsWith("\n") ? data : `${data}\n`);
            send({ type: "stdin-ack", data });
          } catch (error) {
            stdin = null;
            send({
              type: "log",
              stream: "system",
              line: `[painel] falha ao enviar comando: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        })();
      }
    });

    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
}
