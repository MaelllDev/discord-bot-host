import { useRef, useState } from "react";
import { api } from "../../api.ts";
import { errorText, useAsync } from "../../hooks.ts";
import type { AppSummary, FileEntry } from "../../types.ts";
import { formatDateTime, humanBytes } from "../../format.ts";
import { Alert, Badge, Button, Input, Modal, Spinner, Textarea, InlineCode, cn } from "../ui.tsx";
import { IconDownload, IconFile, IconFolder, IconPlus, IconRefresh, IconTrash, IconUpload } from "../icons.tsx";
import ConfirmDialog from "../ConfirmDialog.tsx";
import type { ConfirmState } from "../ConfirmDialog.tsx";
import { useToast } from "../Toasts.tsx";

interface EditorState {
  path: string;
  content: string;
  original: string;
  binary: boolean;
  truncated: boolean;
  loading: boolean;
}

export default function FilesPanel({ slug, app }: { slug: string; app: AppSummary }) {
  const toast = useToast();
  const [root, setRoot] = useState<"code" | "data">("code");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [folderPrompt, setFolderPrompt] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ from: string; value: string } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const listingState = useAsync(() => api.files(slug, root, path), [slug, root, path]);

  const switchRoot = (next: "code" | "data"): void => {
    setRoot(next);
    setPath("");
    setError(null);
  };

  const openFile = async (entry: FileEntry): Promise<void> => {
    const relative = path.length > 0 ? `${path}/${entry.name}` : entry.name;
    if (entry.type === "directory") {
      setPath(relative);
      return;
    }
    setEditor({ path: relative, content: "", original: "", binary: false, truncated: false, loading: true });
    try {
      const file = await api.readFile(slug, root, relative);
      setEditor({
        path: relative,
        content: file.content,
        original: file.content,
        binary: file.binary,
        truncated: file.truncated,
        loading: false,
      });
    } catch (caught) {
      setEditor(null);
      setError(errorText(caught));
    }
  };

  const saveEditor = async (): Promise<void> => {
    if (!editor) return;
    setBusy(true);
    setError(null);
    try {
      await api.writeFile(slug, root, editor.path, editor.content);
      toast.success(`Arquivo ${editor.path} salvo.`);
      setEditor(null);
      await listingState.reload();
    } catch (caught) {
      setError(errorText(caught));
      toast.error(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const result = await api.uploadFiles(slug, root, path, Array.from(files));
      toast.success(`${result.files} arquivo(s) enviados para ${path || "a raiz"}.`);
      await listingState.reload();
    } catch (caught) {
      setError(errorText(caught));
      toast.error(errorText(caught));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const segments = path.split("/").filter(Boolean);
  const editingCode = root === "code";

  return (
    <div className="space-y-3">
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-[11px]",
          editingCode ? "border-indigo-900/60 bg-indigo-950/30 text-indigo-200" : "border-emerald-900/60 bg-emerald-950/25 text-emerald-200",
        )}
      >
        <div className="flex gap-1 rounded-lg border border-white/8 bg-slate-950/60 p-1">
          <button
            type="button"
            onClick={() => switchRoot("code")}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs transition",
              root === "code" ? "bg-slate-800 text-slate-100" : "text-slate-400 hover:text-slate-200",
            )}
          >
            Código (release {app.activeRelease > 0 ? `v${app.activeRelease}` : "—"})
          </button>
          <button
            type="button"
            onClick={() => switchRoot("data")}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs transition",
              root === "data" ? "bg-slate-800 text-slate-100" : "text-slate-400 hover:text-slate-200",
            )}
          >
            Dados persistentes (/data)
          </button>
        </div>

        <span className="min-w-0 flex-1">
          {editingCode ? (
            <>
              Você está editando os arquivos do <strong>release ativo</strong>. Alterações aqui valem para a versão em
              execução e podem ser sobrescritas no próximo deploy — o ideal é publicar um ZIP novo.
            </>
          ) : (
            <>
              Este diretório é o volume <InlineCode>/data</InlineCode> do container: nunca é apagado por deploy e é onde
              ficam bancos, sessões e configurações.
            </>
          )}
        </span>
      </div>

      <div className="card">
        <header className="flex flex-wrap items-center gap-2 border-b border-white/8 px-4 py-3">
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => void upload(event.target.files)} />
          <Button size="sm" loading={uploading} onClick={() => fileInputRef.current?.click()}>
            <IconUpload className="h-3.5 w-3.5" /> Enviar arquivos
          </Button>
          <Button size="sm" onClick={() => setFolderPrompt("")}>
            <IconPlus className="h-3.5 w-3.5" /> Nova pasta
          </Button>
          <Button size="sm" onClick={() => void listingState.reload()}>
            <IconRefresh className="h-3.5 w-3.5" /> Atualizar
          </Button>
          <span className="ml-auto text-[11px] text-slate-500">
            {listingState.data ? `${listingState.data.entries.length} item(ns)` : ""}
          </span>
        </header>

        <div className="flex flex-wrap items-center gap-1 border-b border-white/8 px-4 py-2 text-xs text-slate-400">
          <button type="button" className="hover:text-slate-200" onClick={() => setPath("")}>
            {root === "code" ? "raiz do código" : "volume /data"}
          </button>
          {segments.map((segment, index) => (
            <span key={segment + index} className="flex items-center gap-1">
              <span className="text-slate-600">/</span>
              <button
                type="button"
                className="hover:text-slate-200"
                onClick={() => setPath(segments.slice(0, index + 1).join("/"))}
              >
                {segment}
              </button>
            </span>
          ))}
        </div>

        <div className="p-4">
          {error ? (
            <div className="mb-3">
              <Alert tone="red">{error}</Alert>
            </div>
          ) : null}

          {root === "code" && app.activeRelease === 0 ? (
            <Alert tone="amber">
              Nenhum release publicado ainda: não existem arquivos de código para navegar. Publique uma versão primeiro.
            </Alert>
          ) : null}

          {listingState.loading ? (
            <div className="flex items-center gap-2 py-6 text-xs text-slate-400">
              <Spinner /> lendo diretório…
            </div>
          ) : null}

          {!listingState.loading && (listingState.data?.entries.length ?? 0) === 0 ? (
            <p className="py-6 text-center text-xs text-slate-500">Pasta vazia.</p>
          ) : null}

          <ul className="divide-y divide-white/6">
            {(listingState.data?.entries ?? []).map((entry) => {
              const relative = path.length > 0 ? `${path}/${entry.name}` : entry.name;
              return (
                <li key={entry.name} className="flex flex-wrap items-center gap-2 py-2 text-xs">
                  <button
                    type="button"
                    onClick={() => void openFile(entry)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="text-slate-500">
                      {entry.type === "directory" ? (
                        <IconFolder className="h-4 w-4" />
                      ) : (
                        <IconFile className="h-4 w-4" />
                      )}
                    </span>
                    <span className={cn("truncate", entry.type === "directory" ? "text-slate-100" : "text-slate-300")}>
                      {entry.name}
                    </span>
                    {entry.type === "symlink" ? <Badge tone="amber">link</Badge> : null}
                    {entry.executable ? <Badge>executável</Badge> : null}
                  </button>

                  <span className="w-20 shrink-0 text-right font-mono text-[11px] text-slate-500">
                    {entry.type === "directory" ? "—" : humanBytes(entry.sizeBytes)}
                  </span>
                  <span className="hidden w-32 shrink-0 text-right text-[11px] text-slate-500 sm:block">
                    {formatDateTime(entry.modifiedAt)}
                  </span>

                  <span className="flex shrink-0 gap-1">
                    {entry.type === "file" ? (
                      <>
                        <button
                          type="button"
                          className="rounded-md px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                          onClick={() => void openFile(entry)}
                        >
                          abrir
                        </button>
                        <a
                          href={api.downloadUrl(slug, root, relative)}
                          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                        >
                          <IconDownload className="h-3 w-3" /> baixar
                        </a>
                      </>
                    ) : null}
                    <button
                      type="button"
                      className="rounded-md px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                      onClick={() => setRenameTarget({ from: relative, value: entry.name })}
                    >
                      renomear
                    </button>
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-950/40"
                      onClick={() =>
                        setConfirm({
                          title: "Excluir item",
                          description: (
                            <p>
                              Remover <span className="font-mono text-slate-100">{relative}</span>{" "}
                              {entry.type === "directory" ? "e todo o conteúdo dela" : "do disco"}? Esta ação não pode ser
                              desfeita.
                            </p>
                          ),
                          confirmLabel: "Excluir",
                          danger: true,
                          run: async () => {
                            try {
                              await api.removeFile(slug, root, relative);
                              toast.success("Item removido.");
                              await listingState.reload();
                            } catch (caught) {
                              toast.error(errorText(caught));
                              throw caught;
                            }
                          },
                        })
                      }
                    >
                      <IconTrash className="h-3 w-3" /> excluir
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <Modal
        open={editor !== null}
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{editor?.path}</span>
            <Badge tone={editingCode ? "indigo" : "green"}>{editingCode ? "código" : "/data"}</Badge>
          </span>
        }
        onClose={() => setEditor(null)}
        wide
        footer={
          <>
            <span className="mr-auto text-[11px] text-slate-500">
              {editor && editor.content !== editor.original ? "alterações não salvas" : "sem alterações"}
            </span>
            <Button variant="ghost" onClick={() => setEditor(null)}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!editor || editor.binary || editor.content === editor.original}
              onClick={() => void saveEditor()}
            >
              Salvar alterações
            </Button>
          </>
        }
      >
        {editor?.loading ? (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <Spinner /> carregando arquivo…
          </div>
        ) : editor?.binary ? (
          <Alert tone="amber">
            Este arquivo parece ser binário e não pode ser editado como texto. Use <strong>baixar</strong> para abri-lo
            localmente.
          </Alert>
        ) : (
          <div className="space-y-2">
            {editor?.truncated ? (
              <Alert tone="amber">
                Arquivo muito grande: apenas os primeiros 512 KB foram carregados. Salvar aqui substituiria o conteúdo
                completo — baixe o arquivo para editá-lo por inteiro.
              </Alert>
            ) : null}
            <Textarea
              rows={20}
              value={editor?.content ?? ""}
              onChange={(event) => setEditor((current) => (current ? { ...current, content: event.target.value } : current))}
              spellCheck={false}
            />
          </div>
        )}
      </Modal>

      <Modal
        open={folderPrompt !== null}
        title="Nova pasta"
        onClose={() => setFolderPrompt(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setFolderPrompt(null)}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => {
                const target = (folderPrompt ?? "").trim();
                if (target.length === 0) return;
                const relative = path.length > 0 ? `${path}/${target}` : target;
                setBusy(true);
                void api
                  .mkdir(slug, root, relative)
                  .then(() => {
                    toast.success(`Pasta ${relative} criada.`);
                    setFolderPrompt(null);
                    return listingState.reload();
                  })
                  .catch((caught: unknown) => {
                    setError(errorText(caught));
                    toast.error(errorText(caught));
                  })
                  .finally(() => setBusy(false));
              }}
            >
              Criar pasta
            </Button>
          </>
        }
      >
        <Input
          value={folderPrompt ?? ""}
          onChange={(event) => setFolderPrompt(event.target.value)}
          placeholder="nome-da-pasta"
          autoFocus
        />
      </Modal>

      <Modal
        open={renameTarget !== null}
        title="Renomear"
        onClose={() => setRenameTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenameTarget(null)}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => {
                if (!renameTarget) return;
                const parent = path.length > 0 ? `${path}/` : "";
                setBusy(true);
                void api
                  .renameFile(slug, root, renameTarget.from, `${parent}${renameTarget.value}`)
                  .then(() => {
                    toast.success("Item renomeado.");
                    setRenameTarget(null);
                    return listingState.reload();
                  })
                  .catch((caught: unknown) => {
                    setError(errorText(caught));
                    toast.error(errorText(caught));
                  })
                  .finally(() => setBusy(false));
              }}
            >
              Renomear
            </Button>
          </>
        }
      >
        <Input
          value={renameTarget?.value ?? ""}
          onChange={(event) => setRenameTarget((current) => (current ? { ...current, value: event.target.value } : current))}
          autoFocus
        />
      </Modal>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
