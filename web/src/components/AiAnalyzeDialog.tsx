import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.ts";
import { errorText } from "../hooks.ts";
import type { AiAnalysis } from "../types.ts";
import { formatDateTime, relativeTime } from "../format.ts";
import { Alert, Badge, Button, Field, InlineCode, Modal, Spinner, Textarea } from "./ui.tsx";
import { IconAlert, IconCopy, IconSparkles, IconTrash } from "./icons.tsx";
import { useToast } from "./Toasts.tsx";

const POLL_MS = 1500;

/** Renderiza **negrito** e `código` inline sem interpretar HTML. */
function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index} className="font-semibold text-slate-100">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={index} className="rounded bg-slate-800/80 px-1 py-0.5 font-mono text-[11px] text-slate-200">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={index}>{part}</span>;
  });
}

/**
 * Renderizador mínimo do texto devolvido pelo modelo (títulos, listas, negrito e
 * blocos de código). Nada de HTML cru: tudo passa por nós de texto.
 */
function AnalysisText({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const lines = text.split(/\r?\n/);
    const output: { kind: "heading" | "bullet" | "paragraph" | "code"; text: string }[] = [];
    let code: string[] | null = null;

    for (const line of lines) {
      if (line.trim().startsWith("```")) {
        if (code) {
          output.push({ kind: "code", text: code.join("\n") });
          code = null;
        } else {
          code = [];
        }
        continue;
      }
      if (code) {
        code.push(line);
        continue;
      }
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (/^#{1,6}\s/.test(trimmed)) {
        output.push({ kind: "heading", text: trimmed.replace(/^#{1,6}\s+/, "") });
        continue;
      }
      if (/^[-*•]\s+/.test(trimmed)) {
        output.push({ kind: "bullet", text: trimmed.replace(/^[-*•]\s+/, "") });
        continue;
      }
      output.push({ kind: "paragraph", text: trimmed });
    }
    if (code) output.push({ kind: "code", text: code.join("\n") });
    return output;
  }, [text]);

  return (
    <div className="space-y-2 text-[13px] leading-relaxed text-slate-300">
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          return (
            <h4 key={index} className="pt-2 text-xs font-semibold uppercase tracking-wide text-indigo-200">
              {block.text}
            </h4>
          );
        }
        if (block.kind === "bullet") {
          return (
            <p key={index} className="flex gap-2 pl-1">
              <span className="mt-[3px] text-indigo-300">•</span>
              <span className="min-w-0 flex-1">{renderInline(block.text)}</span>
            </p>
          );
        }
        if (block.kind === "code") {
          return (
            <pre
              key={index}
              className="overflow-x-auto rounded-lg border border-white/10 bg-slate-950/80 p-3 font-mono text-[11.5px] text-slate-200 whitespace-pre"
            >
              {block.text}
            </pre>
          );
        }
        return <p key={index}>{renderInline(block.text)}</p>;
      })}
    </div>
  );
}

function AnalysisResult({ analysis, onCopy }: { analysis: AiAnalysis; onCopy: (text: string) => void }) {
  const [showExcerpt, setShowExcerpt] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <Badge tone="indigo">
          <IconSparkles className="h-3 w-3" /> {analysis.provider} · {analysis.model}
        </Badge>
        <span>{analysis.lineCount} linha(s) enviadas</span>
        <span>· {relativeTime(analysis.createdAt)}</span>
        {analysis.question ? <span className="truncate">· “{analysis.question}”</span> : null}
        <button
          type="button"
          onClick={() => onCopy(analysis.result)}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
        >
          <IconCopy className="h-3 w-3" /> copiar
        </button>
      </div>

      {analysis.status === "running" ? (
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-slate-950/60 px-3 py-6 text-xs text-slate-400">
          <Spinner className="h-4 w-4" /> consultando o modelo… isso pode levar alguns segundos.
        </div>
      ) : analysis.status === "failed" ? (
        <Alert tone="red" icon={<IconAlert className="h-3.5 w-3.5" />}>
          {analysis.error || "A análise falhou."}
        </Alert>
      ) : (
        <div className="rounded-xl border border-white/10 bg-slate-950/40 p-3">
          <AnalysisText text={analysis.result} />
        </div>
      )}

      <div className="rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2">
        <button
          type="button"
          className="text-[11px] text-slate-400 transition hover:text-slate-200"
          onClick={() => setShowExcerpt((value) => !value)}
        >
          {showExcerpt ? "▾" : "▸"} ver o trecho de log que foi enviado (credenciais mascaradas)
        </button>
        {showExcerpt ? (
          <pre className="terminal mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-slate-400">{analysis.excerpt}</pre>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Análise dos logs com IA. O texto enviado é exatamente o buffer que está na
 * tela; o backend recorta as últimas N linhas, mascara credenciais e chama o
 * provedor configurado. O acompanhamento é por consulta, para a tela sobreviver a
 * um recarregamento.
 */
export default function AiAnalyzeDialog({
  slug,
  appName,
  logs,
  open,
  onClose,
}: {
  slug: string;
  appName: string;
  logs: string;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const [question, setQuestion] = useState("");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [providerLabel, setProviderLabel] = useState("");
  const [model, setModel] = useState("");
  const [maxLines, setMaxLines] = useState(200);
  const [history, setHistory] = useState<AiAnalysis[]>([]);
  const [current, setCurrent] = useState<AiAnalysis | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const lineCount = useMemo(() => logs.split("\n").filter((line) => line.length > 0).length, [logs]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const [{ settings, providers }, { analyses }] = await Promise.all([api.aiSettings(), api.aiAnalyses(slug)]);
        if (cancelled) return;
        setEnabled(settings.enabled);
        setMaxLines(settings.maxLines);
        setModel(settings.model);
        setProviderLabel(providers.find((item) => item.id === settings.provider)?.label ?? settings.provider);
        setHistory(analyses);
        // Reabre a análise que ainda estava sendo gerada.
        const running = analyses.find((item) => item.status === "running");
        setCurrent(running ?? null);
      } catch (caught) {
        if (!cancelled) setError(errorText(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, slug]);

  // Consulta o andamento enquanto a análise atual estiver rodando.
  useEffect(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
    if (!open || !current || current.status !== "running") return;

    timer.current = window.setInterval(() => {
      void (async () => {
        try {
          const { analysis } = await api.aiAnalysis(current.id);
          setCurrent(analysis);
          if (analysis.status !== "running") {
            setHistory((previous) => [analysis, ...previous.filter((item) => item.id !== analysis.id)]);
          }
        } catch {
          // rede oscilou: a próxima volta tenta de novo
        }
      })();
    }, POLL_MS);

    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
      timer.current = null;
    };
  }, [open, current]);

  const analyze = async (): Promise<void> => {
    setSending(true);
    setError(null);
    try {
      const { analysis } = await api.aiAnalyze(slug, logs, question);
      setCurrent(analysis);
      setHistory((previous) => [analysis, ...previous]);
      toast.success("Análise enviada ao provedor de IA.");
    } catch (caught) {
      const message = errorText(caught);
      setError(message);
      toast.error(message);
    } finally {
      setSending(false);
    }
  };

  const remove = async (analysis: AiAnalysis): Promise<void> => {
    try {
      await api.deleteAiAnalysis(analysis.id);
      setHistory((previous) => previous.filter((item) => item.id !== analysis.id));
      setCurrent((value) => (value?.id === analysis.id ? null : value));
      toast.success("Análise removida.");
    } catch (caught) {
      toast.error(errorText(caught));
    }
  };

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Análise copiada.");
    } catch {
      toast.error("Não foi possível copiar — selecione o texto manualmente.");
    }
  };

  return (
    <Modal open={open} title={`Analisar logs com IA — ${appName}`} onClose={onClose} wide>
      <div className="space-y-4">
        {enabled === false ? (
          <Alert tone="amber" icon={<IconAlert className="h-3.5 w-3.5" />}>
            A análise com IA está desativada. Configure o provedor e a sua chave em{" "}
            <Link to="/settings" className="underline hover:text-amber-100" onClick={onClose}>
              Configurações → Análise de logs com IA
            </Link>
            .
          </Alert>
        ) : (
          <Alert tone="slate" icon={<IconAlert className="h-3.5 w-3.5" />}>
            Serão enviadas as últimas <strong>{maxLines}</strong> linhas do que está na tela ({lineCount} disponíveis) para{" "}
            <strong>{providerLabel || "o provedor configurado"}</strong>
            {model ? ` (${model})` : ""}. Tokens, chaves e senhas são mascarados antes do envio — ainda assim, revise se os
            logs contêm algo que você não quer compartilhar.
          </Alert>
        )}

        {error ? <Alert tone="red">{error}</Alert> : null}

        <Field label="Pergunta (opcional)" hint="Deixe em branco para pedir um diagnóstico geral do que está errado.">
          <Textarea
            rows={2}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ex.: por que o bot reinicia de tempo em tempo?"
            maxLength={500}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            loading={sending}
            disabled={enabled !== true || logs.trim().length === 0}
            onClick={() => void analyze()}
          >
            <IconSparkles className="h-3.5 w-3.5" /> Analisar com IA
          </Button>
          {lineCount === 0 ? (
            <span className="text-[11px] text-amber-300">
              Não há linhas na tela ainda — rode a aplicação e tente de novo.
            </span>
          ) : (
            <span className="text-[11px] text-slate-500">
              O resultado fica salvo nesta aplicação e pode ser reaberto depois.
            </span>
          )}
        </div>

        {current ? (
          <div className="rounded-xl border border-white/10 bg-slate-900/40 p-3">
            <AnalysisResult analysis={current} onCopy={(text) => void copy(text)} />
          </div>
        ) : null}

        {history.length > 1 ? (
          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-300">Análises anteriores</p>
            <ul className="divide-y divide-white/5 rounded-xl border border-white/5">
              {history
                .filter((item) => item.id !== current?.id)
                .map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                    <Badge tone={item.status === "success" ? "green" : item.status === "failed" ? "red" : "amber"}>
                      {item.status === "success" ? "concluída" : item.status === "failed" ? "falhou" : "em andamento"}
                    </Badge>
                    <span className="text-slate-300">
                      {item.provider} · {item.model}
                    </span>
                    <span className="text-slate-500">{formatDateTime(item.createdAt)}</span>
                    {item.question ? <span className="truncate text-slate-400">“{item.question}”</span> : null}
                    <div className="ml-auto flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setCurrent(item)}>
                        ver
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void remove(item)}
                        title="Remover análise"
                      >
                        <IconTrash className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
            </ul>
          </div>
        ) : null}

        <p className="text-[11px] text-slate-500">
          A chamada é feita pelo servidor do painel, direto ao provedor escolhido, usando a chave salva em{" "}
          <InlineCode>/api/ai/settings</InlineCode>. Nada é enviado sem você clicar em analisar.
        </p>
      </div>
    </Modal>
  );
}
