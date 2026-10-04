import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import type { MetricSample } from "../types.ts";
import { formatDateTime, humanBytes } from "../format.ts";
import { useI18n } from "../i18n/index.tsx";
import { Spinner } from "./ui.tsx";

/**
 * Gráfico de 24 h de CPU e RAM, desenhado em SVG puro (sem biblioteca): duas
 * séries com eixo de tempo compartilhado, a partir das amostras que o painel
 * colhe por minuto. Sem amostras (app recém-criada ou painel reiniciado há
 * pouco) a área fica vazia com um aviso discreto.
 */

const W = 560;
const H = 140;
const PAD_L = 34;
const PAD_R = 6;
const PAD_T = 10;
const PAD_B = 16;

function buildPath(values: number[], max: number): string {
  if (values.length === 0) return "";
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const step = values.length > 1 ? innerW / (values.length - 1) : 0;
  return values
    .map((value, index) => {
      const x = PAD_L + index * step;
      const y = PAD_T + innerH - Math.min(1, Math.max(0, value / max)) * innerH;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export default function MetricsChart({ slug, refreshKey }: { slug: string; refreshKey?: number }) {
  const { t } = useI18n();
  const [samples, setSamples] = useState<MetricSample[] | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .metrics(slug)
      .then((result) => {
        if (alive) setSamples(result.samples);
      })
      .catch(() => {
        if (alive) setSamples([]);
      });
    return () => {
      alive = false;
    };
  }, [slug, refreshKey]);

  const { cpuPath, memPath, maxMem } = useMemo(() => {
    const cpu = samples?.map((sample) => sample.cpuPercent) ?? [];
    const mem = samples?.map((sample) => sample.memoryPercent) ?? [];
    const memMax = Math.max(10, ...(samples?.map((sample) => sample.memoryPercent) ?? []), 10);
    return { cpuPath: buildPath(cpu, 100), memPath: buildPath(mem, memMax), maxMem: memMax };
  }, [samples]);

  if (samples === null) {
    return (
      <div className="flex h-36 items-center justify-center text-slate-500">
        <Spinner className="h-4 w-4" />
      </div>
    );
  }

  const last = samples.length > 0 ? (samples[samples.length - 1] ?? null) : null;
  const firstTs = samples.length > 0 ? (samples[0]?.ts ?? null) : null;
  const lastTs = last?.ts ?? null;

  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-36 w-full" role="img" aria-label={t("metrics.chart")}>
        {/* grade horizontal: 0/50/100% */}
        {[0, 0.5, 1].map((fraction) => {
          const y = PAD_T + (H - PAD_T - PAD_B) * (1 - fraction);
          return <line key={fraction} x1={PAD_L} x2={W - PAD_R} y1={y} y2={y} stroke="currentColor" strokeOpacity={0.08} />;
        })}
        {/* RAM como área (escala própria, % do limite do container) */}
        {memPath ? (
          <path d={`${memPath} L${W - PAD_R},${H - PAD_B} L${PAD_L},${H - PAD_B} Z`} className="fill-emerald-500/10" />
        ) : null}
        {memPath ? <path d={memPath} fill="none" stroke="rgb(16 185 129 / 0.9)" strokeWidth={1.5} /> : null}
        {/* CPU como linha (escala 0–100%) */}
        {cpuPath ? <path d={cpuPath} fill="none" stroke="rgb(124 92 255 / 0.95)" strokeWidth={1.5} /> : null}
        {samples.length === 0 ? (
          <text x={W / 2} y={H / 2} textAnchor="middle" className="fill-slate-500 text-[10px]">
            {t("metrics.empty")}
          </text>
        ) : null}
      </svg>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-[rgb(124_92_255)]" /> {t("metrics.cpu")}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> {t("metrics.memory")}
          </span>
        </span>
        <span className="font-mono">
          {firstTs && lastTs ? `${formatDateTime(firstTs)} → ${formatDateTime(lastTs)}` : ""}
          {last ? ` · ${t("metrics.now")}: ${last.cpuPercent.toFixed(1)}% · ${humanBytes(last.memoryBytes)}` : ""}
        </span>
      </div>
    </div>
  );
}
