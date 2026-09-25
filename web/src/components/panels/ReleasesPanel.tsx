import { useState } from "react";
import { api } from "../../api.ts";
import { errorText, useAsync } from "../../hooks.ts";
import { useI18n } from "../../i18n/index.tsx";
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
      toast.success(t("versions.removed", { value: seq }));
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

  const { t } = useI18n();

  return (
    <div className="space-y-5">
      <Card
        title={t("versions.publishCard")}
        subtitle={t("versions.publishCard.hint")}
        actions={
          <Button variant="primary" size="sm" onClick={onOpenUpdate}>
            <IconUpload className="h-3.5 w-3.5" /> {t("actions.updateCode")}
          </Button>
        }
      >
        <div className="space-y-3 text-xs text-slate-400">
          <p>
            {t("versions.publishCard.body.before")} <span className="font-mono">/data</span>{" "}
            {t("versions.publishCard.body.after")}
          </p>
          {error ? <Alert tone="red">{error}</Alert> : null}
        </div>
      </Card>

      <Card
        title={t("versions.title", { count: releases.length })}
        subtitle={
          activeRelease > 0
            ? t("versions.subtitle", { version: activeRelease, count: app.releaseCount })
            : t("versions.noVersionYet")
        }
        actions={
          <Button size="sm" onClick={() => void releasesState.reload()}>
            <IconRefresh className="h-3.5 w-3.5" /> {t("common.refresh")}
          </Button>
        }
        bodyClassName="p-0"
      >
        {releasesState.loading && releasesState.data === null ? (
          <SkeletonRows rows={4} />
        ) : sorted.length === 0 ? (
          <p className="p-4 text-xs text-slate-500">
            {t("versions.empty.before")} <strong>{t("actions.updateCode")}</strong> {t("versions.empty.after")}
          </p>
        ) : (
          <ul className="divide-y divide-white/6">
            {sorted.map((release) => {
              const isActive = release.seq === activeRelease;
              return (
                <li key={release.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-slate-200">
                      <span className="font-mono font-semibold">v{release.seq}</span>
                      {isActive ? (
                        <Badge tone="green">{t("versions.current")}</Badge>
                      ) : (
                        <Badge>{t("versions.archived")}</Badge>
                      )}
                      {release.notes ? <span className="truncate text-slate-400">— {release.notes}</span> : null}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {formatDateTime(release.createdAt)} ({relativeTime(release.createdAt)}) · {humanBytes(release.sizeBytes)} ·{" "}
                      <span className="font-mono">
                        {release.entry || release.startCommand || t("overview.ownCommand")}
                      </span>
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
                              title: t("versions.confirm.rollback.title", { value: release.seq }),
                              description: (
                                <div className="space-y-2">
                                  <p>
                                    {t("versions.confirm.rollback.before", { value: release.seq })}{" "}
                                    <span className="font-mono">/data</span>{" "}
                                    {t("versions.confirm.rollback.after")}
                                  </p>
                                  <p className="text-slate-400">{t("versions.confirm.rollback.config")}</p>
                                  <p className="text-slate-400">{t("versions.confirm.rollback.downtime")}</p>
                                </div>
                              ),
                              confirmLabel: t("versions.confirm.activate", { value: release.seq }),
                              run: () => activate(release.seq),
                            })
                          }
                        >
                          <IconRestart className="h-3.5 w-3.5" /> {t("versions.rollback")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setConfirm({
                              title: t("versions.confirm.remove.title", { value: release.seq }),
                              description: (
                                <p>
                                  {t("versions.confirm.remove.before")}{" "}
                                  <span className="font-mono">/data</span> {t("versions.confirm.remove.after")}
                                </p>
                              ),
                              confirmLabel: t("versions.confirm.remove"),
                              danger: true,
                              run: () => removeRelease(release.seq),
                            })
                          }
                        >
                          <IconTrash className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    ) : (
                      <span className="px-2 text-[11px] text-slate-500">{t("versions.running")}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title={t("versions.deployHistory")} subtitle={t("versions.deployHistory.hint")} bodyClassName="p-0">
        {deploymentsState.loading && deploymentsState.data === null ? (
          <div className="flex items-center gap-2 p-4 text-xs text-slate-400">
            <Spinner /> {t("common.loading")}
          </div>
        ) : (
          <ul className="divide-y divide-white/6 text-xs">
            {(deploymentsState.data?.deployments ?? []).map((deployment) => (
              <li key={deployment.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <span className="text-slate-300">
                  {deployment.kind === "deploy" ? t("overview.deployment") : deployment.kind}
                  {deployment.releaseSeq ? t("versions.deploymentOf", { value: deployment.releaseSeq }) : ""}
                </span>
                <Badge tone={deployment.status === "success" ? "green" : deployment.status === "failed" ? "red" : "amber"}>
                  {t(`deploy.status.${deployment.status}`)}
                </Badge>
                <span className="text-slate-500">{relativeTime(deployment.startedAt)}</span>
                <button
                  type="button"
                  className="ml-auto rounded-md px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                  onClick={() => setLogDeployment(deployment.id)}
                >
                  {t("versions.viewLog")}
                </button>
              </li>
            ))}
            {(deploymentsState.data?.deployments.length ?? 0) === 0 ? (
              <li className="px-4 py-4 text-slate-500">{t("versions.noDeploys")}</li>
            ) : null}
          </ul>
        )}
      </Card>

      <Modal
        open={logDeployment !== null}
        title={t("versions.deployLog")}
        onClose={() => setLogDeployment(null)}
        wide
        footer={
          <Button variant="ghost" onClick={() => setLogDeployment(null)}>
            {t("common.close")}
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
