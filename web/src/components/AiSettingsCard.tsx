import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { errorText, useAsync } from "../hooks.ts";
import type { AiSettings } from "../types.ts";
import { Alert, Badge, Button, Card, Field, InlineCode, Input, Select, Skeleton, Toggle, cn } from "./ui.tsx";
import { IconAlert, IconCheck, IconRefresh, IconSparkles } from "./icons.tsx";
import { useToast } from "./Toasts.tsx";

const MAX_LINES_PRESETS = [80, 200, 500, 1000];

/**
 * Configuração da análise de logs com IA. A chave é do próprio administrador:
 * fica no banco local do painel e nunca é devolvida pela API (a tela mostra
 * apenas uma dica mascarada). Nenhuma chamada sai daqui enquanto o usuário não
 * clicar em testar ou analisar.
 */
export default function AiSettingsCard() {
  const toast = useToast();
  const state = useAsync(() => api.aiSettings(), []);

  const [enabled, setEnabled] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [maxLines, setMaxLines] = useState(200);
  const [temperature, setTemperature] = useState(0.2);
  const [apiKeySet, setApiKeySet] = useState(false);
  const [apiKeyHint, setApiKeyHint] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);

  const [providerModels, setProviderModels] = useState<string[] | null>(null);
  const [modelSource, setModelSource] = useState<"provider" | "builtin" | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [showModels, setShowModels] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Provedores cuja lista já foi buscada automaticamente (evita repetir a cada render).
  const autoFetched = useRef<string | null>(null);

  const settings = state.data?.settings;
  const providers = state.data?.providers ?? [];
  const provider = providers.find((item) => item.id === providerId) ?? null;

  /** Campos do formulário — é isto que "testar" e "buscar modelos" enviam. */
  const draft = () => ({
    provider: providerId,
    model,
    baseUrl,
    ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
  });

  /**
   * Busca a lista de modelos do provedor usando os campos do formulário. Fica
   * declarada antes dos `return` antecipados porque o efeito de carregamento
   * automático a chama.
   */
  const fetchModels = async (silent = false): Promise<void> => {
    setLoadingModels(true);
    if (!silent) setError(null);
    try {
      const { models } = await api.aiModels(draft());
      setProviderModels(models.models);
      setModelSource(models.source);
      setModelsError(models.error);
      setShowModels(true);
      if (models.error && !silent) toast.info(models.error);
    } catch (caught) {
      const message = errorText(caught);
      setError(message);
      if (!silent) toast.error(message);
    } finally {
      setLoadingModels(false);
    }
  };

  // Preenche o formulário quando a configuração chega e depois de cada salvamento.
  useEffect(() => {
    if (!settings || loaded) return;
    setEnabled(settings.enabled);
    setProviderId(settings.provider);
    setModel(settings.model);
    setBaseUrl(settings.baseUrl);
    setMaxLines(settings.maxLines);
    setTemperature(settings.temperature);
    setApiKeySet(settings.apiKeySet);
    setApiKeyHint(settings.apiKeyHint);
    setApiKey("");
    setClearApiKey(false);
    setLoaded(true);
  }, [settings, loaded]);

  // Com uma chave já salva, busca a lista real assim que a tela abre: o catálogo
  // de modelos muda o tempo todo, e sem isso o usuário fica com nomes vencidos
  // (o campo sugeria um modelo que o provedor não oferece mais).
  useEffect(() => {
    if (!loaded || !settings?.apiKeySet) return;
    if (autoFetched.current === settings.provider) return;
    autoFetched.current = settings.provider;
    void fetchModels(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, settings?.apiKeySet, settings?.provider]);

  if (state.loading && !settings) {
    return (
      <Card title="Análise de logs com IA">
        <div className="space-y-3">
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </Card>
    );
  }

  if (!settings) {
    return (
      <Card title="Análise de logs com IA">
        <Alert tone="red">{state.error ?? "Não foi possível carregar a configuração de IA."}</Alert>
      </Card>
    );
  }

  const selectProvider = (id: string): void => {
    const next = providers.find((item) => item.id === id) ?? null;
    setProviderId(id);
    setModel(next?.defaultModel ?? "");
    setBaseUrl(next?.defaultBaseUrl ?? "");
    setProviderModels(null);
    setModelSource(null);
    setModelsError(null);
    setShowModels(false);
    setModelFilter("");
    setTestResult(null);
    setError(null);
    // A lista é por provedor: a próxima busca precisa ser refeita.
    autoFetched.current = null;
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const result = await api.saveAiSettings({
        enabled,
        provider: providerId,
        model,
        baseUrl,
        maxLines,
        temperature,
        ...(apiKey.trim().length > 0 ? { apiKey } : {}),
        ...(clearApiKey ? { clearApiKey: true } : {}),
      });
      // A resposta já traz o formulário normalizado (inclusive a dica mascarada
      // da chave); `loaded` volta a false para a tela refletir o que foi salvo.
      setLoaded(false);
      state.setData({ settings: result.settings, providers });
      toast.success("Configuração de IA salva.");
      // Com a chave salva, confere na hora se o modelo escolhido existe na conta:
      // é o erro mais comum ("o modelo não existe ou você não tem acesso a ele").
      if (result.settings.apiKeySet) {
        autoFetched.current = result.settings.provider;
        void fetchModels(true);
      }
    } catch (caught) {
      const message = errorText(caught);
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const test = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      // Manda o que está no formulário: testar antes de salvar precisa testar o
      // que o usuário acabou de escolher, não a configuração anterior.
      const { result } = await api.testAi(draft());
      setTestResult({ ok: result.ok, message: result.message });
      if (result.ok) autoFetched.current = providerId;
    } catch (caught) {
      const message = errorText(caught);
      setError(message);
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };

  const modelOptions = providerModels ?? provider?.models.map((item) => item.id) ?? [];
  const isFromProvider = providerModels !== null && modelSource === "provider";
  // Aviso que resolve o caso mais comum: o nome digitado não existe na conta.
  const modelMissing = isFromProvider && model.trim().length > 0 && !providerModels.includes(model.trim());
  // Filtro simples e sem memo: a lista é curta e, acima de tudo, nenhum hook
  // pode ser chamado depois dos `return` antecipados de carregamento/erro — o
  // React exige sempre a mesma sequência de hooks entre renders (era isso que
  // deixava a página de Configurações em branco).
  const modelNeedle = modelFilter.trim().toLowerCase();
  const filtered =
    modelNeedle.length === 0 ? modelOptions : modelOptions.filter((id) => id.toLowerCase().includes(modelNeedle));

  return (
    <Card
      title="Análise de logs com IA"
      subtitle="Use a sua própria chave de um provedor de IA para explicar erros nos logs"
      actions={
        <Badge tone={enabled ? "green" : "slate"}>
          {enabled ? "ativada" : "desativada"}
        </Badge>
      }
    >
      <div className="space-y-5">
        <Alert tone="amber" icon={<IconAlert className="h-3.5 w-3.5" />}>
          Ao analisar, o trecho de log escolhido <strong>sai desta VPS</strong> e é enviado ao provedor que você
          configurar. Credenciais óbvias (tokens, chaves, senhas e JWTs) são mascaradas antes do envio, mas revise o
          texto: os logs podem conter dados que você não quer compartilhar. A chave fica guardada no banco local do
          painel e <strong>nunca</strong> é devolvida pela API.
        </Alert>

        <Toggle
          checked={enabled}
          onChange={setEnabled}
          label={
            <span>
              Habilitar a análise com IA
              <span className="block text-[11px] text-slate-500">
                Enquanto desativada, o botão “Analisar com IA” fica oculto na aba de logs.
              </span>
            </span>
          }
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Provedor" hint="Cada provedor tem o seu formato de API e a sua chave.">
            <Select value={providerId} onChange={(event) => selectProvider(event.target.value)}>
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Modelo"
            hint="Clique em “buscar modelos” para ver os nomes que a sua chave alcança — o catálogo muda com o tempo."
          >
            <div className="flex flex-wrap gap-2">
              <Input
                value={model}
                list="botpanel-ai-models"
                onChange={(event) => setModel(event.target.value)}
                placeholder={provider?.defaultModel ?? "nome-do-modelo"}
                className="min-w-40 flex-1"
              />
              <datalist id="botpanel-ai-models">
                {modelOptions.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
              <Button
                size="sm"
                loading={loadingModels}
                onClick={() => void fetchModels()}
                title="Pergunta ao provedor quais modelos a sua chave pode usar"
              >
                <IconRefresh className="h-3.5 w-3.5" /> buscar modelos
              </Button>
            </div>
          </Field>

          <Field
            label={`Chave de API (${provider?.keyLabel ?? "chave"})`}
            hint={
              apiKeySet
                ? `Chave salva no servidor: ${apiKeyHint}. Deixe em branco para mantê-la.`
                : provider?.requiresKey
                  ? "Obrigatória para este provedor."
                  : "Este provedor não exige chave."
            }
          >
            <div className="flex flex-wrap gap-2">
              <Input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setClearApiKey(false);
                }}
                placeholder={apiKeySet ? "•••••••• (salva)" : "cole a chave aqui"}
                className="min-w-40 flex-1"
              />
              {apiKeySet ? (
                <Button
                  size="sm"
                  variant={clearApiKey ? "danger" : "secondary"}
                  onClick={() => {
                    setClearApiKey((value) => !value);
                    setApiKey("");
                  }}
                >
                  {clearApiKey ? "vai remover ✓" : "remover chave"}
                </Button>
              ) : null}
            </div>
          </Field>

          <Field
            label="Quantas linhas enviar"
            hint={`As últimas ${maxLines} linhas visíveis na tela. Menos linhas = resposta mais rápida e barata.`}
          >
            <div className="flex flex-wrap gap-2">
              <Input
                type="number"
                min={20}
                max={1000}
                step={20}
                value={maxLines}
                onChange={(event) => setMaxLines(Number(event.target.value))}
                className="w-28"
              />
              <Select
                value={MAX_LINES_PRESETS.includes(maxLines) ? String(maxLines) : "custom"}
                onChange={(event) => event.target.value !== "custom" && setMaxLines(Number(event.target.value))}
                className="w-auto"
              >
                <option value="custom">escolher…</option>
                {MAX_LINES_PRESETS.map((preset) => (
                  <option key={preset} value={preset}>
                    {preset} linhas
                  </option>
                ))}
              </Select>
            </div>
          </Field>

          {provider?.customBaseUrl ? (
            <Field
              label="URL base da API"
              className="sm:col-span-2"
              hint={
                provider.keysUrl
                  ? "Aponte para o seu servidor. Ex.: http://127.0.0.1:11434/v1 para o Ollama local."
                  : "Endereço do serviço compatível com a API da OpenAI."
              }
            >
              <Input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={provider.defaultBaseUrl || "https://servidor/v1"}
                className="font-mono text-xs"
              />
            </Field>
          ) : null}

          <Field label="Criatividade (temperatura)" hint="0 = respostas mais objetivas; 1 = mais criativas. Para diagnóstico, valores baixos funcionam melhor.">
            <Input
              type="number"
              min={0}
              max={1}
              step={0.1}
              value={temperature}
              onChange={(event) => setTemperature(Number(event.target.value))}
              className="w-28"
            />
          </Field>
        </div>

        {modelMissing ? (
          <Alert tone="amber" icon={<IconAlert className="h-3.5 w-3.5" />}>
            O modelo <span className="font-mono">{model.trim()}</span> não aparece na lista deste provedor. Escolha um da
            lista abaixo (ou digite o nome exato) antes de salvar — é isso que causa o erro “o modelo não existe ou você
            não tem acesso a ele”.
          </Alert>
        ) : null}

        {modelsError ? (
          <Alert tone="amber" icon={<IconAlert className="h-3.5 w-3.5" />}>
            {modelsError}
          </Alert>
        ) : null}

        {showModels ? (
          <div className="rounded-xl border border-white/10 bg-slate-950/40 p-3">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
              <span>
                {isFromProvider ? "Modelos disponíveis na sua conta" : "Sugestões do painel"} — {modelOptions.length}{" "}
                opção(ões)
              </span>
              {modelOptions.length > 8 ? (
                <Input
                  value={modelFilter}
                  onChange={(event) => setModelFilter(event.target.value)}
                  placeholder="filtrar modelos…"
                  className="ml-auto w-44 py-1 text-xs"
                />
              ) : null}
              <button
                type="button"
                onClick={() => setShowModels(false)}
                className="rounded-md px-2 py-1 text-[11px] transition hover:bg-white/5 hover:text-slate-200"
              >
                ocultar
              </button>
            </div>

            {filtered.length === 0 ? (
              <p className="mt-2 text-[11px] text-slate-500">Nenhum modelo corresponde ao filtro.</p>
            ) : (
              <div className="mt-2 flex max-h-52 flex-wrap gap-1.5 overflow-y-auto">
                {filtered.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setModel(id);
                      setTestResult(null);
                    }}
                    className={cn(
                      "rounded-lg border px-2 py-1 font-mono text-[11px] transition",
                      id === model.trim()
                        ? "border-indigo-400/50 bg-indigo-500/20 text-indigo-100"
                        : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20 hover:bg-white/10",
                    )}
                  >
                    {id}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-slate-500">
            Dica: use <strong>buscar modelos</strong> para preencher a lista com os modelos que a sua chave alcança — o
            nome precisa ser exatamente o que o provedor oferece.
          </p>
        )}

        {error ? <Alert tone="red">{error}</Alert> : null}
        {testResult ? (
          <Alert
            tone={testResult.ok ? "green" : "red"}
            icon={testResult.ok ? <IconCheck className="h-3.5 w-3.5" /> : <IconAlert className="h-3.5 w-3.5" />}
          >
            {testResult.message}
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" loading={saving} onClick={() => void save()} disabled={model.trim().length === 0}>
            <IconSparkles className="h-3.5 w-3.5" /> Salvar configuração
          </Button>
          <Button loading={testing} onClick={() => void test()}>
            Testar conexão
          </Button>
          {provider?.keysUrl ? (
            <a
              href={provider.keysUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[11px] text-indigo-300 hover:text-indigo-200"
            >
              obter uma chave de {provider.label} ↗
            </a>
          ) : null}
          {provider?.docsUrl ? (
            <a
              href={provider.docsUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[11px] text-slate-400 hover:text-slate-200"
            >
              documentação ↗
            </a>
          ) : null}
        </div>

        <p className="text-[11px] text-slate-500">
          Para trocar de provedor depois, basta selecionar outro e salvar — a chave anterior não é reaproveitada, mesmo
          quando os formatos são parecidos. A análise também aparece na aba <strong>Logs</strong> de cada aplicação, onde
          o trecho enviado fica registrado em <InlineCode>/api/ai/analyses</InlineCode>.
        </p>
      </div>
    </Card>
  );
}
