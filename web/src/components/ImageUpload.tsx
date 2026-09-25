import { useRef, useState } from "react";
import { api } from "../api.ts";
import { errorText } from "../hooks.ts";
import { useI18n } from "../i18n/index.tsx";
import { Button, ProgressBar, Spinner, cn } from "./ui.tsx";
import { IconTrash, IconUpload } from "./icons.tsx";

const MAX_INPUT_BYTES = 20 * 1024 * 1024; // antes do recorte
const MAX_EDGE = 4096;

/**
 * Lê o arquivo escolhido e desenha centralizado num canvas quadrado (lado do
 * maior dimensão), cobrindo o quadro — o painel exibe as fotos em círculo, e
 * um recorte previsível evita foto esticada ou cortada de forma estranha.
 */
function squareCrop(file: File, size: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("canvas"));
        return;
      }
      const scale = Math.max(size / image.width, size / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("toBlob"));
        },
        "image/png",
      );
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode"));
    };
    image.src = url;
  });
}

export default function ImageUpload({
  value,
  onChange,
  label,
  hint,
  size = 72,
}: {
  value: string;
  onChange: (url: string) => void;
  label: string;
  hint?: string;
  size?: number;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File): Promise<void> => {
    setError(null);
    if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
      setError(t("imageUpload.badType"));
      return;
    }
    if (file.size > MAX_INPUT_BYTES) {
      setError(t("imageUpload.tooBig"));
      return;
    }
    setBusy(true);
    setPercent(0);
    try {
      // Recorte quadrado no navegador: reduz o tamanho, padroniza o visual e
      // chega no servidor já dentro dos limites.
      const blob = await squareCrop(file, 512);
      const result = await api.uploadImage(blob, `foto.png`, (fraction) => setPercent(Math.round(fraction * 100)));
      onChange(result.image.url);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
      setPercent(0);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-slate-300">{label}</p>
      <div className="flex flex-wrap items-center gap-4">
        <div
          className={cn(
            "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/12 bg-slate-950/60",
            busy && "opacity-70",
          )}
          style={{ width: size, height: size }}
        >
          {value.trim() ? (
            <img
              src={value}
              alt=""
              className="h-full w-full object-cover"
              onError={(event) => {
                (event.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <IconUpload className="h-5 w-5 text-slate-500" />
          )}
          {busy ? (
            <span className="absolute inset-0 flex items-center justify-center bg-slate-950/70">
              <Spinner className="h-5 w-5" />
            </span>
          ) : null}
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="button" disabled={busy} onClick={() => inputRef.current?.click()}>
              <IconUpload className="h-3.5 w-3.5" /> {t("imageUpload.choose")}
            </Button>
            {value.trim() ? (
              <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => onChange("")}>
                <IconTrash className="h-3.5 w-3.5" /> {t("imageUpload.remove")}
              </Button>
            ) : null}
          </div>
          <p className="text-[11px] text-slate-500">{hint ?? t("imageUpload.hint")}</p>
          {busy && percent > 0 ? <ProgressBar percent={percent} /> : null}
          {error ? <p className="text-[11px] text-rose-300">{error}</p> : null}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
    </div>
  );
}
