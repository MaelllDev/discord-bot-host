import { useState } from "react";
import { api } from "../../api.ts";
import { errorText } from "../../hooks.ts";
import type { AppSummary, EnvVar, RuntimeKind } from "../../types.ts";
import { compactNumber, humanCpu, humanRam } from "../../format.ts";
import EnvEditor from "../EnvEditor.tsx";
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

  const invalidMessages: string[] = [];
  if (name.trim().length < 2 || name.trim().length > 48) invalidMessages.push("O nome precisa ter entre 2 e 48 caracteres.");
  if (!Number.isFinite(memoryMb) || memoryMb < 64 || memoryMb > 32768) invalidMessages.push("A memória precisa ficar entre 64 MB e 32 GB.");
  if (!Number.isFinite(cpu) || cpu < 0.1 || cpu > 16) invalidMessages.push("A CPU precisa ficar entre 0,1 e 16 vCPU.");
  if (!Number.isFinite(pidsLimit) || pidsLimit < 32 || pidsLimit > 4096) invalidMessages.push("O limite de processos precisa ficar entre 32 e 4096.");
  const invalid = invalidMessages.length > 0;

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
      toast.success("Configuração salva. O container foi recriado com a mesma versão ativa.");
      onReload();
    } catch (caught) {
      const message = errorText(caught);
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card title="Identificação">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome" hint="Exibido no painel e nas listas.">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Identificador (não editável)" hint="Define pastas em disco, container e URLs.">
            <Input value={app.slug} readOnly className="opacity-70" />
          </Field>
          <Field label="Descrição" className="sm:col-span-2">
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Bot de moderação do servidor X"
            />
          </Field>
          <Field
            label="URL do ícone"
            className="sm:col-span-2"
            hint="Link http(s) de uma imagem (ex.: o avatar do bot no Discord). Vazio usa as iniciais do nome."
          >
            <div className="flex items-center gap-3">
              <AppIcon app={{ name: name || app.name, iconUrl, runtime }} size="md" />
              <Input
                value={iconUrl}
                onChange={(event) => setIconUrl(event.target.value)}
                placeholder="https://cdn.exemplo.com/icone.png"
              />
            </div>
          </Field>
        </div>
      </Card>

      <Card title="Recursos" subtitle="Limites aplicados por cgroup no container — valem por aplicação">
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Memória máxima" hint={`Valor atual: ${humanRam(memoryMb)} — estourar esse limite encerra o container.`}>
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
                  <option value="custom">escolher…</option>
                  {MEMORY_PRESETS.map((preset) => (
                    <option key={preset} value={preset}>
                      {humanRam(preset)}
                    </option>
                  ))}
                </Select>
              </div>
            </Field>

            <Field label="CPU" hint={`Valor atual: ${humanCpu(cpu)} — 1 vCPU equivale a um núcleo inteiro.`}>
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
                  <option value="custom">escolher…</option>
                  {CPU_PRESETS.map((preset) => (
                    <option key={preset} value={preset}>
                      {humanCpu(preset)}
                    </option>
                  ))}
                </Select>
              </div>
            </Field>

            <Field label="Limite de processos" hint="Protege a VPS contra fork bombs no container.">
              <Input
                type="number"
                min={32}
                max={4096}
                value={pidsLimit}
                onChange={(event) => setPidsLimit(Number(event.target.value))}
                className="w-32"
              />
            </Field>

            <Field label="Portas publicadas" hint="Formato portaHost:portaContainer, separadas por espaço.">
              <Input value={ports} onChange={(event) => setPorts(event.target.value)} placeholder="8080:3000" />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Toggle
              checked={autoStart}
              onChange={setAutoStart}
              label={
                <span>
                  Iniciar junto com o sistema
                  <span className="block text-[11px] text-slate-500">
                    Sobe sozinha quando a VPS (ou o painel) reiniciar. Se você parar pelo botão <strong>Parar</strong>,
                    ela continua parada até você mandar iniciar.
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
                    Quando o bot cair com erro, o Docker sobe ele de novo sozinho. Desligado, ele fica parado e você vê o
                    motivo nos logs.
                  </span>
                </span>
              }
            />
          </div>

          <div className="flex flex-wrap gap-1.5">
            <Badge tone="indigo">{humanRam(memoryMb)} de RAM</Badge>
            <Badge tone="indigo">{humanCpu(cpu)}</Badge>
            <Badge tone="indigo">{compactNumber(pidsLimit, 0)} processos</Badge>
            <Badge>{app.ports.length > 0 ? `${app.ports.length} porta(s)` : "sem portas"}</Badge>
          </div>
        </div>
      </Card>

      <Card title="Execução" subtitle="Como o painel instala e inicia o código">
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Runtime" hint="Muda apenas o preset da imagem e dos comandos.">
              <Select
                value={runtime}
                onChange={(event) => {
                  const next = event.target.value as RuntimeKind;
                  setRuntime(next);
                  setImage(RUNTIME_IMAGES[next]);
                }}
              >
                <option value="node">Node.js</option>
                <option value="python">Python</option>
                <option value="custom">Comando livre</option>
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
            label="Comando de instalação"
            hint="Deixe vazio para usar o instalador do runtime quando o arquivo de dependências existir."
          >
            <Input
              value={installCommand}
              onChange={(event) => setInstallCommand(event.target.value)}
              placeholder="npm install --omit=dev && npm run build"
              className="font-mono text-xs"
            />
          </Field>

          <Field label="Comando de start" hint="Vazio usa o arquivo principal (ex.: node index.js).">
            <Input
              value={startCommand}
              onChange={(event) => setStartCommand(event.target.value)}
              placeholder="npm start"
              className="font-mono text-xs"
            />
          </Field>
        </div>
      </Card>

      <Card
        title="Variáveis de ambiente"
        subtitle="Injetadas no container a cada início; as marcadas como segredo ficam mascaradas na interface"
      >
        <EnvEditor value={env} onChange={setEnv} />
        <p className="mt-3 text-[11px] text-slate-500">
          As variáveis reservadas <InlineCode>DATA_DIR=/data</InlineCode>, <InlineCode>HOME=/data</InlineCode> e{" "}
          <InlineCode>APP_SLUG</InlineCode> são definidas pelo painel e não podem ser sobrescritas.
        </p>
      </Card>

      <Card title="Aplicar alterações">
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
          {saved && !dirty ? <Alert tone="green">Configuração salva.</Alert> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" loading={saving} disabled={!dirty || invalid} onClick={() => void save()}>
              Salvar configuração
            </Button>
            {dirty ? (
              <span className="text-[11px] text-amber-300">
                Há alterações não salvas. Salvar recria o container (a versão ativa e o <InlineCode>/data</InlineCode> são
                preservados) e reinicia a aplicação.
              </span>
            ) : (
              <span className="text-[11px] text-slate-500">Nada pendente.</span>
            )}
          </div>
        </div>
      </Card>

      <Card title="Zona de risco" className="border-rose-900/50">
        <div className="space-y-3">
          <p className="text-xs text-slate-400">
            Excluir remove a aplicação do painel, o container <span className="font-mono">botpanel-{app.slug}</span> e a
            rede dela. As imagens Docker permanecem em cache no host. Você escolhe na confirmação se os arquivos em disco
            também são apagados.
          </p>
          <Button variant="danger" onClick={onRequestDelete}>
            <IconTrash className="h-3.5 w-3.5" /> Excluir aplicação
          </Button>
        </div>
      </Card>
    </div>
  );
}
