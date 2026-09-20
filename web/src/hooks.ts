import { useCallback, useEffect, useRef, useState } from "react";
import type { DependencyList } from "react";
import { ApiError, api } from "./api.ts";
import type { AppStatus, ContainerResources, StreamLine } from "./types.ts";

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (value: T | null) => void;
}

/**
 * Carrega dados assíncronos com recarga manual e polling opcional. O polling
 * pausa quando a aba está oculta — evita requisições que ninguém está vendo.
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: DependencyList,
  options: { pollMs?: number; enabled?: boolean } = {},
): AsyncState<T> {
  const { pollMs, enabled = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(async () => {
    try {
      const result = await loaderRef.current();
      setData(result);
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void reload();
    if (!pollMs) return;

    const tick = (): void => {
      if (document.visibilityState === "hidden") return;
      void reload();
    };
    const timer = setInterval(tick, pollMs);

    // Ao voltar para a aba, atualiza imediatamente em vez de esperar o ciclo.
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, pollMs, enabled, ...deps]);

  return { data, error, loading, reload, setData };
}

export interface AppStream {
  lines: StreamLine[];
  status: AppStatus;
  resources: ContainerResources | null;
  /** WebSocket aberto e recebendo dados. */
  connected: boolean;
  /** Tentando reconectar (o painel ou o navegador perdeu a conexão). */
  reconnecting: boolean;
  /** O painel não conseguiu falar com o Docker: estado real desconhecido. */
  dockerUnavailable: boolean;
  send: (data: string) => void;
  refresh: () => void;
  clear: () => void;
}

const MAX_LINES = 2000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10_000;

/**
 * Canal em tempo real (logs + métricas + console) da aplicação. Reconecta
 * sozinho com backoff quando o WebSocket cai, e nunca apresenta "parado" só
 * porque o painel perdeu a conexão.
 */
export function useAppStream(slug: string | null): AppStream {
  const [lines, setLines] = useState<StreamLine[]>([]);
  const [status, setStatus] = useState<AppStatus>("unknown");
  const [resources, setResources] = useState<ContainerResources | null>(null);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const counter = useRef(0);

  useEffect(() => {
    if (!slug) return;

    // Todo o estado da conexão pertence a ESTA execução do efeito. Antes, o
    // socket antigo (de outra aplicação) podia disparar o seu `onclose` depois
    // da troca de página, agendar a reconexão e voltar a escrever no mesmo
    // estado — era isso que fazia status, uptime e logs de um bot aparecerem
    // no outro, alternando na tela.
    let disposed = false;
    let attempt = 0;
    let timer: number | null = null;
    let socket: WebSocket | null = null;
    // Instante em que começou a execução que está na tela. O servidor marca
    // cada linha com o início da execução dela; quando o valor avança, o
    // container reiniciou e o histórico visível não vale mais.
    let currentRun: string | null = null;

    setLines([]);
    setStatus("unknown");
    setResources(null);
    setConnected(false);
    setReconnecting(false);

    const connect = (): void => {
      if (disposed) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${protocol}://${window.location.host}/api/apps/${encodeURIComponent(slug)}/stream`);
      socket = ws;

      ws.onopen = () => {
        if (disposed) return;
        attempt = 0;
        socketRef.current = ws;
        setConnected(true);
        setReconnecting(false);
        // O servidor reenvia as últimas linhas ao abrir: limpar evita duplicar
        // o histórico antigo na tela depois de uma queda de conexão.
        setLines([]);
      };

      ws.onclose = () => {
        // Só mexe nas referências se este socket ainda for o atual: o close de
        // uma conexão antiga não pode derrubar a referência da nova.
        if (socket === ws) socket = null;
        if (socketRef.current === ws) socketRef.current = null;
        if (disposed) return;
        setConnected(false);
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
        attempt += 1;
        setReconnecting(true);
        timer = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        if (!disposed) setConnected(false);
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        if (disposed) return;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          return;
        }

        if (message["type"] === "log") {
          // Timestamps do Docker vêm sempre no mesmo formato UTC, então a
          // comparação de strings já ordena cronologicamente.
          const runId = typeof message["startedAt"] === "string" ? message["startedAt"] : null;
          let reset = false;
          if (runId !== null) {
            if (currentRun === null) {
              currentRun = runId;
            } else if (runId > currentRun) {
              currentRun = runId;
              reset = true;
            } else if (runId < currentRun) {
              // Linha de uma execução antiga (replay atrasado): descarta.
              return;
            }
          }

          const added: StreamLine[] = [];
          if (reset) {
            counter.current += 1;
            added.push({
              id: counter.current,
              stream: "system",
              line: "[painel] o container iniciou uma nova execução — histórico anterior limpo",
            });
          }
          counter.current += 1;
          added.push({
            id: counter.current,
            stream: (message["stream"] as StreamLine["stream"]) ?? "stdout",
            line: String(message["line"] ?? ""),
          });

          setLines((previous) => {
            const next = [...(reset ? [] : previous), ...added];
            return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
          });
          return;
        }

        if (message["type"] === "stats") {
          setStatus((message["status"] as AppStatus) ?? "unknown");
          setResources((message["resources"] as ContainerResources | null) ?? null);
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      const current = socket;
      socket = null;
      if (socketRef.current === current) socketRef.current = null;
      current?.close();
    };
  }, [slug]);

  const send = useCallback((data: string) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type: "stdin", data }));
  }, []);

  const refresh = useCallback(() => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type: "refresh" }));
  }, []);

  const clear = useCallback(() => setLines([]), []);

  return {
    lines,
    status,
    resources,
    connected,
    reconnecting,
    dockerUnavailable: connected && status === "unknown",
    send,
    refresh,
    clear,
  };
}

export interface DeploymentState {
  log: string;
  status: "running" | "success" | "failed";
  error: string | null;
  finished: boolean;
}

/**
 * Acompanha um deployment. O backend não empurra eventos de deploy por
 * WebSocket, então a leitura é feita por consulta enquanto o status for
 * `running` — e para assim que ele termina.
 */
export function useDeployment(
  slug: string | null,
  deploymentId: number | null,
  onFinished?: (status: "success" | "failed") => void,
): DeploymentState {
  const [state, setState] = useState<DeploymentState>({ log: "", status: "running", error: null, finished: false });
  const finishedRef = useRef(false);
  const callbackRef = useRef(onFinished);
  callbackRef.current = onFinished;

  useEffect(() => {
    if (!slug || deploymentId === null) return;
    finishedRef.current = false;
    setState({ log: "", status: "running", error: null, finished: false });
    let cancelled = false;
    let timer: number | undefined;

    const poll = async (): Promise<void> => {
      try {
        const result = await api.deployment(slug, deploymentId);
        if (cancelled) return;
        const status = result.deployment.status;
        setState({ log: result.deployment.log, status, error: null, finished: status !== "running" });
        if (status !== "running") {
          if (!finishedRef.current) {
            finishedRef.current = true;
            callbackRef.current?.(status);
          }
          return;
        }
      } catch (caught) {
        if (!cancelled) setState((current) => ({ ...current, error: errorText(caught) }));
        return;
      }
      timer = window.setTimeout(() => void poll(), 1000);
    };

    timer = window.setTimeout(() => void poll(), 400);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [slug, deploymentId]);

  return state;
}

/** Aguarda um deployment terminar, consultando a API a cada intervalo. */
export async function waitForDeployment(
  slug: string,
  deploymentId: number,
  onUpdate: (log: string, status: string) => void,
  fetchDeployment: (slug: string, id: number) => Promise<{ deployment: { log: string; status: string } }>,
  intervalMs = 1000,
): Promise<void> {
  for (;;) {
    const result = await fetchDeployment(slug, deploymentId);
    onUpdate(result.deployment.log, result.deployment.status);
    if (result.deployment.status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
