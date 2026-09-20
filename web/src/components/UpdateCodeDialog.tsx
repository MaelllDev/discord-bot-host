import { useRef, useState } from "react";
import { api, uploadZipWithProgress } from "../api.ts";
import type { AppSummary, ProjectDetection } from "../types.ts";
import { errorText } from "../hooks.ts";
import { humanBytes, runtimeLabel } from "../format.ts";
import { Alert, Badge, Button, Input, Modal, ProgressBar, Spinner } from "./ui.tsx";
import { IconCheck, IconUpload } from "./icons.tsx";
import DeploymentLogView from "./DeploymentLogView.tsx";
import { useToast } from "./Toasts.tsx";

type Stage = "select" | "uploading" | "ready" | "deploying" | "done";

export default function UpdateCodeDialog({
  app,
  open,
  onClose,
  onDeployed,
}: {
  app: AppSummary;
  open: boolean;
  onClose: () => void;
  onDeployed: () => void;
}) {
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [stage, setStage] = useState<Stage>("select");
  const [fileName, setFileName] = useState("");
  const [percent, setPercent] = useState(0);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [detection, setDetection] = useState<ProjectDetection | null>(null);
  const [notes, setNotes] = useState("");
  const [deploymentId, setDeploymentId] = useState<number | null>(null);
  const [releaseSeq, setReleaseSeq] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = (): void => {
    setStage("select");
    setFileName("");
    setPercent(0);
    setUploadedBytes(0);
    setUploadId(null);
    setDetection(null);
    setNotes("");
    setDeploymentId(null);
    setReleaseSeq(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const close = (): void => {
    if (stage === "uploading" || stage === "deploying") return;
    reset();
    onClose();
  };

  const pick = async (file: File): Promise<void> => {
    setError(null);
    setFileName(file.name);
    setStage("uploading");
    setPercent(0);
    try {
      const result = await uploadZipWithProgress(file, (progress) => {
        setPercent(progress.percent);
        setUploadedBytes(progress.loadedBytes);
      });
      setUploadId(result.upload.id);
      setDetection(result.detection);
      setStage("ready");
    } catch (caught) {
      setError(errorText(caught));
      setStage("select");
    }
  };

  const startDeploy = async (): Promise<void> => {
    if (!uploadId) return;
    setStage("deploying");
    setError(null);
    try {
      const deploy = await api.deploy(app.slug, uploadId, notes || `Atualização para ${app.name}`);
      setDeploymentId(deploy.deploymentId);
      setReleaseSeq(deploy.releaseSeq);
    } catch (caught) {
      setError(errorText(caught));
      setStage("ready");
    }
  };

  return (
    <Modal
      open={open}
      title={`Atualizar código de ${app.name}`}
      onClose={close}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={stage === "uploading" || stage === "deploying"}>
            {stage === "done" ? "Fechar" : "Cancelar"}
          </Button>
          {stage === "ready" ? (
            <Button variant="primary" onClick={() => void startDeploy()}>
              Publicar versão
            </Button>
          ) : null}
          {stage === "select" || stage === "uploading" ? (
            <Button variant="primary" loading={stage === "uploading"} onClick={() => fileInputRef.current?.click()}>
              Selecionar ZIP
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-4 text-xs text-slate-300">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="sky">versão atual: {app.activeRelease > 0 ? `v${app.activeRelease}` : "nenhuma"}</Badge>
          <Badge tone="indigo">
            próxima versão: {releaseSeq !== null ? `v${releaseSeq}` : `v${app.activeRelease + 1}`}
          </Badge>
          <span className="text-slate-500">
            A versão atual continua no ar durante todo o processo; <code>/data</code> nunca é tocado.
          </span>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void pick(file);
          }}
        />

        {stage === "select" ? (
          <div className="rounded-xl border-2 border-dashed border-slate-800 px-6 py-8 text-center">
            <IconUpload className="mx-auto h-6 w-6 text-slate-500" />
            <p className="mt-2 text-sm text-slate-300">Selecione o ZIP com a nova versão do código</p>
            <p className="mt-1 text-[11px] text-slate-500">
              O painel extrai, instala dependências em um container descartável e só ativa se tudo der certo.
            </p>
          </div>
        ) : null}

        {stage === "uploading" ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span className="flex items-center gap-2">
                <Spinner className="h-3.5 w-3.5" /> Enviando {fileName}…
              </span>
              <span className="font-mono">
                {percent}% ({humanBytes(uploadedBytes)})
              </span>
            </div>
            <ProgressBar percent={percent} />
          </div>
        ) : null}

        {stage !== "select" && stage !== "uploading" && detection ? (
          <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="green">
                <IconCheck className="h-3 w-3" /> {fileName}
              </Badge>
              <Badge tone="indigo">runtime: {runtimeLabel(detection.runtime)}</Badge>
              {detection.entry ? <Badge>principal: {detection.entry}</Badge> : null}
              {detection.depsFile ? <Badge>deps: {detection.depsFile}</Badge> : null}
            </div>
            {detection.notes.length > 0 ? (
              <ul className="space-y-1 text-[11px] text-slate-400">
                {detection.notes.map((note) => (
                  <li key={note}>• {note}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {stage === "ready" ? (
          <Input
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Descrição da versão (opcional): corrige o comando de ticket…"
          />
        ) : null}

        {error ? <Alert tone="red">{error}</Alert> : null}

        {stage === "deploying" && deploymentId !== null ? (
          <DeploymentLogView
            slug={app.slug}
            deploymentId={deploymentId}
            onFinished={(status) => {
              setStage("done");
              if (status === "success") {
                toast.success(`Versão publicada em ${app.name}.`);
                onDeployed();
              } else {
                toast.error("A publicação falhou — a versão anterior continua ativa.");
              }
            }}
          />
        ) : null}

        {stage === "done" ? (
          <Alert tone="slate">
            Você pode acompanhar o histórico completo na aba <strong>Versões</strong> e voltar para uma versão anterior
            quando precisar.
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}
