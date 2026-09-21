import { useEffect, useState } from "react";
import { api } from "../../api.ts";
import { errorText, useAsync } from "../../hooks.ts";
import type { AppSummary, BackupRecord } from "../../types.ts";
import { formatDateTime, humanBytes, relativeTime } from "../../format.ts";
import { Alert, Badge, Button, Card, SkeletonRows, Toggle } from "../ui.tsx";
import { IconArchive, IconDownload, IconRefresh, IconTrash } from "../icons.tsx";
import ConfirmDialog from "../ConfirmDialog.tsx";
import type { ConfirmState } from "../ConfirmDialog.tsx";
import { useToast } from "../Toasts.tsx";

function statusBadge(backup: BackupRecord) {
  if (backup.status === "running") return <Badge tone="amber">gerando…</Badge>;
  if (backup.status === "failed") return <Badge tone="red">falhou</Badge>;
  return <Badge tone="green">pronto</Badge>;
}

/**
 * Backups sob demanda de uma aplicação: um ZIP do código do release ativo
 * (sem as pastas de dependências, que o deploy recria) e, se pedido, também do
 * volume persistente `/data`. Todo o trabalho é feito pelo backend — aqui só
 * criamos, baixamos e excluímos.
 */
export default function BackupsPanel({ app, embedded = false }: { app: AppSummary; embedded?: boolean }) {
  const toast = useToast();
  const [includeData, setIncludeData] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const state = useAsync(() => api.backups(app.slug), [app.slug]);
  const list = state.data?.backups ?? [];
  const running = list.some((backup) => backup.status === "running");

  // Enquanto um ZIP está sendo gerado, consulta em intervalos curtos para o
  // status acompanhar a geração. Fora disso não há polling.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void state.reload(), 2000);
    return () => clearInterval(timer);
  }, [running, state.reload]);

  const create = async (): Promise<void> => {
    setBusy("create");
    setError(null);
    try {
      await api.createBackup(app.slug, includeData);
      toast.success(`Backup de "${app.name}" em geração.`);
      await state.reload();
    } catch (caught) {
      const message = errorText(caught);
      setError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (backup: BackupRecord): Promise<void> => {
    setBusy(`delete-${backup.id}`);
    setError(null);
    try {
      await api.deleteBackup(app.slug, backup.id);
      toast.success("Backup excluído.");
      await state.reload();
    } catch (caught) {
      const message = errorText(caught);
      setError(message);
      toast.error(message);
      throw caught;
    } finally {
      setBusy(null);
    }
  };

  const content = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Toggle
          checked={includeData}
          onChange={setIncludeData}
          disabled={busy === "create"}
          label={
            <span>
              Incluir dados persistentes (<span className="font-mono">/data</span>)
              <span className="block text-[11px] text-slate-500">
                Desmarque para guardar apenas o código do release ativo.
              </span>
            </span>
          }
        />
        <Button variant="primary" size="sm" loading={busy === "create"} onClick={() => void create()}>
          <IconArchive className="h-3.5 w-3.5" /> Criar backup
        </Button>
      </div>

      {error ? <Alert tone="red">{error}</Alert> : null}

      <p className="text-[11px] leading-relaxed text-slate-500">
        O ZIP guarda o código do release ativo desta aplicação e, se marcado, o volume{" "}
        <span className="font-mono">/data</span>. As pastas de dependências (<span className="font-mono">node_modules</span>,{" "}
        <span className="font-mono">.botpanel-py</span>) ficam de fora porque o deploy as recria. Os arquivos ficam no
        servidor, na pasta da aplicação.
      </p>

      {state.loading && state.data === null ? (
        <SkeletonRows rows={3} />
      ) : list.length === 0 ? (
        <p className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center text-xs text-slate-500">
          Nenhum backup ainda. Clique em <strong>Criar backup</strong> para gerar o primeiro.
        </p>
      ) : (
        <ul className="divide-y divide-white/5 rounded-lg border border-white/5">
          {list.map((backup) => (
            <li key={backup.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-xs">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-slate-200">
                  <span className="truncate font-mono">{backup.fileName}</span>
                  {statusBadge(backup)}
                  {backup.releaseSeq ? <Badge tone="indigo">v{backup.releaseSeq}</Badge> : null}
                  {backup.includeData ? <Badge>com /data</Badge> : <Badge>só código</Badge>}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {backup.status === "success" ? humanBytes(backup.sizeBytes) : backup.status === "running" ? "calculando…" : "—"} ·{" "}
                  {formatDateTime(backup.createdAt)} ({relativeTime(backup.createdAt)})
                  {backup.status === "failed" && backup.message ? ` · ${backup.message}` : ""}
                </p>
              </div>

              <div className="flex shrink-0 gap-1">
                {backup.status === "success" ? (
                  <a
                    href={api.backupDownloadUrl(app.slug, backup.id)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/10"
                  >
                    <IconDownload className="h-3.5 w-3.5" /> Baixar
                  </a>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === `delete-${backup.id}`}
                  disabled={backup.status === "running"}
                  onClick={() =>
                    setConfirm({
                      title: `Excluir o backup "${backup.fileName}"?`,
                      description: (
                        <p>
                          O arquivo ZIP será apagado do servidor. Isso não afeta o código nem o{" "}
                          <span className="font-mono">/data</span> da aplicação.
                        </p>
                      ),
                      confirmLabel: "Excluir backup",
                      danger: true,
                      run: () => remove(backup),
                    })
                  }
                  title="Excluir"
                >
                  <IconTrash className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end">
        <Button size="sm" onClick={() => void state.reload()}>
          <IconRefresh className="h-3.5 w-3.5" /> Atualizar
        </Button>
      </div>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </div>
  );

  if (embedded) return content;

  return (
    <Card
      title={`Backups de ${app.name}`}
      subtitle={`${list.length} arquivo(s) guardado(s) · pasta da aplicação`}
    >
      {content}
    </Card>
  );
}
