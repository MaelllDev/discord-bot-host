import { useState } from "react";
import type { EnvVar } from "../types.ts";
import { isSensitive, maskSecret } from "../format.ts";
import { useI18n } from "../i18n/index.tsx";
import { Button, Input, cn } from "./ui.tsx";

export default function EnvEditor({ value, onChange }: { value: EnvVar[]; onChange: (next: EnvVar[]) => void }) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});

  const update = (index: number, patch: Partial<EnvVar>): void => {
    onChange(value.map((item, position) => (position === index ? { ...item, ...patch } : item)));
  };

  return (
    <div className="space-y-2">
      {value.length === 0 ? (
        <p className="text-[11px] text-slate-500">{t("env.empty")}</p>
      ) : null}

      {value.map((item, index) => {
        const sensitive = item.secret || isSensitive(item.key);
        const show = revealed[index] === true;
        return (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <Input
              value={item.key}
              onChange={(event) => update(index, { key: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") })}
              placeholder="NOME_DA_VARIAVEL"
              className="w-full font-mono text-xs sm:w-56"
            />
            <Input
              value={show ? item.value : sensitive ? maskSecret(item.value) : item.value}
              onChange={(event) => update(index, { value: event.target.value })}
              onFocus={() => setRevealed((previous) => ({ ...previous, [index]: true }))}
              placeholder={t("env.valuePlaceholder")}
              readOnly={sensitive && !show}
              className="min-w-0 flex-1 font-mono text-xs"
            />
            <button
              type="button"
              onClick={() => update(index, { secret: !item.secret })}
              className={cn(
                "rounded-md border px-2 py-1 text-[11px] transition",
                item.secret ? "border-amber-800/60 bg-amber-950/40 text-amber-300" : "border-white/10 text-slate-400",
              )}
              title={t("env.markSecret")}
            >
              {item.secret ? t("env.secret") : t("env.visible")}
            </button>
            <Button variant="ghost" size="sm" onClick={() => onChange(value.filter((_, position) => position !== index))}>
              ✕
            </Button>
          </div>
        );
      })}

      <Button size="sm" onClick={() => onChange([...value, { key: "", value: "", secret: false }])}>
        ＋ {t("env.add")}
      </Button>
    </div>
  );
}
