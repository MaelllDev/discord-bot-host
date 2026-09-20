import type { Store } from "../db.ts";
import { nowIso } from "../db.ts";
import type { AiAnalysisRecord, AiAnalysisStatus, AiSettingsView, AppRecord, AppStatus } from "../types.ts";
import { NotFoundError, ValidationError, errorMessage } from "../errors.ts";
import {
  AI_PROVIDERS,
  buildChatRequest,
  buildModelsRequest,
  getProvider,
  normalizeBaseUrl,
  parseChatResponse,
  parseModelsResponse,
} from "./providers.ts";
import type { AiProvider } from "./providers.ts";
import { buildPrompt, redactSecrets, tailExcerpt } from "./prompt.ts";

/** Chave usada na tabela `settings` para a configuração de IA. */
const SETTINGS_KEY = "ai.config";

/** Teto do que se manda ao provedor: o log é recortado antes de sair da VPS. */
const MAX_EXCERPT_CHARS = 48_000;
const REQUEST_TIMEOUT_MS = 90_000;

interface AiConfig {
  enabled: boolean;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxLines: number;
  temperature: number;
}

const DEFAULT_MODEL = "gpt-4o-mini";

function defaults(): AiConfig {
  const provider = getProvider("openai");
  return {
    enabled: false,
    provider: "openai",
    model: provider?.defaultModel ?? DEFAULT_MODEL,
    apiKey: "",
    baseUrl: provider?.defaultBaseUrl ?? "https://api.openai.com/v1",
    maxLines: 200,
    temperature: 0.2,
  };
}

/** Dica mascarada da chave — só o suficiente para o usuário reconhecê-la. */
function maskKey(key: string): string {
  if (key.length === 0) return "";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

/** Texto do erro devolvido pelo provedor, quando ele vem em JSON. */
function providerDetail(body: string): string {
  const detail = body.trim().slice(0, 300);
  if (detail.length === 0) return "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === "string") return parsed.error;
    return parsed.error?.message ?? parsed.message ?? detail;
  } catch {
    return detail;
  }
}

/**
 * Mensagem amigável para as falhas mais comuns de provedores de IA. O catálogo de
 * modelos muda o tempo todo, então o caso "modelo não existe" precisa dizer o que
 * fazer (buscar a lista) em vez de só repetir o erro do fornecedor.
 */
function describeFailure(status: number, body: string, model?: string): string {
  const hint = providerDetail(body);
  const looksLikeMissingModel = /model/i.test(hint) && /(not exist|not found|no access|unknown|invalid|decommission|deprecat)/i.test(hint);
  if (looksLikeMissingModel) {
    return (
      `O modelo ${model ? `"${model}" ` : ""}não existe nesta conta ou foi descontinuado pelo provedor. ` +
      `Use "buscar modelos" para ver a lista que a sua chave alcança e escolha um da lista. ` +
      `Resposta do provedor: ${hint}`
    );
  }
  if (status === 401 || status === 403) return `O provedor recusou a chave (HTTP ${status}): ${hint}`;
  if (status === 404) return `Modelo ou endpoint não encontrado (HTTP 404): ${hint}`;
  if (status === 429) return `Limite de uso ou créditos esgotados no provedor (HTTP 429): ${hint}`;
  return `O provedor respondeu HTTP ${status}: ${hint}`;
}

/**
 * Estado do formulário de configuração. Serve para testar/listar antes de salvar:
 * um campo ausente cai para o valor salvo.
 */
export interface AiDraft {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface AiModelListing {
  models: string[];
  /** `provider` = veio da API do provedor; `builtin` = sugestões do painel. */
  source: "provider" | "builtin";
  error: string | null;
}

export interface AiTestResult {
  ok: boolean;
  message: string;
  provider: string;
  model: string;
  latencyMs: number;
}

/**
 * Análise de logs com IA usando a chave do próprio usuário. O painel não tem
 * conta em nenhum provedor: ele só monta o prompt, chama a API escolhida e
 * guarda o resultado. A chave fica no banco local e nunca é devolvida pela API.
 */
export class AiService {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  private readConfig(): AiConfig {
    const raw = this.store.getSetting(SETTINGS_KEY);
    const base = defaults();
    if (!raw) return base;
    try {
      const parsed = JSON.parse(raw) as Partial<AiConfig>;
      const provider = getProvider(String(parsed.provider ?? base.provider)) ?? getProvider(base.provider) ?? null;
      return {
        enabled: parsed.enabled ?? base.enabled,
        provider: provider?.id ?? base.provider,
        model: (parsed.model ?? "").trim() || provider?.defaultModel || base.model,
        apiKey: parsed.apiKey ?? "",
        baseUrl: (parsed.baseUrl ?? "").trim() || provider?.defaultBaseUrl || base.baseUrl,
        maxLines: Number.isFinite(parsed.maxLines) ? Math.min(1000, Math.max(20, Number(parsed.maxLines))) : base.maxLines,
        temperature: Number.isFinite(parsed.temperature)
          ? Math.min(1, Math.max(0, Number(parsed.temperature)))
          : base.temperature,
      };
    } catch {
      return base;
    }
  }

  private writeConfig(config: AiConfig): void {
    this.store.setSetting(SETTINGS_KEY, JSON.stringify(config));
  }

  private resolveProvider(): { provider: AiProvider; config: AiConfig } {
    const config = this.readConfig();
    const provider = getProvider(config.provider);
    if (!provider) throw new ValidationError(`Provedor de IA desconhecido: ${config.provider}`);
    if (provider.requiresKey && config.apiKey.length === 0) {
      throw new ValidationError("Configure a chave de API do provedor em Configurações antes de usar a análise.");
    }
    return { provider, config };
  }

  /**
   * Resolve provedor e credenciais para uma chamada de teste/listagem. Os campos
   * do formulário têm precedência sobre o que está salvo: sem isso, clicar em
   * "buscar modelos" ou "testar conexão" antes de salvar usava a configuração
   * antiga — e o botão parecia simplesmente não funcionar.
   */
  private resolveDraft(draft: AiDraft = {}): { provider: AiProvider; config: AiConfig } {
    const saved = this.readConfig();
    const provider = getProvider(draft.provider ?? saved.provider);
    if (!provider) throw new ValidationError(`Provedor de IA desconhecido: ${draft.provider ?? saved.provider}`);

    const config: AiConfig = {
      ...saved,
      provider: provider.id,
      model: (draft.model ?? (provider.id === saved.provider ? saved.model : provider.defaultModel)).trim(),
      baseUrl: draft.baseUrl?.trim()
        ? normalizeBaseUrl(draft.baseUrl)
        : provider.id === saved.provider && saved.baseUrl.length > 0
          ? saved.baseUrl
          : provider.defaultBaseUrl,
      // Chave digitada no formulário ganha da salva; sem nenhuma das duas, a
      // chamada segue sem autenticação (só faz sentido em provedor local).
      apiKey: draft.apiKey?.trim() ? draft.apiKey.trim() : saved.apiKey,
    };
    if (!config.baseUrl) throw new ValidationError("Informe a URL base do provedor.");
    return { provider, config };
  }

  getSettings(): AiSettingsView {
    const config = this.readConfig();
    return {
      enabled: config.enabled,
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      maxLines: config.maxLines,
      temperature: config.temperature,
      apiKeySet: config.apiKey.length > 0,
      apiKeyHint: maskKey(config.apiKey),
    };
  }

  /** Catálogo para a interface: provedores, formatos e sugestões de modelo. */
  listProviders(): {
    id: string;
    label: string;
    keysUrl: string;
    docsUrl: string;
    keyLabel: string;
    requiresKey: boolean;
    customBaseUrl: boolean;
    defaultBaseUrl: string;
    defaultModel: string;
    models: { id: string; label: string }[];
  }[] {
    return AI_PROVIDERS.map((provider) => ({
      id: provider.id,
      label: provider.label,
      keysUrl: provider.keysUrl,
      docsUrl: provider.docsUrl,
      keyLabel: provider.keyLabel,
      requiresKey: provider.requiresKey,
      customBaseUrl: provider.customBaseUrl,
      defaultBaseUrl: provider.defaultBaseUrl,
      defaultModel: provider.defaultModel,
      models: provider.models,
    }));
  }

  /**
   * `apiKey: undefined` mantém a chave atual (a interface nunca a recebe de
   * volta, então reenviá-la em branco apagaria a configuração sem querer).
   */
  saveSettings(input: {
    enabled?: boolean;
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    maxLines?: number;
    temperature?: number;
    clearApiKey?: boolean;
  }): AiSettingsView {
    const current = this.readConfig();
    const provider = input.provider === undefined ? getProvider(current.provider) : getProvider(input.provider);
    if (!provider) throw new ValidationError(`Provedor de IA desconhecido: ${input.provider}`);

    const baseUrl = normalizeBaseUrl(
      input.baseUrl === undefined ? current.provider === provider.id ? current.baseUrl : provider.defaultBaseUrl : input.baseUrl,
    );

    const model = (input.model === undefined ? current.model : input.model).trim();
    if (model.length === 0) throw new ValidationError("Informe o modelo de IA que será usado.");
    if (model.length > 120) throw new ValidationError("O nome do modelo é longo demais.");

    let apiKey = current.apiKey;
    if (input.clearApiKey) apiKey = "";
    else if (input.apiKey !== undefined && input.apiKey.trim().length > 0) apiKey = input.apiKey.trim();
    if (apiKey.length > 400) throw new ValidationError("A chave de API é longa demais.");

    const maxLines = input.maxLines === undefined ? current.maxLines : Math.min(1000, Math.max(20, input.maxLines));
    const temperature =
      input.temperature === undefined ? current.temperature : Math.min(1, Math.max(0, input.temperature));

    const enabled = input.enabled ?? current.enabled;
    if (enabled && provider.requiresKey && apiKey.length === 0) {
      throw new ValidationError(`O provedor ${provider.label} exige uma chave de API para ser ativado.`);
    }

    const next: AiConfig = { enabled, provider: provider.id, model, apiKey, baseUrl, maxLines, temperature };
    this.writeConfig(next);
    return this.getSettings();
  }

  async listModels(draft: AiDraft = {}): Promise<AiModelListing> {
    const { provider, config } = this.resolveDraft(draft);
    const fallback = provider.models.map((model) => model.id);

    if (provider.requiresKey && config.apiKey.length === 0) {
      return { models: fallback, source: "builtin", error: "Configure a chave para buscar a lista real do provedor." };
    }

    const request = buildModelsRequest(provider, config.baseUrl, config.apiKey);
    if (!request) return { models: fallback, source: "builtin", error: null };

    try {
      const response = await fetch(request.url, {
        method: "GET",
        headers: request.headers,
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        return { models: fallback, source: "builtin", error: describeFailure(response.status, await response.text()) };
      }
      const models = parseModelsResponse(provider, await response.json());
      if (models.length === 0) {
        return { models: fallback, source: "builtin", error: "O provedor não devolveu nenhum modelo." };
      }
      return { models, source: "provider", error: null };
    } catch (error) {
      return {
        models: fallback,
        source: "builtin",
        error: error instanceof Error && error.name === "TimeoutError" ? "O provedor não respondeu a tempo." : errorMessage(error),
      };
    }
  }

  /** Chamada mínima só para validar chave/modelo/URL escolhidos. */
  async test(draft: AiDraft = {}): Promise<AiTestResult> {
    const { provider, config } = this.resolveDraft(draft);
    if (!config.model) throw new ValidationError("Informe o modelo de IA que será usado.");
    const request = buildChatRequest(provider, {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      system: "Responda apenas com a palavra OK.",
      user: "teste de conexão",
      maxTokens: 16,
      temperature: 0,
    });

    const startedAt = Date.now();
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(45_000),
      });
      const body = await response.text();
      if (!response.ok) {
        return {
          ok: false,
          message: describeFailure(response.status, body, config.model),
          provider: provider.id,
          model: config.model,
          latencyMs: Date.now() - startedAt,
        };
      }
      const text = parseChatResponse(provider, JSON.parse(body));
      return {
        ok: true,
        message: `Conexão funcionando. O modelo respondeu: "${text.slice(0, 60)}"`,
        provider: provider.id,
        model: config.model,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error && error.name === "TimeoutError"
            ? "Tempo esgotado ao falar com o provedor."
            : errorMessage(error),
        provider: provider.id,
        model: config.model,
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  /**
   * Registra a análise e chama o provedor em segundo plano: uma resposta de
   * modelo grande pode levar dezenas de segundos, e prender a requisição HTTP
   * faria a interface parecer travada. O andamento aparece no próprio registro.
   */
  analyze(
    app: AppRecord,
    status: { status: AppStatus; exitCode: number | null },
    logs: string,
    question: string,
  ): AiAnalysisRecord {
    const config = this.readConfig();
    if (!config.enabled) {
      throw new ValidationError("A análise com IA está desativada. Ative em Configurações e informe a chave do provedor.");
    }
    const { provider } = this.resolveProvider();

    const excerpt = redactSecrets(tailExcerpt(logs, config.maxLines, MAX_EXCERPT_CHARS));
    if (excerpt.length === 0) {
      throw new ValidationError("Não há linhas de log para analisar. Rode a aplicação e tente de novo.");
    }

    const id = this.store.startAiAnalysis({
      appId: app.id,
      slug: app.slug,
      provider: provider.id,
      model: config.model,
      question: question.trim().slice(0, 500),
      lineCount: excerpt.split("\n").length,
      excerpt,
      createdAt: nowIso(),
    });

    const record = this.store.getAiAnalysis(id);
    if (!record) throw new Error("Não foi possível registrar a análise.");

    void this.run(record, app, status, excerpt).catch(() => undefined);
    return record;
  }

  async run(
    record: AiAnalysisRecord,
    app: AppRecord,
    status: { status: AppStatus; exitCode: number | null },
    excerpt: string,
  ): Promise<void> {
    const { provider, config } = this.resolveProvider();
    const prompt = buildPrompt(
      {
        name: app.name,
        slug: app.slug,
        runtime: app.runtime,
        image: app.image,
        entry: app.entry,
        startCommand: app.startCommand,
        installCommand: app.installCommand,
        status: status.status,
        exitCode: status.exitCode,
        activeRelease: app.activeRelease,
        memoryMb: app.memoryMb,
        cpu: app.cpu,
      },
      excerpt,
      record.question,
    );

    const request = buildChatRequest(provider, {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: record.model,
      system: prompt.system,
      user: prompt.user,
      maxTokens: 2000,
      temperature: config.temperature,
    });

    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = await response.text();
      if (!response.ok) {
        this.finish(record.id, "failed", "", describeFailure(response.status, body, record.model));
        return;
      }
      const text = parseChatResponse(provider, JSON.parse(body));
      this.finish(record.id, "success", text, "");
      this.store.addEvent(app.id, "info", `Análise de logs com IA concluída (${provider.label} · ${record.model})`);
    } catch (error) {
      const message =
        error instanceof Error && error.name === "TimeoutError"
          ? "Tempo esgotado: o provedor não respondeu em 90 segundos."
          : errorMessage(error);
      this.finish(record.id, "failed", "", message);
    }
  }

  private finish(id: number, status: AiAnalysisStatus, result: string, error: string): void {
    this.store.finishAiAnalysis(id, status, result, error);
  }

  get(id: number): AiAnalysisRecord {
    const record = this.store.getAiAnalysis(id);
    if (!record) throw new NotFoundError(`Análise ${id} não encontrada.`);
    return record;
  }

  list(appId: string, limit = 20): AiAnalysisRecord[] {
    return this.store.listAiAnalyses(appId, limit);
  }

  remove(id: number): void {
    this.get(id);
    this.store.deleteAiAnalysis(id);
  }

  /** Análises interrompidas por um reinício ficariam "em execução" para sempre. */
  recoverInterrupted(): number {
    return this.store.failRunningAiAnalyses();
  }
}
