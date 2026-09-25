import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, uploadZipWithProgress } from "../api.ts";
import type { EnvVar, ProjectDetection, RuntimeKind, UploadResult } from "../types.ts";
import { humanBytes, humanCpu, humanRam, runtimeLabel } from "../format.ts";
import { errorText, errorTextRich, useDeployment } from "../hooks.ts";
import {
  commandIssues,
  envIssues,
  imageProblem,
  nameProblem,
  portsIssues,
  translateIssues,
} from "../validation.ts";
import type { ValidationIssue } from "../validation.ts";
import EnvEditor from "../components/EnvEditor.tsx";
import ImageUpload from "../components/ImageUpload.tsx";
import AppIcon from "../components/AppIcon.tsx";
import DeployProgress from "../components/DeployProgress.tsx";
import { useToast } from "../components/Toasts.tsx";
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  InlineCode,
  Input,
  PageHeader,
  ProgressBar,
  Select,
  Spinner,
  Toggle,
  cn,
} from "../components/ui.tsx";
import { IconCheck, IconPlus, IconUpload } from "../components/icons.tsx";
import { useI18n } from "../i18n/index.tsx";

interface RuntimePreset {
  label: string;
  image: string;
  entry: string;
  depsFile: string;
}

const PRESETS: Record<RuntimeKind, RuntimePreset> = {
  node: { label: "Node.js 22", image: "node:22-slim", entry: "index.js", depsFile: "package.json" },
  python: { label: "Python 3.12", image: "python:3.12-slim", entry: "main.py", depsFile: "requirements.txt" },
  custom: { label: "Comando livre", image: "ubuntu:24.04", entry: "", depsFile: "" },
};

const MEMORY_PRESETS = [128, 256, 512, 1024, 2048, 4096];
const CPU_PRESETS = [0.25, 0.5, 1, 2, 4];
const STEP_KEYS = ["newApp.step.code", "newApp.step.run", "newApp.step.resources", "newApp.step.review"] as const;

export default function NewApp() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [step, setStep] = useState(0);

  // Código
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [iconUrl, setIconUrl] = useState("");
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [detection, setDetection] = useState<ProjectDetection | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadBytes, setUploadBytes] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // Execução
  const [runtime, setRuntime] = useState<RuntimeKind>("node");
  const [image, setImage] = useState(PRESETS.node.image);
  const [entry, setEntry] = useState("");
  const [depsFile, setDepsFile] = useState("");
  const [installCommand, setInstallCommand] = useState("");
  const [startCommand, setStartCommand] = useState("");

  // Recursos
  const [memoryMb, setMemoryMb] = useState(512);
  const [cpu, setCpu] = useState(1);
  const [pidsLimit, setPidsLimit] = useState(256);
  const [ports, setPorts] = useState("");
  const [autoStart, setAutoStart] = useState(true);
  const [autoRestart, setAutoRestart] = useState(true);
  const [env, setEnv] = useState<EnvVar[]>([]);

  // Criação
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [deploymentId, setDeploymentId] = useState<number | null>(null);
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);

  const deploy = useDeployment(createdSlug, deploymentId, (status) => {
    if (!createdSlug) return;
    if (status === "success") {
      toast.success(t("newApp.deploy.created"));
      navigate(`/apps/${createdSlug}`);
    } else {
      toast.error(t("newApp.deploy.failed"));
    }
  });

  const applyRuntime = (next: RuntimeKind): void => {
    setRuntime(next);
    const preset = PRESETS[next];
    if (image === PRESETS[runtime].image) setImage(preset.image);
    if (entry === "" || entry === PRESETS[runtime].entry) setEntry(preset.entry);
    if (depsFile === "" || depsFile === PRESETS[runtime].depsFile) setDepsFile(preset.depsFile);
  };

  const portList = useMemo(
    () =>
      ports
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    [ports],
  );

  /**
   * Mesma checagem do backend (`server/src/apps/validate.ts`), executada no
   * navegador, com TODOS os problemas de uma vez e cada um amarrado à etapa do
   * assistente onde aparece — nada de bloqueio silencioso. `allowedImages` só
   * existe no servidor, então a lista de permissões fica por conta da API.
   */
  const allIssues = useMemo((): { step: number; text: string }[] => {
    const found: { issue: ValidationIssue; step: number }[] = [];
    const nameIssue = nameProblem(name);
    if (nameIssue) found.push({ issue: nameIssue, step: 0 });
    const imageIssue = imageProblem(image);
    if (imageIssue) found.push({ issue: imageIssue, step: 1 });
    for (const issue of commandIssues(runtime, entry, startCommand)) found.push({ issue, step: 1 });
    for (const issue of envIssues(env)) found.push({ issue, step: 2 });
    for (const issue of portsIssues(portList)) found.push({ issue, step: 2 });
    return found.map(({ issue, step }) => ({ step, text: t(`errors.${issue.code}`, issue.params) }));
  }, [name, image, runtime, entry, startCommand, env, portList, t]);

  const issuesForStep = (index: number): string[] =>
    allIssues.filter((item) => item.step === index).map((item) => item.text);

  const handleFile = async (file: File): Promise<void> => {
    setUploading(true);
    setUploadError(null);
    setUploadPercent(0);
    try {
      const result = await uploadZipWithProgress(file, (progress) => {
        setUploadPercent(progress.percent);
        setUploadBytes(progress.loadedBytes);
      });
      if (upload) await api.discardUpload(upload.upload.id).catch(() => undefined);
      setUpload(result);
      setDetection(result.detection);

      const nextRuntime = result.detection.runtime;
      setRuntime(nextRuntime);
      setImage(PRESETS[nextRuntime].image);
      setEntry(result.detection.entry || PRESETS[nextRuntime].entry);
      setDepsFile(result.detection.depsFile || PRESETS[nextRuntime].depsFile);
      setInstallCommand(result.detection.installCommand);
      setStartCommand(result.detection.startCommand);

      if (name.trim().length === 0) {
        setName(
          file.name
            .replace(/\.zip$/i, "")
            .replace(/[-_]+/g, " ")
            .trim()
            .slice(0, 48),
        );
      }
    } catch (caught) {
      setUploadError(errorText(caught));
    } finally {
      setUploading(false);
      setUploadPercent(0);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const submit = async (): Promise<void> => {
    // Antes de chamar a API, explica tudo que está impedindo a criação — a
    // resposta do servidor continua como rede de segurança (ex.: imagem fora
    // da lista de permissões, que só o backend conhece).
    const blocking = allIssues.map((item) => item.text);
    if (blocking.length > 0) {
      setAttempted(true);
      toast.error(blocking.length === 1 ? blocking[0]! : t("errors.composite.headline"));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await api.createApp({
        name: name.trim(),
        description,
        iconUrl: iconUrl.trim(),
        runtime,
        image: image.trim(),
        entry: entry.trim(),
        depsFile: depsFile.trim(),
        installCommand: installCommand.trim(),
        startCommand: startCommand.trim(),
        memoryMb,
        cpu,
        pidsLimit,
        env: env.filter((item) => item.key.trim().length > 0),
        ports: ports
          .split(/[\s,]+/)
          .map((item) => item.trim())
          .filter(Boolean),
        autoStart,
        autoRestart,
      });

      const slug = created.app.slug;
      if (!upload) {
        toast.success(t("newApp.created.noCode"));
        navigate(`/apps/${slug}`);
        return;
      }

      const started = await api.deploy(slug, upload.upload.id, t("newApp.versionLabel"));
      setCreatedSlug(slug);
      setDeploymentId(started.deploymentId);
    } catch (caught) {
      const message = errorTextRich(caught);
      setSubmitError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  /** Avança de etapa só depois de explicar os problemas da etapa atual. */
  const goTo = (next: number): void => {
    const found = issuesForStep(step);
    if (found.length > 0) {
      setAttempted(true);
      toast.error(found.length === 1 ? found[0]! : t("errors.composite.headline"));
      return;
    }
    setAttempted(false);
    setStep(next);
  };

  const canContinue = step === 0 ? name.trim().length >= 2 && !nameProblem(name) : issuesForStep(step).length === 0;
  const creating = deploy.status === "running" && deploymentId !== null;
  const deployFailed = deploy.status === "failed";

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title={t("nav.newApp")}
        icon={<IconPlus className="h-4 w-4" />}
        subtitle={t("newApp.subtitle")}
        actions={
          <Link to="/apps">
            <Button variant="ghost" disabled={creating}>
              {t("common.cancel")}
            </Button>
          </Link>
        }
      />

      {/* Passos do assistente, com o progresso visível a cada etapa. */}
      <ol className="card flex flex-wrap items-center gap-1 p-2">
        {STEP_KEYS.map((stepKey, index) => {
          const done = index < step;
          const current = index === step;
          return (
            <li key={stepKey} className="flex items-center gap-1">
              {index > 0 ? (
                <span
                  aria-hidden="true"
                  className={cn("hidden h-px w-5 sm:block", done || current ? "bg-indigo-500/40" : "bg-white/10")}
                />
              ) : null}
              <button
                type="button"
                onClick={() => (index <= step && !creating ? setStep(index) : undefined)}
                disabled={index > step || creating}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                  current && "bg-indigo-500/15 text-indigo-100 shadow-[inset_0_0_0_1px_rgb(124_92_255/0.3)]",
                  done && "text-slate-300 hover:bg-white/[0.06]",
                  !done && !current && "text-slate-500",
                )}
              >
                <span
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums",
                    done
                      ? "bg-emerald-500/15 text-emerald-300"
                      : current
                        ? "bg-indigo-500 text-white"
                        : "bg-white/[0.06] text-slate-400",
                  )}
                >
                  {done ? <IconCheck className="h-3 w-3" /> : index + 1}
                </span>
                {t(stepKey)}
              </button>
            </li>
          );
        })}
      </ol>

      {step === 0 ? (
        <Card title={t("newApp.code.title")} subtitle={t("newApp.code.hint")}>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("newApp.name")} hint={t("newApp.name.hint")}>
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Meu Bot" autoFocus />
              </Field>
              <Field label={t("newApp.description")}>
                <Input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={t("config.description.placeholder")}
                />
              </Field>
              <Field
                label={t("newApp.iconUrl")}
                className="sm:col-span-2"
                hint={t("newApp.iconUrl.hint")}
              >
                <div className="flex flex-wrap items-center gap-4">
                  <AppIcon app={{ name: name || "?", iconUrl, runtime }} size="md" />
                  <Input
                    value={iconUrl}
                    onChange={(event) => setIconUrl(event.target.value)}
                    placeholder="https://cdn.exemplo.com/icone.png"
                    className="max-w-md"
                  />
                  <ImageUpload
                    value={iconUrl}
                    onChange={setIconUrl}
                    label={t("imageUpload.orUpload")}
                    size={44}
                  />
                </div>
              </Field>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />

            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                const file = event.dataTransfer.files[0];
                if (file) void handleFile(file);
              }}
              className={cn(
                "rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors duration-200",
                dragging ? "border-indigo-400/60 bg-indigo-500/8" : "border-white/12 hover:border-white/20",
              )}
            >
              {uploading ? (
                <div className="space-y-2">
                  <p className="flex items-center justify-center gap-2 text-sm text-slate-300">
                    <Spinner className="h-4 w-4" /> {t("newApp.uploading", { percent: uploadPercent })}
                  </p>
                  <ProgressBar percent={uploadPercent} />
                  <p className="text-[11px] text-slate-500">
                    {t("newApp.uploaded", { value: humanBytes(uploadBytes) })}
                  </p>
                </div>
              ) : (
                <>
                  <span className="icon-tile icon-tile-lg mx-auto">
                    <IconUpload className="h-5 w-5" />
                  </span>
                  <p className="mt-3 text-sm font-medium text-slate-200">{t("newApp.drop.title")}</p>
                  <p className="mt-1 text-xs text-slate-500">{t("newApp.drop.or")}</p>
                  <Button className="mt-2" onClick={() => fileInputRef.current?.click()}>
                    {t("newApp.drop.choose")}
                  </Button>
                  <p className="mt-3 text-[11px] text-slate-500">{t("newApp.drop.note")}</p>
                </>
              )}
            </div>

            {uploadError ? <Alert tone="red">{uploadError}</Alert> : null}

            {upload && detection ? (
              <div className="space-y-3 rounded-lg border border-white/10 bg-slate-950/60 p-3.5">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone="green">
                    <IconCheck className="h-3 w-3" /> {upload.upload.fileName}
                  </Badge>
                  <Badge>
                    {humanBytes(upload.upload.sizeBytes)} · {t("newApp.detected.files", { count: upload.upload.fileCount })}
                  </Badge>
                  <Badge tone="indigo">
                    {t("newApp.detected.runtime", { value: runtimeLabel(detection.runtime) })}
                  </Badge>
                  {detection.entry ? (
                    <Badge>{t("newApp.detected.entry", { value: detection.entry })}</Badge>
                  ) : null}
                  {detection.depsFile ? (
                    <Badge>{t("newApp.detected.deps", { value: detection.depsFile })}</Badge>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => fileInputRef.current?.click()}>
                    {t("newApp.detected.change")}
                  </Button>
                </div>

                {detection.presentFiles.length > 0 ? (
                  <p className="text-[11px] text-slate-500">
                    {t("newApp.detected.keyFiles")}{" "}
                    <span className="font-mono">{detection.presentFiles.slice(0, 8).join(", ")}</span>
                  </p>
                ) : null}

                {detection.notes.length > 0 ? (
                  <ul className="space-y-1 text-[11px] text-slate-400">
                    {detection.notes.map((note) => (
                      <li key={note}>• {note}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {step === 1 ? (
        <Card
          title={t("newApp.run.title")}
          subtitle={
            detection
              ? t("newApp.run.detected", { value: runtimeLabel(detection.runtime) })
              : t("newApp.run.manual")
          }
        >
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("config.runtime")} hint={t("newApp.runtime.hint")}>
                <Select value={runtime} onChange={(event) => applyRuntime(event.target.value as RuntimeKind)}>
                  {(Object.keys(PRESETS) as RuntimeKind[]).map((kind) => (
                    <option key={kind} value={kind}>
                      {PRESETS[kind].label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("config.image")} hint={t("config.image.hint")}>
                <Input value={image} onChange={(event) => setImage(event.target.value)} />
              </Field>
              <Field label={t("config.entry")} hint={t("config.entry.hint")}>
                <Input value={entry} onChange={(event) => setEntry(event.target.value)} placeholder="index.js" />
              </Field>
              <Field label={t("config.depsFile")} hint={t("config.depsFile.hint")}>
                <Input value={depsFile} onChange={(event) => setDepsFile(event.target.value)} placeholder="package.json" />
              </Field>
            </div>

            <Field
              label={t("newApp.installCommand")}
              hint={t("config.installCommand.hint")}
            >
              <Input
                value={installCommand}
                onChange={(event) => setInstallCommand(event.target.value)}
                placeholder="npm install --omit=dev && npm run build"
                className="font-mono text-xs"
              />
            </Field>

            <Field
              label={t("newApp.startCommand")}
              hint={runtime === "custom" ? t("newApp.startCommand.hint.custom") : t("config.startCommand.hint")}
            >
              <Input
                value={startCommand}
                onChange={(event) => setStartCommand(event.target.value)}
                placeholder="npm start"
                className="font-mono text-xs"
              />
            </Field>

            {(() => {
              const imageIssue = imageProblem(image);
              return imageIssue ? (
                <Alert tone="red">{t(`errors.${imageIssue.code}`, imageIssue.params)}</Alert>
              ) : null;
            })()}
            {runtime === "custom" ? (
              <Alert tone="amber">{t("newApp.custom.alert")}</Alert>
            ) : null}
          </div>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card title={t("newApp.resources.title")} subtitle={t("newApp.resources.hint")}>
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t("config.memory")}
                hint={t("newApp.memory.hint", { value: humanRam(memoryMb) })}
              >
                <div className="flex flex-wrap gap-2">
                  <Input
                    type="number"
                    min={64}
                    max={32768}
                    step={64}
                    value={memoryMb}
                    onChange={(event) => setMemoryMb(Number(event.target.value))}
                    className="w-32"
                  />
                  <Select
                    value={MEMORY_PRESETS.includes(memoryMb) ? String(memoryMb) : "custom"}
                    onChange={(event) => event.target.value !== "custom" && setMemoryMb(Number(event.target.value))}
                    className="w-auto"
                  >
                    <option value="custom">{t("common.choose")}</option>
                    {MEMORY_PRESETS.map((preset) => (
                      <option key={preset} value={preset}>
                        {humanRam(preset)}
                      </option>
                    ))}
                  </Select>
                </div>
              </Field>

              <Field label={t("metric.cpu")} hint={t("newApp.cpu.hint", { value: humanCpu(cpu) })}>
                <div className="flex flex-wrap gap-2">
                  <Input
                    type="number"
                    min={0.1}
                    max={16}
                    step={0.1}
                    value={cpu}
                    onChange={(event) => setCpu(Number(event.target.value))}
                    className="w-32"
                  />
                  <Select
                    value={CPU_PRESETS.includes(cpu) ? String(cpu) : "custom"}
                    onChange={(event) => event.target.value !== "custom" && setCpu(Number(event.target.value))}
                    className="w-auto"
                  >
                    <option value="custom">{t("common.choose")}</option>
                    {CPU_PRESETS.map((preset) => (
                      <option key={preset} value={preset}>
                        {humanCpu(preset)}
                      </option>
                    ))}
                  </Select>
                </div>
              </Field>

              <Field label={t("config.pids")} hint={t("newApp.pids.hint")}>
                <Input
                  type="number"
                  min={32}
                  max={4096}
                  value={pidsLimit}
                  onChange={(event) => setPidsLimit(Number(event.target.value))}
                  className="w-32"
                />
              </Field>

              <Field label={t("newApp.ports")} hint={t("newApp.ports.hint")}>
                <Input value={ports} onChange={(event) => setPorts(event.target.value)} placeholder="8080:3000" />
              </Field>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium text-slate-300">{t("config.card.env")}</p>
              <EnvEditor value={env} onChange={setEnv} />
              {envIssues(env).length > 0 ? (
                <Alert tone="red">
                  <ul className="list-inside list-disc space-y-1">
                    {translateIssues(envIssues(env), t).map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Toggle
                checked={autoStart}
                onChange={setAutoStart}
                label={
                  <span>
                    {t("config.autoStart")}
                    <span className="block text-[11px] text-slate-500">{t("newApp.autoStart.hint")}</span>
                  </span>
                }
              />

              <Toggle
                checked={autoRestart}
                onChange={setAutoRestart}
                label={
                  <span>
                    {t("config.autoRestart")}
                    <span className="block text-[11px] text-slate-500">{t("newApp.autoRestart.hint")}</span>
                  </span>
                }
              />
            </div>

            <Alert tone="slate">
              {t("newApp.data.alert.before")} <InlineCode>/data</InlineCode> {t("newApp.data.alert.after")}
            </Alert>
          </div>
        </Card>
      ) : null}

      {step === 3 ? (
        <Card title={t("newApp.review.title")} subtitle={t("newApp.review.hint")}>
          <div className="space-y-4 text-xs">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-slate-500">{t("newApp.review.app")}</p>
                <p className="text-slate-200">{name || "—"}</p>
                {description ? <p className="text-[11px] text-slate-500">{description}</p> : null}
              </div>
              <div>
                <p className="text-slate-500">{t("newApp.review.icon")}</p>
                {iconUrl.trim() ? (
                  <p className="break-all font-mono text-slate-200">{iconUrl.trim()}</p>
                ) : (
                  <p className="text-slate-200">{t("newApp.review.iconInitials")}</p>
                )}
              </div>
              <div>
                <p className="text-slate-500">{t("newApp.review.code")}</p>
                <p className="text-slate-200">
                  {upload
                    ? `${upload.upload.fileName} (${humanBytes(upload.upload.sizeBytes)})`
                    : t("newApp.review.noCode")}
                </p>
              </div>
              <div>
                <p className="text-slate-500">{t("config.runtime")}</p>
                <p className="text-slate-200">
                  {runtimeLabel(runtime)} <span className="font-mono text-[11px] text-slate-500">{image}</span>
                </p>
              </div>
              <div>
                <p className="text-slate-500">{t("config.entry")}</p>
                <p className="font-mono text-slate-200">{entry || t("newApp.review.entryPlaceholder")}</p>
              </div>
              <div>
                <p className="text-slate-500">{t("config.depsFile")}</p>
                <p className="font-mono text-slate-200">{depsFile || t("newApp.review.noDeps")}</p>
              </div>
              <div>
                <p className="text-slate-500">{t("newApp.step.resources")}</p>
                <p className="text-slate-200">
                  {t("newApp.review.resources.value", {
                    ram: humanRam(memoryMb),
                    cpu: humanCpu(cpu),
                    pids: pidsLimit,
                  })}
                </p>
              </div>
              <div>
                <p className="text-slate-500">{t("newApp.review.envPorts")}</p>
                <p className="text-slate-200">
                  {t("newApp.review.envPorts.value", {
                    count: env.filter((item) => item.key.trim()).length,
                    ports: ports.trim() || t("newApp.review.noPorts"),
                  })}
                </p>
              </div>
              <div>
                <p className="text-slate-500">{t("newApp.review.autoStart")}</p>
                <p className="text-slate-200">
                  {autoStart ? t("system.env.enabled") : t("system.env.disabled")}
                </p>
              </div>
              <div>
                <p className="text-slate-500">{t("newApp.review.autoRestart")}</p>
                <p className="text-slate-200">
                  {autoRestart ? t("system.env.enabled") : t("system.env.disabled")}
                </p>
              </div>
            </div>

            {installCommand ? (
              <div>
                <p className="text-slate-500">{t("config.installCommand")}</p>
                <p className="break-all font-mono text-slate-200">{installCommand}</p>
              </div>
            ) : null}
            {startCommand ? (
              <div>
                <p className="text-slate-500">{t("config.startCommand")}</p>
                <p className="break-all font-mono text-slate-200">{startCommand}</p>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {attempted && issuesForStep(step).length > 0 ? (
        <Alert tone="red">
          <ul className="list-inside list-disc space-y-1">
            {issuesForStep(step).map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {submitError ? <Alert tone="red">{submitError}</Alert> : null}

      {deploymentId !== null ? (
        <Card
          title={deployFailed ? t("newApp.deploy.title.failed") : t("newApp.deploy.title.running")}
          subtitle={
            deployFailed ? t("newApp.deploy.subtitle.failed") : t("newApp.deploy.subtitle.running")
          }
        >
          <DeployProgress
            log={deploy.log}
            finished={deploy.finished}
            failed={deployFailed}
            extra={
              deployFailed ? (
                <Alert tone="amber">{t("newApp.deploy.failAlert")}</Alert>
              ) : null
            }
          />
          <pre className="terminal mt-3 max-h-64 overflow-auto rounded-lg border border-white/8 bg-slate-950 p-3 whitespace-pre-wrap text-slate-300">
            {deploy.log || t("deploy.waiting")}
          </pre>
          {deploy.finished ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {deployFailed ? (
                <>
                  <Button variant="primary" onClick={() => setDeploymentId(null)}>
                    {t("errors.page.retry")}
                  </Button>
                  <Button onClick={() => createdSlug && navigate(`/apps/${createdSlug}`)}>
                    {t("newApp.goToApp")}
                  </Button>
                </>
              ) : (
                <Button variant="primary" onClick={() => createdSlug && navigate(`/apps/${createdSlug}`)}>
                  {t("newApp.openApp")}
                </Button>
              )}
            </div>
          ) : null}
        </Card>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0 || creating}>
          {t("newApp.back")}
        </Button>
        {step < STEP_KEYS.length - 1 ? (
          <Button variant="primary" onClick={() => goTo(step + 1)} disabled={!canContinue || creating}>
            {t("newApp.continue")}
          </Button>
        ) : (
          <Button
            variant="primary"
            loading={submitting || creating}
            onClick={() => void submit()}
            disabled={name.trim().length < 2 || creating || deployFailed}
          >
            {upload ? t("newApp.createAndPublish") : t("newApp.create")}
          </Button>
        )}
      </div>
    </div>
  );
}
