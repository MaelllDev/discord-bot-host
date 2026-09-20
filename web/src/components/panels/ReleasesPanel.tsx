import { useState } from "react";
import { api } from "../../api.ts";
import { errorText, useAsync } from "../../hooks.ts";
import type { AppSummary } from "../../types.ts";
import { formatDateTime, humanBytes, relativeTime } from "../../format.ts";
import { Alert, Badge, Button, Card, Modal, SkeletonRows, Spinner } from "../ui.tsx";
import { IconRefresh, IconRestart, IconTrash, IconUpload } from "../icons.tsx";
import DeploymentLogView from "../DeploymentLogView.tsx";
import ConfirmDialog from "../ConfirmDialog.tsx";
import type { ConfirmState } from "../ConfirmDialog.tsx";
import { useToast } from "../Toasts.tsx";

export default function ReleasesPanel({
  slug,
  app,
  onDeploymentStarted,
  onReload,
  onOpenUpdate,
}: {
  slug: string;
  app: AppSummary;
  onDeploymentStarted: (deploymentId: number) => void;
  onReload: () => void;
  onOpenUpdate: () => void;
}) {
  const toast = useToast();
  const releasesState = useAsync(() => api.releases(slug), [slug], { pollMs: 15_000 });
  const deploymentsState = useAsync(() => api.deployments(slug), [slug], { pollMs: 15_000 });

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [logDeployment, setLogDeployment] = useState<number | null>(null);

  const activeRelease = releasesState.data?.activeRelease ?? app.activeRelease;
  const releases = releasesState.data?.releases ?? [];
  const sorted = releases.slice().sort((a, b) => b.seq - a.seq);

  const activate = async (seq: number): Promise<void> => {
    setBusy(`activate-${seq}`);
    setError(null);
    try {
      await api.activateRelease(slug, seq);
      toast.success(`Versão v${seq} ativada. O volume /data foi preservado.`);
      await releasesState.reload();
      onReload();
    } catch (caught) {
      const message = errorText(caught);
      setError(message);
      toast.error(message);
      throw caught;
    } finally {
      setBusy(null);
    }
  };

  const removeRelease = async (seq: number): Promise<void> => {
    setBusy(`delete-${seq}`);
    setError(null);
    try {
      await api.deleteRelease(slug, seq);
      toast.success(`Versão v${seq} removida do disco.`);
      await releasesState.reload();
    } catch (caught) {
      const message = errorText(caught);
      setError(message);
      toast.error(message);
      throw caught;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <Card
        title="Publicar nova versão"
        subtitle="Envie um ZIP novo — a versão atual segue no ar até a instalação terminar com sucesso"
        actions={
          <Button variant="primary" size="sm" onClick={onOpenUpdate}>
            <IconUpload className="h-3.5 w-3.5" /> Atualizar código
          </Button>
        }
      >
        <div className="space-y-3 text-xs text-slate-400">
          <p>
            O painel extrai o pacote, instala as dependências em um container descartável, publica o release e recria o
            container. O diretório <span className="font-mono">/data</span> nunca é alterado por esse processo.
          </p>
          {error ? <Alert tone="red">{error}</Alert> : null}
        </div>
      </Card>

      <Card
        title={`Versões (${releases.length})`}
        subtitle={
          activeRelease > 0
            ? `Versão ativa: v${activeRelease} · ${app.releaseCount} versão(ões) guardada(s)`
            : "Nenhuma versão publicada ainda"
        }
        actions={
          <Button size="sm" onClick={() => void releasesState.reload()}>
            <IconRefresh className="h-3.5 w-3.5" /> Atualizar
          </Button>
        }
        bodyClassName="p-0"
      >
        {releasesState.loading && releasesState.data === null ? (
          <SkeletonRows rows={4} />
        ) : sorted.length === 0 ? (
          <p className="p-4 text-xs text-slate-500">
            Nenhuma versão publicada. Use <strong>Atualizar código</strong> para enviar o primeiro ZIP.
          </p>
        ) : (
          <ul className="divide-y divide-slate-800/70">
            {sorted.map((release) => {
              const isActive = release.seq === activeRelease;
              return (
                <li key={release.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-slate-200">
                      <span className="font-mono font-semibold">v{release.seq}</span>
                      {isActive ? <Badge tone="green">atual</Badge> : <Badge>arquivada</Badge>}
                      {release.notes ? <span className="truncate text-slate-400">— {release.notes}</span> : null}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {formatDateTime(release.createdAt)} ({relativeTime(release.createdAt)}) · {humanBytes(release.sizeBytes)} ·{" "}
                      <span className="font-mono">{release.entry || release.startCommand || "comando próprio"}</span>
                    </p>
                  </div>

                  <div className="flex shrink-0 gap-1">
                    {!isActive ? (
                      <>
                        <Button
                          size="sm"
                          loading={busy === `activate-${release.seq}`}
                          onClick={() =>
                            setConfirm({
                              title: `Voltar para a versão v${release.seq}?`,
                              description: (
                                <div className="space-y-2">
                                  <p>
                                    O container será recriado apontando para o código da v{release.seq}. O volume{" "}
                                    <span className="font-mono">/data</span> é mantido intacto.
                                  </p>
                                  <p className="text-slate-400">
                                    A configuração de execução registrada nessa versão (arquivo principal, comando de start e
                                    imagem) também volta. RAM, CPU, variáveis e portas permanecem como estão hoje.
                                  </p>
                                  <p className="text-slate-400">
                                    A aplicação fica alguns segundos fora do ar durante a troca.
                                  </p>
                                </div>
                              ),
                              confirmLabel: `Ativar v${release.seq}`,
                              run: () => activate(release.seq),
                            })
                          }
                        >
                          <IconRestart className="h-3.5 w-3.5" /> Rollback
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setConfirm({
                              title: `Remover a versão v${release.seq}?`,
                              description: (
                                <p>
                                  Os arquivos dessa versão serão apagados do disco. Esta ação não pode ser desfeita e não
                                  afeta o <span className="font-mono">/data</span> da aplicação.
                                </p>
                              ),
                              confirmLabel: "Remover versão",
                              danger: true,
                              run: () => removeRelease(release.seq),
                            })
                          }
                        >
                          <IconTrash className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    ) : (
                      <span className="px-2 text-[11px] text-slate-500">em execução</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Histórico de deploys" subtitle="Cada publicação com o log completo" bodyClassName="p-0">
        {deploymentsState.loading && deploymentsState.data === null ? (
          <div className="flex items-center gap-2 p-4 text-xs text-slate-400">
            <Spinner /> carregando…
          </div>
        ) : (
          <ul className="divide-y divide-slate-800/70 text-xs">
            {(deploymentsState.data?.deployments ?? []).map((deployment) => (
              <li key={deployment.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <span className="text-slate-300">
                  {deployment.kind === "deploy" ? "Publicação" : deployment.kind}
                  {deployment.releaseSeq ? ` da v${deployment.releaseSeq}` : ""}
                </span>
                <Badge tone={deployment.status === "success" ? "green" : deployment.status === "failed" ? "red" : "amber"}>
                  {deployment.status === "success" ? "concluído" : deployment.status === "failed" ? "falhou" : "em andamento"}
                </Badge>
                <span className="text-slate-500">{relativeTime(deployment.startedAt)}</span>
                <button
                  type="button"
                  className="ml-auto rounded-md px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                  onClick={() => setLogDeployment(deployment.id)}
                >
                  ver log
                </button>
              </li>
            ))}
            {(deploymentsState.data?.deployments.length ?? 0) === 0 ? (
              <li className="px-4 py-4 text-slate-500">Nenhum deploy registrado.</li>
            ) : null}
          </ul>
        )}
      </Card>

      <Modal
        open={logDeployment !== null}
        title="Log do deploy"
        onClose={() => setLogDeployment(null)}
        wide
        footer={
          <Button variant="ghost" onClick={() => setLogDeployment(null)}>
            Fechar
          </Button>
        }
      >
        {logDeployment !== null ? (
          <DeploymentLogView
            slug={slug}
            deploymentId={logDeployment}
            onFinished={() => {
              onDeploymentStarted(logDeployment);
              void releasesState.reload();
              onReload();
            }}
          />
        ) : null}
      </Modal>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
