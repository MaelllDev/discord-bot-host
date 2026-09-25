import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { errorText, useAsync } from "../hooks.ts";
import type { AiSettings } from "../types.ts";
import { Alert, Badge, Button, Card, Field, InlineCode, Input, Select, Skeleton, Toggle, cn } from "./ui.tsx";
import { IconAlert, IconCheck, IconRefresh, IconSparkles } from "./icons.tsx";
import { useToast } from "./Toasts.tsx";
import { useI18n } from "../i18n/index.tsx";

const MAX_LINES_PRESETS = [80, 200, 500, 1000];

/**
 * Configuração da análise de logs com IA. A chave é do próprio administrador:
 * fica no banco local do painel e nunca é devolvida pela API (a tela mostra
 * apenas uma dica mascarada). Nenhuma chamada sai daqui enquanto o usuário não
 * clicar em testar ou analisar.
 */
export default function AiSettingsCard() {
  const { t } = useI18n();
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
      <Card title={t("ai.card.title")}>
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
      <Card title={t("ai.card.title")}>
        <Alert tone="red">{state.error ?? t("ai.loadFailed")}</Alert>
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
      toast.success(t("ai.saved"));
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
      title={t("ai.card.title")}
      subtitle={t("ai.card.hint")}
      actions={
        <Badge tone={enabled ? "green" : "slate"}>
          {enabled ? t("ai.card.enabled") : t("ai.card.disabled")}
        </Badge>
      }
    >
      <div className="space-y-5">
        <Alert tone="amber" icon={<IconAlert className="h-3.5 w-3.5" />}>
          {t("ai.privacy.before")} <strong>{t("ai.privacy.strong1")}</strong>{" "}
          {t("ai.privacy.after")} <strong>{t("ai.privacy.strong2")}</strong> {t("ai.privacy.tail")}
        </Alert>

        <Toggle
          checked={enabled}
          onChange={setEnabled}
          label={
            <span>
              {t("ai.enable")}
              <span className="block text-[11px] text-slate-500">{t("ai.enable.hint")}</span>
            </span>
          }
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("ai.provider")} hint={t("ai.provider.hint")}>
            <Select value={providerId} onChange={(event) => selectProvider(event.target.value)}>
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t("ai.model")} hint={t("ai.model.hint")}>
            <div className="flex flex-wrap gap-2">
              <Input
                value={model}
                list="botpanel-ai-models"
                onChange={(event) => setModel(event.target.value)}
                placeholder={provider?.defaultModel ?? t("ai.model.placeholder")}
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
                title={t("ai.fetchModels.title")}
              >
                <IconRefresh className="h-3.5 w-3.5" /> {t("ai.fetchModels")}
              </Button>
            </div>
          </Field>

          <Field
            label={t("ai.apiKey", { label: provider?.keyLabel ?? t("ai.apiKey.fallbackLabel") })}
            hint={
              apiKeySet
                ? t("ai.apiKey.saved", { hint: apiKeyHint })
                : provider?.requiresKey
                  ? t("ai.apiKey.required")
                  : t("ai.apiKey.notRequired")
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
                placeholder={apiKeySet ? t("ai.apiKey.placeholderSaved") : t("ai.apiKey.placeholder")}
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
                  {clearApiKey ? t("ai.apiKey.clearPending") : t("ai.apiKey.clear")}
                </Button>
              ) : null}
            </div>
          </Field>

          <Field
            label={t("ai.maxLines")}
            hint={t("ai.maxLines.hint", { count: maxLines })}
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
                <option value="custom">{t("common.choose")}</option>
                {MAX_LINES_PRESETS.map((preset) => (
                  <option key={preset} value={preset}>
                    {t("ai.maxLines.option", { count: preset })}
                  </option>
                ))}
              </Select>
            </div>
          </Field>

          {provider?.customBaseUrl ? (
            <Field
              label={t("ai.baseUrl")}
              className="sm:col-span-2"
              hint={provider.keysUrl ? t("ai.baseUrl.hint.custom") : t("ai.baseUrl.hint.openai")}
            >
              <Input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={provider.defaultBaseUrl || "https://servidor/v1"}
                className="font-mono text-xs"
              />
            </Field>
          ) : null}

          <Field label={t("ai.temperature")} hint={t("ai.temperature.hint")}>
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
            {t("ai.modelMissing.before")} <span className="font-mono">{model.trim()}</span>{" "}
            {t("ai.modelMissing.after")}
          </Alert>
        ) : null}

        {modelsError ? (
          <Alert tone="amber" icon={<IconAlert className="h-3.5 w-3.5" />}>
            {modelsError}
          </Alert>
        ) : null}

        {showModels ? (
          <div className="rounded-lg border border-white/10 bg-slate-950/40 p-3">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
              <span>
                {isFromProvider ? t("ai.models.available") : t("ai.models.suggestions")} —{" "}
                {t("ai.models.count", { count: modelOptions.length })}
              </span>
              {modelOptions.length > 8 ? (
                <Input
                  value={modelFilter}
                  onChange={(event) => setModelFilter(event.target.value)}
                  placeholder={t("ai.models.filter")}
                  className="ml-auto w-44 py-1 text-xs"
                />
              ) : null}
              <button
                type="button"
                onClick={() => setShowModels(false)}
                className="rounded-md px-2 py-1 text-[11px] transition hover:bg-white/5 hover:text-slate-200"
              >
                {t("ai.models.hide")}
              </button>
            </div>

            {filtered.length === 0 ? (
              <p className="mt-2 text-[11px] text-slate-500">{t("ai.models.noMatch")}</p>
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
            {t("ai.models.tip.before")} <strong>{t("ai.fetchModels")}</strong> {t("ai.models.tip.after")}
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
            <IconSparkles className="h-3.5 w-3.5" /> {t("config.save")}
          </Button>
          <Button loading={testing} onClick={() => void test()}>
            {t("ai.test")}
          </Button>
          {provider?.keysUrl ? (
            <a
              href={provider.keysUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[11px] text-indigo-300 hover:text-indigo-200"
            >
              {t("ai.keys.get", { provider: provider.label })}
            </a>
          ) : null}
          {provider?.docsUrl ? (
            <a
              href={provider.docsUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[11px] text-slate-400 hover:text-slate-200"
            >
              {t("ai.docs")}
            </a>
          ) : null}
        </div>

        <p className="text-[11px] text-slate-500">
          {t("ai.footer.before")} <strong>{t("tabs.logs")}</strong> {t("ai.footer.after")}{" "}
          <InlineCode>/api/ai/analyses</InlineCode>{t("ai.footer.tail")}
        </p>
      </div>
    </Card>
  );
}
