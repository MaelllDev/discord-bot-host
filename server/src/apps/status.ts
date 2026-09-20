import type { AppStatus } from "../types.ts";

/**
 * O Docker devolve o **mesmo** código de saída (137, `SIGKILL`) para um
 * `docker stop` e para um processo morto à força. Sem a intenção registrada no
 * banco, um bot parado pelo próprio usuário apareceria como *Falhou* — e a
 * interface ainda sugeriria reinício automático. Só a intenção permite dizer
 * "parado" sem inventar um diagnóstico de falha.
 *
 * Vale tanto para o resumo REST (`/api/apps`) quanto para o canal de tempo real
 * (`/api/apps/:slug/stream`), que precisa da mesma regra: o status do WebSocket
 * sobrepõe o da API enquanto a conexão está aberta.
 */
export function applyStopIntent(status: AppStatus, stoppedByUser: boolean): AppStatus {
  if (stoppedByUser && (status === "crashed" || status === "stopped")) return "stopped";
  return status;
}
