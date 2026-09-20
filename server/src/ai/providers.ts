import { ValidationError } from "../errors.ts";

/**
 * Formatos de API aceitos. Quase todo provedor relevante fala um destes três:
 * `openai` (chat/completions), `anthropic` (messages) e `google` (generateContent).
 * Manter a diferença concentrada aqui evita um cliente por provedor.
 */
export type AiFormat = "openai" | "anthropic" | "google";

/** Como a chave viaja na requisição. */
export type AiAuth = "bearer" | "anthropic" | "google" | "none";

export interface AiModelOption {
  id: string;
  label: string;
}

export interface AiProvider {
  id: string;
  label: string;
  /** Página onde o usuário cria a própria chave. */
  keysUrl: string;
  docsUrl: string;
  format: AiFormat;
  auth: AiAuth;
  defaultBaseUrl: string;
  /** `true` quando o usuário pode apontar para outro host (Ollama/compatível). */
  customBaseUrl: boolean;
  /** Ollama local não pede chave. */
  requiresKey: boolean;
  /** Nome do que o usuário cola, para o rótulo do campo. */
  keyLabel: string;
  /**
   * Sugestões de modelo. A lista de cada provedor muda com o tempo, então isto é
   * só um ponto de partida: o painel tenta buscar a lista real do provedor e o
   * campo aceita qualquer nome digitado.
   */
  models: AiModelOption[];
  defaultModel: string;
  /** Endpoint de listagem de modelos, quando o provedor tem um. */
  modelsEndpoint?: "openai" | "anthropic" | "google";
}

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: "openai",
    label: "OpenAI (ChatGPT)",
    keysUrl: "https://platform.openai.com/api-keys",
    docsUrl: "https://platform.openai.com/docs/api-reference/chat",
    format: "openai",
    auth: "bearer",
    defaultBaseUrl: "https://api.openai.com/v1",
    customBaseUrl: false,
    requiresKey: true,
    keyLabel: "API key (sk-…)",
    models: [
      { id: "gpt-5.1", label: "GPT-5.1" },
      { id: "gpt-5", label: "GPT-5" },
      { id: "gpt-4.1", label: "GPT-4.1" },
      { id: "gpt-4o-mini", label: "GPT-4o mini (mais barato)" },
    ],
    defaultModel: "gpt-4o-mini",
    modelsEndpoint: "openai",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    keysUrl: "https://console.anthropic.com/settings/keys",
    docsUrl: "https://docs.anthropic.com/en/api/messages",
    format: "anthropic",
    auth: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    customBaseUrl: false,
    requiresKey: true,
    keyLabel: "API key (sk-ant-…)",
    models: [
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
      { id: "claude-opus-4-1", label: "Claude Opus 4.1" },
      { id: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku (mais barato)" },
    ],
    defaultModel: "claude-sonnet-4-5",
    modelsEndpoint: "anthropic",
  },
  {
    id: "google",
    label: "Google (Gemini)",
    keysUrl: "https://aistudio.google.com/app/apikey",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    format: "google",
    auth: "google",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    customBaseUrl: false,
    requiresKey: true,
    keyLabel: "API key (AIza…)",
    models: [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash (mais barato)" },
    ],
    defaultModel: "gemini-2.5-flash",
    modelsEndpoint: "google",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    keysUrl: "https://platform.deepseek.com/api_keys",
    docsUrl: "https://api-docs.deepseek.com",
    format: "openai",
    auth: "bearer",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    customBaseUrl: false,
    requiresKey: true,
    keyLabel: "API key (sk-…)",
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat (V3)" },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner (R1)" },
    ],
    defaultModel: "deepseek-chat",
    modelsEndpoint: "openai",
  },
  {
    id: "groq",
    label: "Groq",
    keysUrl: "https://console.groq.com/keys",
    docsUrl: "https://console.groq.com/docs/openai",
    format: "openai",
    auth: "bearer",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    customBaseUrl: false,
    requiresKey: true,
    keyLabel: "API key (gsk_…)",
    // A Groq troca os modelos com frequência (nomes entram e saem da conta sem
    // aviso). Por isso a sugestão mais antiga e estável vem primeiro e o caminho
    // seguro é sempre o botão "buscar modelos", que lista o que a chave alcança.
    models: [
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B (mais rápido)" },
      { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
      { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B" },
      { id: "moonshotai/kimi-k2-instruct", label: "Kimi K2 Instruct" },
    ],
    defaultModel: "llama-3.1-8b-instant",
    modelsEndpoint: "openai",
  },
  {
    id: "openrouter",
    label: "OpenRouter (vários modelos, uma chave)",
    keysUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs",
    format: "openai",
    auth: "bearer",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    customBaseUrl: false,
    requiresKey: true,
    keyLabel: "API key (sk-or-…)",
    models: [
      { id: "openai/gpt-4o-mini", label: "OpenAI GPT-4o mini" },
      { id: "anthropic/claude-sonnet-4.5", label: "Anthropic Claude Sonnet 4.5" },
      { id: "google/gemini-2.5-flash", label: "Google Gemini 2.5 Flash" },
      { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
      { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
    ],
    defaultModel: "openai/gpt-4o-mini",
    modelsEndpoint: "openai",
  },
  {
    id: "ollama",
    label: "Ollama (local, sem custo)",
    keysUrl: "https://ollama.com/download",
    docsUrl: "https://github.com/ollama/ollama/blob/main/docs/openai.md",
    format: "openai",
    auth: "none",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    customBaseUrl: true,
    requiresKey: false,
    keyLabel: "API key (opcional)",
    models: [
      { id: "llama3.2", label: "Llama 3.2" },
      { id: "qwen2.5", label: "Qwen 2.5" },
      { id: "mistral", label: "Mistral" },
      { id: "deepseek-r1", label: "DeepSeek R1" },
    ],
    defaultModel: "llama3.2",
    modelsEndpoint: "openai",
  },
  {
    id: "custom",
    label: "Outro (compatível com OpenAI)",
    keysUrl: "",
    docsUrl: "",
    format: "openai",
    auth: "bearer",
    defaultBaseUrl: "",
    customBaseUrl: true,
    requiresKey: false,
    keyLabel: "API key (se o serviço exigir)",
    models: [],
    defaultModel: "",
    modelsEndpoint: "openai",
  },
];

export function getProvider(id: string): AiProvider | null {
  return AI_PROVIDERS.find((provider) => provider.id === id) ?? null;
}

export interface ChatRequestInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
}

export interface HttpRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Normaliza a URL base (sem barra final) e exige http(s). */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) throw new ValidationError("Informe a URL base do provedor.");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ValidationError(`URL inválida: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ValidationError("A URL base precisa começar com http:// ou https://.");
  }
  return trimmed;
}

/** Cabeçalhos de autenticação — a única parte que muda entre os provedores. */
function authHeaders(provider: AiProvider, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  switch (provider.auth) {
    case "bearer":
      if (apiKey.length > 0) headers["authorization"] = `Bearer ${apiKey}`;
      return headers;
    case "anthropic":
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      return headers;
    case "google":
      headers["x-goog-api-key"] = apiKey;
      return headers;
    default:
      return headers;
  }
}

/**
 * Monta a requisição de chat no formato do provedor. Função pura: dá para testar
 * cada formato sem rede.
 */
export function buildChatRequest(provider: AiProvider, input: ChatRequestInput): HttpRequest {
  const base = normalizeBaseUrl(input.baseUrl);
  const headers = authHeaders(provider, input.apiKey);

  if (provider.format === "anthropic") {
    return {
      url: `${base}/messages`,
      headers,
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens,
        temperature: input.temperature,
        system: input.system,
        messages: [{ role: "user", content: input.user }],
      }),
    };
  }

  if (provider.format === "google") {
    return {
      url: `${base}/models/${encodeURIComponent(input.model)}:generateContent`,
      headers,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: input.system }] },
        contents: [{ role: "user", parts: [{ text: input.user }] }],
        generationConfig: { maxOutputTokens: input.maxTokens, temperature: input.temperature },
      }),
    };
  }

  return {
    url: `${base}/chat/completions`,
    headers,
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.maxTokens,
      temperature: input.temperature,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    }),
  };
}

/** Extrai o texto da resposta, no formato do provedor. */
export function parseChatResponse(provider: AiProvider, payload: unknown): string {
  const body = payload as Record<string, unknown> | null;
  if (!body || typeof body !== "object") throw new Error("Resposta vazia do provedor.");

  if (provider.format === "anthropic") {
    const content = body["content"] as { type?: string; text?: string }[] | undefined;
    const text = (content ?? [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    if (text.length === 0) throw new Error("O provedor não devolveu texto.");
    return text;
  }

  if (provider.format === "google") {
    const candidates = body["candidates"] as { content?: { parts?: { text?: string }[] } }[] | undefined;
    const text = (candidates?.[0]?.content?.parts ?? [])
      .map((part) => part?.text ?? "")
      .join("")
      .trim();
    if (text.length === 0) {
      const reason = (body["promptFeedback"] as { blockReason?: string } | undefined)?.blockReason;
      throw new Error(reason ? `O provedor bloqueou a análise (${reason}).` : "O provedor não devolveu texto.");
    }
    return text;
  }

  const choices = body["choices"] as { message?: { content?: unknown } }[] | undefined;
  const content = choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim().length > 0) return content.trim();
  // Alguns modelos "reasoning" devolvem partes em vez de string.
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof (part as { text?: string })?.text === "string" ? (part as { text: string }).text : ""))
      .join("")
      .trim();
    if (text.length > 0) return text;
  }
  throw new Error("O provedor não devolveu texto.");
}

/** Requisição que lista os modelos disponíveis, quando o provedor suporta. */
export function buildModelsRequest(provider: AiProvider, baseUrl: string, apiKey: string): HttpRequest | null {
  if (!provider.modelsEndpoint) return null;
  const base = normalizeBaseUrl(baseUrl);
  return { url: `${base}/models`, headers: authHeaders(provider, apiKey), body: "" };
}

/** Lista de nomes de modelo a partir da resposta de `GET /models`. */
export function parseModelsResponse(provider: AiProvider, payload: unknown): string[] {
  const body = payload as Record<string, unknown> | null;
  const items = (body?.["data"] ?? body?.["models"]) as unknown;
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const entry = item as { id?: unknown; name?: unknown };
      const raw = typeof entry.id === "string" ? entry.id : typeof entry.name === "string" ? entry.name : "";
      // O Gemini devolve "models/gemini-2.5-flash".
      return raw.replace(/^models\//, "");
    })
    .filter((id) => id.length > 0 && !id.includes("embedding") && !id.includes("whisper") && !id.includes("tts"))
    .sort((a, b) => a.localeCompare(b));
}
