import { useMemo, useState } from "react";
import { api } from "../../api.ts";
import { errorTextRich } from "../../hooks.ts";
import {
  commandIssues,
  cpuProblem,
  envIssues,
  imageProblem,
  memoryProblem,
  nameProblem,
  portsIssues,
  pidsProblem,
  translateIssues,
} from "../../validation.ts";
import type { ValidationIssue } from "../../validation.ts";
import { useI18n } from "../../i18n/index.tsx";
import type { AppSummary, EnvVar, RuntimeKind } from "../../types.ts";
import { compactNumber, humanCpu, humanRam } from "../../format.ts";
import EnvEditor from "../EnvEditor.tsx";
import ImageUpload from "../ImageUpload.tsx";
import AppIcon from "../AppIcon.tsx";
import { Alert, Badge, Button, Card, Field, InlineCode, Input, Select, Toggle } from "../ui.tsx";
import { IconTrash } from "../icons.tsx";
import { useToast } from "../Toasts.tsx";

const RUNTIME_IMAGES: Record<RuntimeKind, string> = {
  node: "node:22-slim",
  python: "python:3.12-slim",
  custom: "ubuntu:24.04",
};

const MEMORY_PRESETS = [128, 256, 512, 1024, 2048, 4096];
const CPU_PRESETS = [0.25, 0.5, 1, 2, 4];

export default function ConfigPanel({
  slug,
  app,
  onReload,
  onRequestDelete,
}: {
  slug: string;
  app: AppSummary;
  onReload: () => void;
  onRequestDelete: () => void;
}) {
  const toast = useToast();
  const { t } = useI18n();

  const [name, setName] = useState(app.name);
  const [description, setDescription] = useState(app.description);
  const [iconUrl, setIconUrl] = useState(app.iconUrl);
  const [runtime, setRuntime] = useState<RuntimeKind>(app.runtime);
  const [image, setImage] = useState(app.image);
  const [entry, setEntry] = useState(app.entry);
  const [depsFile, setDepsFile] = useState(app.depsFile);
  const [installCommand, setInstallCommand] = useState(app.installCommand);
  const [startCommand, setStartCommand] = useState(app.startCommand);
  const [memoryMb, setMemoryMb] = useState(app.memoryMb);
  const [cpu, setCpu] = useState(app.cpu);
  const [pidsLimit, setPidsLimit] = useState(app.pidsLimit);
  const [ports, setPorts] = useState(app.ports.join(" "));
  const [autoStart, setAutoStart] = useState(app.autoStart);
  const [autoRestart, setAutoRestart] = useState(app.autoRestart);
  const [env, setEnv] = useState<EnvVar[]>(app.env);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const portList = ports
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  /**
   * Mesma checagem do backend (`server/src/apps/validate.ts`) — cada problema
   * aparece com o motivo, na língua ativa, antes de qualquer chamada.
   */
  const invalidMessages = useMemo((): string[] => {
    const issues: ValidationIssue[] = [
      nameProblem(name.trim()),
      imageProblem(image.trim()),
      memoryProblem(memoryMb),
      cpuProblem(cpu),
      pidsProblem(pidsLimit),
      ...commandIssues(runtime, entry, startCommand),
      ...envIssues(env),
      ...portsIssues(portList),
    ].filter((issue): issue is ValidationIssue => issue !== null);
    return translateIssues(issues, t);
  }, [name, image, memoryMb, cpu, pidsLimit, runtime, entry, startCommand, env, portList, t]);
  const invalid = invalidMessages.length > 0;

  const dirty =
    name !== app.name ||
    description !== app.description ||
    iconUrl !== app.iconUrl ||
    runtime !== app.runtime ||
    image !== app.image ||
    entry !== app.entry ||
    depsFile !== app.depsFile ||
    installCommand !== app.installCommand ||
    startCommand !== app.startCommand ||
    memoryMb !== app.memoryMb ||
    cpu !== app.cpu ||
    pidsLimit !== app.pidsLimit ||
    ports !== app.ports.join(" ") ||
    autoStart !== app.autoStart ||
    autoRestart !== app.autoRestart ||
    JSON.stringify(env) !== JSON.stringify(app.env);



  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.updateApp(slug, {
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
        autoStart,
        autoRestart,
        env: env.filter((item) => item.key.trim().length > 0),
        ports: ports
          .split(/[\s,]+/)
          .map((item) => item.trim())
          .filter(Boolean),
      });
      setSaved(true);
      toast.success(t("config.saved"));
      onReload();
    } catch (caught) {
      // Erros que o painel não previu (ex.: imagem fora da lista de permissões,
      // que só o backend conhece) chegam com código e são traduzidos aqui.
      const message = errorTextRich(caught);
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card title={t("config.card.identity")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("config.name")} hint={t("config.name.hint")}>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label={t("config.slug")} hint={t("config.slug.hint")}>
            <Input value={app.slug} readOnly className="opacity-70" />
          </Field>
          <Field label={t("config.description")} className="sm:col-span-2">
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("config.description.placeholder")}
            />
          </Field>
          <Field
            label={t("config.iconUrl")}
            className="sm:col-span-2"
            hint={t("config.iconUrl.hint")}
          >
            <div className="flex flex-wrap items-center gap-4">
              <AppIcon app={{ name: name || app.name, iconUrl, runtime }} size="md" />
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
      </Card>

      <Card title={t("config.card.resources")} subtitle={t("config.card.resources.hint")}>
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t("config.memory")}
              hint={t("config.memory.hint", { value: humanRam(memoryMb) })}
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
                  onChange={(event) => {
                    if (event.target.value === "custom") return;
                    setMemoryMb(Number(event.target.value));
                  }}
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

            <Field label={t("metric.cpu")} hint={t("config.cpu.hint", { value: humanCpu(cpu) })}>
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
                  onChange={(event) => {
                    if (event.target.value === "custom") return;
                    setCpu(Number(event.target.value));
                  }}
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

            <Field label={t("config.pids")} hint={t("config.pids.hint")}>
              <Input
                type="number"
                min={32}
                max={4096}
                value={pidsLimit}
                onChange={(event) => setPidsLimit(Number(event.target.value))}
                className="w-32"
              />
            </Field>

            <Field label={t("config.ports")} hint={t("config.ports.hint")}>
              <Input value={ports} onChange={(event) => setPorts(event.target.value)} placeholder="8080:3000" />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Toggle
              checked={autoStart}
              onChange={setAutoStart}
              label={
                <span>
                  {t("config.autoStart")}
                  <span className="block text-[11px] text-slate-500">
                    {t("config.autoStart.hint.before")} <strong>{t("actions.stop")}</strong>
                    {t("config.autoStart.hint.after")}
                  </span>
                </span>
              }
            />

            <Toggle
              checked={autoRestart}
              onChange={setAutoRestart}
              label={
                <span>
                  {t("config.autoRestart")}
                  <span className="block text-[11px] text-slate-500">{t("config.autoRestart.hint")}</span>
                </span>
              }
            />
          </div>

          <div className="flex flex-wrap gap-1.5">
            <Badge tone="indigo">{t("config.badge.ram", { value: humanRam(memoryMb) })}</Badge>
            <Badge tone="indigo">{humanCpu(cpu)}</Badge>
            <Badge tone="indigo">{t("config.badge.processes", { count: compactNumber(pidsLimit, 0) })}</Badge>
            <Badge>
              {app.ports.length > 0
                ? t("config.badge.ports", { count: app.ports.length })
                : t("config.badge.noPorts")}
            </Badge>
          </div>
        </div>
      </Card>

      <Card title={t("config.card.execution")} subtitle={t("config.card.execution.hint")}>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("config.runtime")} hint={t("config.runtime.hint")}>
              <Select
                value={runtime}
                onChange={(event) => {
                  const next = event.target.value as RuntimeKind;
                  setRuntime(next);
                  setImage(RUNTIME_IMAGES[next]);
                }}
              >
                <option value="node">{t("runtime.node")}</option>
                <option value="python">{t("runtime.python")}</option>
                <option value="custom">{t("runtime.custom")}</option>
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

          <Field label={t("config.installCommand")} hint={t("config.installCommand.hint")}>
            <Input
              value={installCommand}
              onChange={(event) => setInstallCommand(event.target.value)}
              placeholder="npm install --omit=dev && npm run build"
              className="font-mono text-xs"
            />
          </Field>

          <Field label={t("config.startCommand")} hint={t("config.startCommand.hint")}>
            <Input
              value={startCommand}
              onChange={(event) => setStartCommand(event.target.value)}
              placeholder="npm start"
              className="font-mono text-xs"
            />
          </Field>
        </div>
      </Card>

      <Card title={t("config.card.env")} subtitle={t("config.card.env.hint")}>
        <EnvEditor value={env} onChange={setEnv} />
        <p className="mt-3 text-[11px] text-slate-500">
          {t("config.reservedEnv.before")} <InlineCode>DATA_DIR=/data</InlineCode>,{" "}
          <InlineCode>HOME=/data</InlineCode> {t("config.reservedEnv.and")} <InlineCode>APP_SLUG</InlineCode>{" "}
          {t("config.reservedEnv.after")}
        </p>
      </Card>

      <Card title={t("config.card.apply")}>
        <div className="space-y-3">
          {error ? <Alert tone="red">{error}</Alert> : null}
          {invalid ? (
            <Alert tone="amber">
              <ul className="list-inside list-disc space-y-1">
                {invalidMessages.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {saved && !dirty ? <Alert tone="green">{t("config.savedOk")}</Alert> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" loading={saving} disabled={!dirty || invalid} onClick={() => void save()}>
              {t("config.save")}
            </Button>
            {dirty ? (
              <span className="text-[11px] text-amber-300">
                {t("config.unsaved.before")} <InlineCode>/data</InlineCode> {t("config.unsaved.after")}
              </span>
            ) : (
              <span className="text-[11px] text-slate-500">{t("config.nothingPending")}</span>
            )}
          </div>
        </div>
      </Card>

      <Card title={t("config.card.risk")} className="border-rose-900/50">
        <div className="space-y-3">
          <p className="text-xs text-slate-400">
            {t("config.risk.before")} <span className="font-mono">botpanel-{app.slug}</span>{" "}
            {t("config.risk.after")}
          </p>
          <Button variant="danger" onClick={onRequestDelete}>
            <IconTrash className="h-3.5 w-3.5" /> {t("config.deleteApp")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
