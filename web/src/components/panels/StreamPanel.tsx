import { useEffect, useMemo, useRef, useState } from "react";
import type { AppStream } from "../../hooks.ts";
import type { AppStatus } from "../../types.ts";
import { statusLabel } from "../../format.ts";
import { useI18n } from "../../i18n/index.tsx";
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
  const { t } = useI18n();
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
              <Spinner className="h-3.5 w-3.5" /> {t("console.reconnecting.before")}{" "}
              <strong>{t("console.not")}</strong> {t("console.reconnecting.after")}
            </span>
          ) : (
            t("console.noConnection")
          )}
        </Alert>
      ) : null}

      {stream.dockerUnavailable ? (
        <Alert tone="red">
          {t("console.dockerDown.before")}
          <strong> {t("console.not")}</strong> {t("console.dockerDown.after")}
        </Alert>
      ) : null}

      {stream.connected && offline ? (
        <Alert tone="amber">
          {t("console.offline.before", { status: statusLabel(appStatus).toLowerCase() })}{" "}
          <strong>{t("actions.start")}</strong> {t("console.offline.after")}
        </Alert>
      ) : null}

      <div className="card flex h-[calc(100vh-16rem)] min-h-[22rem] flex-col overflow-hidden">
        <header className="flex flex-wrap items-center gap-2 border-b border-white/8 px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-slate-100">
            <span className="icon-tile icon-tile-sm icon-tile-neutral">
              <IconTerminal className="h-4 w-4" />
            </span>
            {mode === "logs" ? t("console.titleLogs") : t("console.titleStdin")}
          </h2>
          <Badge tone={stream.connected ? "green" : stream.reconnecting ? "amber" : "red"}>
            {stream.connected
              ? t("console.connected")
              : stream.reconnecting
                ? t("console.reconnecting")
                : t("console.disconnected")}
          </Badge>
          {stderrOnly > 0 ? <Badge tone="red">{t("console.stderr", { count: stderrOnly })}</Badge> : null}

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setAutoscroll((value) => !value)}
              className={cn(
                "rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                autoscroll
                  ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-300"
                  : "border-white/10 bg-white/[0.04] text-slate-400 hover:text-slate-200",
              )}
            >
              {t("console.autoScroll", { state: autoscroll ? t("common.on") : t("common.off") })}
            </button>
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t("console.filter")}
              className="w-28 py-1 text-xs sm:w-40"
            />
            <Button size="sm" onClick={stream.refresh} disabled={!stream.connected} title={t("console.reload.title")}>
              <IconRefresh className="h-3.5 w-3.5" /> {t("console.reload")}
            </Button>
            <Button size="sm" onClick={stream.clear} title={t("console.clear.title")}>
              <IconTrash className="h-3.5 w-3.5" /> {t("console.clear")}
            </Button>
            <Button size="sm" onClick={download}>
              <IconDownload className="h-3.5 w-3.5" /> {t("console.download")}
            </Button>
            {mode === "logs" ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => setAiOpen(true)}
                title={t("console.analyze.title")}
              >
                <IconSparkles className="h-3.5 w-3.5" /> {t("console.analyze")}
              </Button>
            ) : null}
          </div>
        </header>

        {/* Barra de janela: deixa o console com cara de terminal de verdade. */}
        <div className="flex items-center gap-3 border-b border-white/8 bg-slate-950/70 px-4 py-2">
          <span aria-hidden="true" className="flex shrink-0 items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-500/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
          </span>
          <span className="truncate font-mono text-[10.5px] text-slate-500">
            {slug} · {mode === "logs" ? "stdout/stderr" : "stdin"}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-slate-500 tabular-nums">
            {t("console.lineCount", { count: stream.lines.length })}
          </span>
        </div>

        <div ref={containerRef} onScroll={onScroll} className="terminal flex-1 overflow-auto bg-slate-950/60 px-4 py-3">
          {lines.length === 0 ? (
            <p className="text-slate-500">
              {mode === "logs" ? t("console.emptyLogs") : t("console.emptyStdin")}
            </p>
          ) : (
            lines.map((line) => (
              <div
                key={line.id}
                className={cn(
                  "whitespace-pre-wrap break-words",
                  line.stream === "stderr"
                    ? "text-rose-300/90"
                    : line.stream === "system"
                      ? "text-indigo-300/90"
                      : "text-slate-300",
                )}
              >
                {line.line}
              </div>
            ))
          )}
        </div>

        {!autoscroll && !atBottom && lines.length > 0 ? (
          <div className="border-t border-white/8 bg-slate-950/60 px-4 py-1.5 text-right">
            <button
              type="button"
              className="text-[11px] text-indigo-300 hover:text-indigo-200"
              onClick={() => {
                setAutoscroll(true);
                const element = containerRef.current;
                if (element) element.scrollTop = element.scrollHeight;
              }}
            >
              {t("console.goToEnd")}
            </button>
          </div>
        ) : null}

        {mode === "logs" ? (
          <footer className="border-t border-white/8 bg-slate-950/40 px-4 py-2.5">
            <p className="text-[11px] text-slate-500">
              <strong>{t("console.analyze")}</strong> {t("console.aiHint.before")}{" "}
              <span className="font-mono">{t("nav.settings")}</span>{t("console.aiHint.after")}
            </p>
          </footer>
        ) : null}

        {mode === "console" ? (
          <footer className="border-t border-white/8 bg-slate-950/40 px-4 py-3">
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="shrink-0 font-mono text-xs text-indigo-300">
                $
              </span>
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
                placeholder={
                  stream.connected ? t("console.commandPlaceholder") : t("console.noConnection.short")
                }
                className="font-mono text-xs"
                disabled={!stream.connected}
              />
              <Button variant="primary" onClick={submitCommand} disabled={!stream.connected || command.trim().length === 0}>
                {t("console.send")}
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              {t("console.stdinHint.before")} <strong>{t("console.clear")}</strong>{" "}
              {t("console.stdinHint.after")}
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
