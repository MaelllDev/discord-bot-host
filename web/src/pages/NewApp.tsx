import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, uploadZipWithProgress } from "../api.ts";
import type { EnvVar, ProjectDetection, RuntimeKind, UploadResult } from "../types.ts";
import { humanBytes, humanCpu, humanRam, runtimeLabel } from "../format.ts";
import { errorText, useDeployment } from "../hooks.ts";
import EnvEditor from "../components/EnvEditor.tsx";
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
const STEPS = ["Código", "Como executar", "Recursos", "Revisar"] as const;

export default function NewApp() {
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
  const [deploymentId, setDeploymentId] = useState<number | null>(null);
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);

  const deploy = useDeployment(createdSlug, deploymentId, (status) => {
    if (!createdSlug) return;
    if (status === "success") {
      toast.success("Aplicação criada e primeira versão publicada.");
      navigate(`/apps/${createdSlug}`);
    } else {
      toast.error("A publicação inicial falhou — a aplicação foi criada sem versão ativa.");
    }
  });

  const applyRuntime = (next: RuntimeKind): void => {
    setRuntime(next);
    const preset = PRESETS[next];
    if (image === PRESETS[runtime].image) setImage(preset.image);
    if (entry === "" || entry === PRESETS[runtime].entry) setEntry(preset.entry);
    if (depsFile === "" || depsFile === PRESETS[runtime].depsFile) setDepsFile(preset.depsFile);
  };

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
        toast.success("Aplicação criada. Publique o código quando quiser.");
        navigate(`/apps/${slug}`);
        return;
      }

      const started = await api.deploy(slug, upload.upload.id, "Versão inicial");
      setCreatedSlug(slug);
      setDeploymentId(started.deploymentId);
    } catch (caught) {
      const message = errorText(caught);
      setSubmitError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const canContinue = step === 0 ? name.trim().length >= 2 : true;
  const creating = deploy.status === "running" && deploymentId !== null;
  const deployFailed = deploy.status === "failed";

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title="Nova aplicação"
        icon={<IconPlus className="h-4 w-4" />}
        subtitle="Envie o ZIP do projeto, confirme como ele deve rodar e o painel cria o container, instala as dependências e publica a primeira versão."
        actions={
          <Link to="/apps">
            <Button variant="ghost" disabled={creating}>
              Cancelar
            </Button>
          </Link>
        }
      />

      {/* Passos do assistente, com o progresso visível a cada etapa. */}
      <ol className="card flex flex-wrap items-center gap-1 p-2">
        {STEPS.map((label, index) => {
          const done = index < step;
          const current = index === step;
          return (
            <li key={label} className="flex items-center gap-1">
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
                {label}
              </button>
            </li>
          );
        })}
      </ol>

      {step === 0 ? (
        <Card title="Código da aplicação" subtitle="ZIP com o projeto (uma pasta raiz no pacote é removida automaticamente)">
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nome da aplicação" hint="Aparece no painel e define o identificador (slug).">
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Meu Bot" autoFocus />
              </Field>
              <Field label="Descrição (opcional)">
                <Input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Bot de moderação do servidor X"
                />
              </Field>
              <Field
                label="URL do ícone (opcional)"
                className="sm:col-span-2"
                hint="Link http(s) de uma imagem (ex.: o avatar do bot no Discord). Pode mudar depois."
              >
                <div className="flex items-center gap-3">
                  <AppIcon app={{ name: name || "?", iconUrl, runtime }} size="md" />
                  <Input
                    value={iconUrl}
                    onChange={(event) => setIconUrl(event.target.value)}
                    placeholder="https://cdn.exemplo.com/icone.png"
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
                    <Spinner className="h-4 w-4" /> Enviando ZIP… {uploadPercent}%
                  </p>
                  <ProgressBar percent={uploadPercent} />
                  <p className="text-[11px] text-slate-500">{humanBytes(uploadBytes)} enviados</p>
                </div>
              ) : (
                <>
                  <span className="icon-tile icon-tile-lg mx-auto">
                    <IconUpload className="h-5 w-5" />
                  </span>
                  <p className="mt-3 text-sm font-medium text-slate-200">Arraste o arquivo .zip aqui</p>
                  <p className="mt-1 text-xs text-slate-500">ou</p>
                  <Button className="mt-2" onClick={() => fileInputRef.current?.click()}>
                    Escolher arquivo
                  </Button>
                  <p className="mt-3 text-[11px] text-slate-500">
                    Você também pode criar a aplicação sem código e enviar a primeira versão depois.
                  </p>
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
                    {humanBytes(upload.upload.sizeBytes)} · {upload.upload.fileCount} arquivo(s)
                  </Badge>
                  <Badge tone="indigo">runtime detectado: {runtimeLabel(detection.runtime)}</Badge>
                  {detection.entry ? <Badge>arquivo principal: {detection.entry}</Badge> : null}
                  {detection.depsFile ? <Badge>dependências: {detection.depsFile}</Badge> : null}
                  <Button size="sm" variant="ghost" onClick={() => fileInputRef.current?.click()}>
                    trocar arquivo
                  </Button>
                </div>

                {detection.presentFiles.length > 0 ? (
                  <p className="text-[11px] text-slate-500">
                    Arquivos-chave: <span className="font-mono">{detection.presentFiles.slice(0, 8).join(", ")}</span>
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
          title="Como executar"
          subtitle={
            detection
              ? `Preenchido a partir da detecção automática do pacote enviado (runtime ${runtimeLabel(detection.runtime)})`
              : "Ajuste os comandos que o painel vai executar"
          }
        >
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Runtime" hint="Define a imagem Docker e os comandos padrão.">
                <Select value={runtime} onChange={(event) => applyRuntime(event.target.value as RuntimeKind)}>
                  {(Object.keys(PRESETS) as RuntimeKind[]).map((kind) => (
                    <option key={kind} value={kind}>
                      {PRESETS[kind].label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Imagem Docker" hint="Ex.: node:22-slim, python:3.12-slim, denoland/deno:latest">
                <Input value={image} onChange={(event) => setImage(event.target.value)} />
              </Field>
              <Field label="Arquivo principal" hint="Relativo à raiz do projeto. Ex.: index.js ou src/bot.py">
                <Input value={entry} onChange={(event) => setEntry(event.target.value)} placeholder="index.js" />
              </Field>
              <Field label="Arquivo de dependências" hint="Vazio desativa a instalação automática.">
                <Input value={depsFile} onChange={(event) => setDepsFile(event.target.value)} placeholder="package.json" />
              </Field>
            </div>

            <Field
              label="Comando de instalação (opcional)"
              hint="Vazio usa o instalador do runtime quando o arquivo de dependências existir."
            >
              <Input
                value={installCommand}
                onChange={(event) => setInstallCommand(event.target.value)}
                placeholder="npm install --omit=dev && npm run build"
                className="font-mono text-xs"
              />
            </Field>

            <Field
              label="Comando de start (opcional)"
              hint={runtime === "custom" ? "Obrigatório no runtime livre." : "Vazio usa o arquivo principal (ex.: node index.js)."}
            >
              <Input
                value={startCommand}
                onChange={(event) => setStartCommand(event.target.value)}
                placeholder="npm start"
                className="font-mono text-xs"
              />
            </Field>

            {runtime === "custom" ? (
              <Alert tone="amber">
                No runtime livre você é responsável pela imagem, pelo comando de instalação e pelo comando de start.
              </Alert>
            ) : null}
          </div>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card title="Recursos e configuração" subtitle="Limites aplicados por cgroup, por aplicação">
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Memória máxima" hint={`${humanRam(memoryMb)} — o container é encerrado se estourar.`}>
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
                    <option value="custom">escolher…</option>
                    {MEMORY_PRESETS.map((preset) => (
                      <option key={preset} value={preset}>
                        {humanRam(preset)}
                      </option>
                    ))}
                  </Select>
                </div>
              </Field>

              <Field label="CPU" hint={`${humanCpu(cpu)} — 1 vCPU equivale a um núcleo inteiro.`}>
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
                    <option value="custom">escolher…</option>
                    {CPU_PRESETS.map((preset) => (
                      <option key={preset} value={preset}>
                        {humanCpu(preset)}
                      </option>
                    ))}
                  </Select>
                </div>
              </Field>

              <Field label="Limite de processos" hint="Protege a VPS contra fork bombs.">
                <Input
                  type="number"
                  min={32}
                  max={4096}
                  value={pidsLimit}
                  onChange={(event) => setPidsLimit(Number(event.target.value))}
                  className="w-32"
                />
              </Field>

              <Field label="Portas publicadas (opcional)" hint="Formato portaHost:portaContainer.">
                <Input value={ports} onChange={(event) => setPorts(event.target.value)} placeholder="8080:3000" />
              </Field>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium text-slate-300">Variáveis de ambiente</p>
              <EnvEditor value={env} onChange={setEnv} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Toggle
                checked={autoStart}
                onChange={setAutoStart}
                label={
                  <span>
                    Iniciar junto com o sistema
                    <span className="block text-[11px] text-slate-500">
                      Sobe sozinha quando a VPS (ou o painel) reiniciar.
                    </span>
                  </span>
                }
              />

              <Toggle
                checked={autoRestart}
                onChange={setAutoRestart}
                label={
                  <span>
                    Reiniciar automaticamente
                    <span className="block text-[11px] text-slate-500">
                      Quando o bot cair com erro, o Docker sobe ele de novo sozinho.
                    </span>
                  </span>
                }
              />
            </div>

            <Alert tone="slate">
              Os dados persistentes ficam em <InlineCode>/data</InlineCode> dentro do container, fora do código. Publicar
              uma nova versão nunca apaga esse diretório.
            </Alert>
          </div>
        </Card>
      ) : null}

      {step === 3 ? (
        <Card title="Revisar e criar" subtitle="Confira antes de criar a aplicação">
          <div className="space-y-4 text-xs">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-slate-500">Aplicação</p>
                <p className="text-slate-200">{name || "—"}</p>
                {description ? <p className="text-[11px] text-slate-500">{description}</p> : null}
              </div>
              <div>
                <p className="text-slate-500">Ícone</p>
                {iconUrl.trim() ? (
                  <p className="break-all font-mono text-slate-200">{iconUrl.trim()}</p>
                ) : (
                  <p className="text-slate-200">iniciais do nome</p>
                )}
              </div>
              <div>
                <p className="text-slate-500">Código</p>
                <p className="text-slate-200">
                  {upload ? `${upload.upload.fileName} (${humanBytes(upload.upload.sizeBytes)})` : "sem código — publicar depois"}
                </p>
              </div>
              <div>
                <p className="text-slate-500">Runtime</p>
                <p className="text-slate-200">
                  {runtimeLabel(runtime)} <span className="font-mono text-[11px] text-slate-500">{image}</span>
                </p>
              </div>
              <div>
                <p className="text-slate-500">Arquivo principal</p>
                <p className="font-mono text-slate-200">{entry || "definido pelo comando de start"}</p>
              </div>
              <div>
                <p className="text-slate-500">Dependências</p>
                <p className="font-mono text-slate-200">{depsFile || "nenhuma instalação automática"}</p>
              </div>
              <div>
                <p className="text-slate-500">Recursos</p>
                <p className="text-slate-200">
                  {humanRam(memoryMb)} de RAM · {humanCpu(cpu)} · {pidsLimit} processos
                </p>
              </div>
              <div>
                <p className="text-slate-500">Variáveis e portas</p>
                <p className="text-slate-200">
                  {env.filter((item) => item.key.trim()).length} variável(is) · {ports.trim() || "nenhuma porta"}
                </p>
              </div>
              <div>
                <p className="text-slate-500">Início junto com o sistema</p>
                <p className="text-slate-200">{autoStart ? "ativado" : "desativado"}</p>
              </div>
              <div>
                <p className="text-slate-500">Reinício automático</p>
                <p className="text-slate-200">{autoRestart ? "ativado" : "desativado"}</p>
              </div>
            </div>

            {installCommand ? (
              <div>
                <p className="text-slate-500">Comando de instalação</p>
                <p className="break-all font-mono text-slate-200">{installCommand}</p>
              </div>
            ) : null}
            {startCommand ? (
              <div>
                <p className="text-slate-500">Comando de start</p>
                <p className="break-all font-mono text-slate-200">{startCommand}</p>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {submitError ? <Alert tone="red">{submitError}</Alert> : null}

      {deploymentId !== null ? (
        <Card
          title={deployFailed ? "A publicação falhou" : "Publicando a primeira versão"}
          subtitle={
            deployFailed
              ? "A aplicação existe, mas ficou sem versão ativa. Publique novamente pela aba Versões."
              : "Acompanhe as etapas reais informadas pelo backend"
          }
        >
          <DeployProgress
            log={deploy.log}
            finished={deploy.finished}
            failed={deployFailed}
            extra={
              deployFailed ? (
                <Alert tone="amber">
                  O código anterior não existe (primeira publicação), então a aplicação ficou criada mas parada. Corrija o
                  problema no ZIP e publique de novo — nada foi apagado.
                </Alert>
              ) : null
            }
          />
          <pre className="terminal mt-3 max-h-64 overflow-auto rounded-lg border border-white/8 bg-slate-950 p-3 whitespace-pre-wrap text-slate-300">
            {deploy.log || "aguardando o início do deploy…"}
          </pre>
          {deploy.finished ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {deployFailed ? (
                <>
                  <Button variant="primary" onClick={() => setDeploymentId(null)}>
                    Tentar novamente
                  </Button>
                  <Button onClick={() => createdSlug && navigate(`/apps/${createdSlug}`)}>Ir para a aplicação</Button>
                </>
              ) : (
                <Button variant="primary" onClick={() => createdSlug && navigate(`/apps/${createdSlug}`)}>
                  Abrir aplicação
                </Button>
              )}
            </div>
          ) : null}
        </Card>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0 || creating}>
          ← Voltar
        </Button>
        {step < STEPS.length - 1 ? (
          <Button variant="primary" onClick={() => setStep((current) => current + 1)} disabled={!canContinue || creating}>
            Continuar →
          </Button>
        ) : (
          <Button
            variant="primary"
            loading={submitting || creating}
            onClick={() => void submit()}
            disabled={name.trim().length < 2 || creating || deployFailed}
          >
            {upload ? "Criar e publicar" : "Criar aplicação"}
          </Button>
        )}
      </div>
    </div>
  );
}
