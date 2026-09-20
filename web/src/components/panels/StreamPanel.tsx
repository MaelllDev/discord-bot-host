import { useEffect, useMemo, useRef, useState } from "react";
import type { AppStream } from "../../hooks.ts";
import type { AppStatus } from "../../types.ts";
import { statusLabel } from "../../format.ts";
import { Alert, Badge, Button, Input, Spinner, cn } from "../ui.tsx";
import { IconDownload, IconRefresh, IconSparkles, IconTerminal, IconTrash } from "../icons.tsx";
import AiAnalyzeDialog from "../AiAnalyzeDialog.tsx";

export default function StreamPanel({
  slug,
  stream,
  mode,
  appStatus,
  appName,
}: {
  slug: string;
  stream: AppStream;
  mode: "logs" | "console";
  appStatus: AppStatus;
  appName: string;
}) {
  const [autoscroll, setAutoscroll] = useState(true);
  const [aiOpen, setAiOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const lines = useMemo(() => {
    if (filter.trim().length === 0) return stream.lines;
    const needle = filter.trim().toLowerCase();
    return stream.lines.filter((line) => line.line.toLowerCase().includes(needle));
  }, [stream.lines, filter]);

  useEffect(() => {
    if (!autoscroll) return;
    const element = containerRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines, autoscroll]);

  const onScroll = (): void => {
    const element = containerRef.current;
    if (!element) return;
    setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
  };

  const download = (): void => {
    const blob = new Blob([stream.lines.map((line) => line.line).join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slug}-${mode}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const submitCommand = (): void => {
    const value = command.trim();
    if (value.length === 0 || !stream.connected) return;
    stream.send(value);
    setHistory((previous) => [...previous.slice(-49), value]);
    setHistoryIndex(null);
    setCommand("");
  };

  const recallHistory = (direction: -1 | 1): void => {
    if (history.length === 0) return;
    const current = historyIndex ?? history.length;
    const next = Math.min(history.length, Math.max(0, current + direction));
    setHistoryIndex(next >= history.length ? null : next);
    setCommand(next >= history.length ? "" : (history[next] ?? ""));
  };

  const offline = appStatus === "stopped" || appStatus === "crashed";
  const stderrOnly = lines.filter((line) => line.stream === "stderr").length;

  return (
    <div className="space-y-3">
      {!stream.connected ? (
        <Alert tone={stream.reconnecting ? "amber" : "red"}>
          {stream.reconnecting ? (
            <span className="flex items-center gap-2">
              <Spinner className="h-3.5 w-3.5" /> Conexão em tempo real caiu — tentando reconectar ao painel. O estado do
              bot <strong>não</strong> é considerado parado por causa disso.
            </span>
          ) : (
            "Sem conexão em tempo real com o painel. Recarregue a página para abrir um novo canal."
          )}
        </Alert>
      ) : null}

      {stream.dockerUnavailable ? (
        <Alert tone="red">
          O Docker está inacessível: o painel não consegue ler o estado real nem os logs desta aplicação agora. Isso
          <strong> não</strong> significa que o bot está parado.
        </Alert>
      ) : null}

      {stream.connected && offline ? (
        <Alert tone="amber">
          A aplicação está {statusLabel(appStatus).toLowerCase()}. Os logs abaixo são o histórico do container; use{" "}
          <strong>Iniciar</strong> na visão geral para subir de novo.
        </Alert>
      ) : null}

      <div className="card flex h-[calc(100vh-16rem)] min-h-[22rem] flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <IconTerminal className="h-4 w-4 text-slate-400" />
            {mode === "logs" ? "Logs em tempo real" : "Console (stdin)"}
          </h2>
          <Badge tone={stream.connected ? "green" : stream.reconnecting ? "amber" : "red"}>
            {stream.connected ? "conectado" : stream.reconnecting ? "reconectando" : "desconectado"}
          </Badge>
          <Badge>{stream.lines.length} linhas</Badge>
          {stderrOnly > 0 ? <Badge tone="red">{stderrOnly} em stderr</Badge> : null}

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setAutoscroll((value) => !value)}
              className={cn(
                "rounded-md border px-2 py-1 text-[11px] transition",
                autoscroll ? "border-emerald-800/60 bg-emerald-950/40 text-emerald-300" : "border-slate-700 text-slate-400",
              )}
            >
              auto-scroll {autoscroll ? "on" : "off"}
            </button>
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="filtrar…"
              className="w-28 py-1 text-xs sm:w-40"
            />
            <Button size="sm" onClick={stream.refresh} disabled={!stream.connected} title="Reabre o stream de logs">
              <IconRefresh className="h-3.5 w-3.5" /> recarregar
            </Button>
            <Button
              size="sm"
              onClick={stream.clear}
              title="Limpa apenas a visualização — os logs reais do container continuam guardados"
            >
              <IconTrash className="h-3.5 w-3.5" /> limpar
            </Button>
            <Button size="sm" onClick={download}>
              <IconDownload className="h-3.5 w-3.5" /> baixar
            </Button>
            {mode === "logs" ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => setAiOpen(true)}
                title="Envia as últimas linhas desta tela para a IA configurada e explica o erro"
              >
                <IconSparkles className="h-3.5 w-3.5" /> analisar com IA
              </Button>
            ) : null}
          </div>
        </header>

        <div
          ref={containerRef}
          onScroll={onScroll}
          className="terminal flex-1 overflow-auto bg-slate-950/80 px-4 py-3"
        >
          {lines.length === 0 ? (
            <p className="text-slate-500">
              {mode === "logs"
                ? "Sem saída ainda. Quando o processo escrever algo, as linhas aparecem aqui automaticamente."
                : "Envie um comando abaixo para o stdin do processo principal."}
            </p>
          ) : (
            lines.map((line) => (
              <div
                key={line.id}
                className={cn(
                  "whitespace-pre-wrap break-words",
                  line.stream === "stderr" ? "text-rose-300/90" : line.stream === "system" ? "text-sky-300/90" : "text-slate-300",
                )}
              >
                {line.line}
              </div>
            ))
          )}
        </div>

        {!autoscroll && !atBottom && lines.length > 0 ? (
          <div className="border-t border-slate-800 px-4 py-1.5 text-right">
            <button
              type="button"
              className="text-[11px] text-indigo-300 hover:text-indigo-200"
              onClick={() => {
                setAutoscroll(true);
                const element = containerRef.current;
                if (element) element.scrollTop = element.scrollHeight;
              }}
            >
              ir para o fim ↓
            </button>
          </div>
        ) : null}

        {mode === "logs" ? (
          <footer className="border-t border-slate-800 px-4 py-2.5">
            <p className="text-[11px] text-slate-500">
              <strong>Analisar com IA</strong> envia as últimas linhas visíveis para o provedor configurado em{" "}
              <span className="font-mono">Configurações</span>, com tokens e chaves mascarados. O trecho enviado fica
              registrado com o resultado.
            </p>
          </footer>
        ) : null}

        {mode === "console" ? (
          <footer className="border-t border-slate-800 px-4 py-3">
            <div className="flex gap-2">
              <Input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submitCommand();
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    recallHistory(-1);
                    return;
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    recallHistory(1);
                  }
                }}
                placeholder={stream.connected ? "digite um comando e pressione Enter" : "sem conexão com o painel"}
                className="font-mono text-xs"
                disabled={!stream.connected}
              />
              <Button variant="primary" onClick={submitCommand} disabled={!stream.connected || command.trim().length === 0}>
                Enviar
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              O texto vai para o stdin do processo principal do container (funciona quando o bot lê a entrada padrão).
              Use ↑/↓ para o histórico. <strong>Limpar</strong> só apaga a tela; os logs do container permanecem salvos no
              Docker.
            </p>
          </footer>
        ) : null}
      </div>

      <AiAnalyzeDialog
        slug={slug}
        appName={appName}
        logs={stream.lines.map((line) => line.line).join("\n")}
        open={aiOpen}
        onClose={() => setAiOpen(false)}
      />
    </div>
  );
}
