import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.ts";
import type { AppContext } from "../src/context.ts";
import { testConfig } from "./helpers/config.ts";
import {
  AI_PROVIDERS,
  buildChatRequest,
  buildModelsRequest,
  getProvider,
  normalizeBaseUrl,
  parseChatResponse,
  parseModelsResponse,
} from "../src/ai/providers.ts";
import { buildPrompt, redactSecrets, tailExcerpt } from "../src/ai/prompt.ts";
import type { AiProvider } from "../src/ai/providers.ts";

/** Última chamada recebida pelo provedor falso. */
function lastCall(calls: { url: string; headers: Record<string, unknown>; body: string }[]) {
  return calls[calls.length - 1];
}

const openai = getProvider("openai");
const anthropic = getProvider("anthropic");
const google = getProvider("google");
if (!openai || !anthropic || !google) throw new Error("catálogo de provedores incompleto");

describe("provedores de IA", () => {
  it("monta a requisição no formato OpenAI", () => {
    const request = buildChatRequest(openai, {
      baseUrl: "https://api.openai.com/v1/",
      apiKey: "sk-teste",
      model: "gpt-4o-mini",
      system: "sistema",
      user: "usuário",
      maxTokens: 100,
      temperature: 0.2,
    });
    expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(request.headers["authorization"]).toBe("Bearer sk-teste");
    const body = JSON.parse(request.body) as { messages: { role: string }[] };
    expect(body.messages.map((message) => message.role)).toEqual(["system", "user"]);
  });

  it("monta a requisição no formato Anthropic (chave em x-api-key)", () => {
    const request = buildChatRequest(anthropic, {
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-teste",
      model: "claude-sonnet-4-5",
      system: "sistema",
      user: "usuário",
      maxTokens: 100,
      temperature: 0.2,
    });
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers["x-api-key"]).toBe("sk-ant-teste");
    expect(request.headers["anthropic-version"]).toBeTruthy();
    expect(request.headers["authorization"]).toBeUndefined();
    const body = JSON.parse(request.body) as { system: string; messages: unknown[] };
    expect(body.system).toBe("sistema");
    expect(body.messages).toHaveLength(1);
  });

  it("monta a requisição no formato Google (modelo na URL e chave em header)", () => {
    const request = buildChatRequest(google, {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "AIza-teste",
      model: "gemini-2.5-flash",
      system: "sistema",
      user: "usuário",
      maxTokens: 100,
      temperature: 0.2,
    });
    expect(request.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(request.headers["x-goog-api-key"]).toBe("AIza-teste");
    expect(JSON.parse(request.body)).toMatchObject({ contents: [{ role: "user" }] });
  });

  it("lê a resposta de cada formato e reclama de resposta vazia", () => {
    expect(parseChatResponse(openai, { choices: [{ message: { content: "oi" } }] })).toBe("oi");
    expect(parseChatResponse(openai, { choices: [{ message: { content: [{ text: "par" }, { text: "tes" }] } }] })).toBe("partes");
    expect(parseChatResponse(anthropic, { content: [{ type: "text", text: "claude" }] })).toBe("claude");
    expect(parseChatResponse(google, { candidates: [{ content: { parts: [{ text: "gemini" }] } }] })).toBe("gemini");

    expect(() => parseChatResponse(openai, { choices: [] })).toThrow(/não devolveu texto/);
    expect(() => parseChatResponse(google, { promptFeedback: { blockReason: "SAFETY" } })).toThrow(/SAFETY/);
  });

  it("valida a URL base", () => {
    expect(normalizeBaseUrl(" https://api.exemplo.com/v1/ ")).toBe("https://api.exemplo.com/v1");
    expect(() => normalizeBaseUrl("")).toThrow(/URL base/);
    expect(() => normalizeBaseUrl("api.exemplo.com")).toThrow(/URL inválida/);
    expect(() => normalizeBaseUrl("file:///etc/passwd")).toThrow(/http/);
  });

  it("lista modelos sem embeddings e sem o prefixo models/", () => {
    expect(
      parseModelsResponse(openai, {
        data: [{ id: "gpt-4o-mini" }, { id: "text-embedding-3-small" }, { id: "whisper-1" }],
      }),
    ).toEqual(["gpt-4o-mini"]);
    expect(parseModelsResponse(google, { models: [{ name: "models/gemini-2.5-flash" }] })).toEqual(["gemini-2.5-flash"]);
    expect(parseModelsResponse(openai, {})).toEqual([]);
    expect(buildModelsRequest(ollamaLike(), "http://127.0.0.1:11434/v1", "")?.url).toBe("http://127.0.0.1:11434/v1/models");
  });

  it("todo provedor tem formato, URL e modelo padrão coerentes", () => {
    for (const provider of AI_PROVIDERS) {
      expect(["openai", "anthropic", "google"]).toContain(provider.format);
      if (provider.id !== "custom") {
        expect(provider.defaultBaseUrl).toMatch(/^https?:\/\//);
        expect(provider.defaultModel.length).toBeGreaterThan(0);
      }
      expect(provider.keysUrl === "" || provider.keysUrl.startsWith("https://")).toBe(true);
    }
  });
});

function ollamaLike(): AiProvider {
  const provider = getProvider("ollama");
  if (!provider) throw new Error("provedor ollama ausente");
  return provider;
}

describe("prompt e redação de segredos", () => {
  it("mascara credenciais óbvias antes de enviar o log", () => {
    const token = "MTIzNDU2Nzg5MDEyMzQ1Njc4.Gh1jKl.abcdefghijklmnopqrstuvwxyz1234567";
    const log = [
      `[bot] login com Bot ${token}`,
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
      "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz",
      "DATABASE_URL=postgres://user:senha-secreta@localhost:5432/db",
      "token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmno",
    ].join("\n");

    const redacted = redactSecrets(log);
    expect(redacted).not.toContain(token);
    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(redacted).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("senha-secreta");
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0");
    // O resto da mensagem precisa continuar legível para o modelo entender.
    expect(redacted).toContain("[bot] login com");
    expect(redacted).toContain("DATABASE_URL=postgres://user:");
  });

  it("corta o log pelas últimas linhas e por tamanho", () => {
    const log = Array.from({ length: 50 }, (_, index) => `linha ${index + 1}`).join("\n");
    const excerpt = tailExcerpt(log, 3);
    expect(excerpt.split("\n")).toEqual(["linha 48", "linha 49", "linha 50"]);

    const huge = "x".repeat(1000);
    expect(tailExcerpt(huge, 10, 100).length).toBe(100);
  });

  it("monta o prompt com o contexto da aplicação e a pergunta", () => {
    const prompt = buildPrompt(
      {
        name: "Meu Bot",
        slug: "meu-bot",
        runtime: "python",
        image: "python:3.12-slim",
        entry: "bot.py",
        startCommand: "",
        installCommand: "",
        status: "crashed",
        exitCode: 137,
        activeRelease: 2,
        memoryMb: 512,
        cpu: 0.5,
      },
      "ModuleNotFoundError: No module named 'aiohttp'",
      "o que está faltando?",
    );
    expect(prompt.system).toContain("português do Brasil");
    expect(prompt.user).toContain("Meu Bot (meu-bot)");
    expect(prompt.user).toContain("python:3.12-slim");
    expect(prompt.user).toContain("código de saída 137");
    expect(prompt.user).toContain("v2");
    expect(prompt.user).toContain("ModuleNotFoundError");
    expect(prompt.user).toContain("o que está faltando?");
  });
});

// ------------------------------------------------------------------ rotas

interface FakeCall {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Provedor falso: registra o que o painel enviou e responde no formato OpenAI. */
async function startFakeProvider(
  handler?: (call: FakeCall) => { status: number; body: string },
): Promise<{ baseUrl: string; calls: FakeCall[]; close: () => Promise<void> }> {
  const calls: FakeCall[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const call: FakeCall = {
        method: request.method ?? "GET",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      calls.push(call);
      const answer =
        handler?.(call) ??
        (call.url.includes("/models")
          ? { status: 200, body: JSON.stringify({ data: [{ id: "modelo-falso-1" }, { id: "modelo-falso-2" }] }) }
          : { status: 200, body: JSON.stringify({ choices: [{ message: { content: "## Resumo\nTudo certo." } }] }) });
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(answer.body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("análise de logs com IA (rotas)", () => {
  let workDir: string;
  let server: FastifyInstance;
  let context: AppContext;
  let cookie: string;
  let provider: Awaited<ReturnType<typeof startFakeProvider>>;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "botpanel-ai-"));
    const built = await buildServer(testConfig(workDir));
    server = built.server;
    context = built.context;
    await server.ready();
    provider = await startFakeProvider();

    const login = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "senha-de-teste" },
    });
    const raw = login.headers["set-cookie"];
    const header = Array.isArray(raw) ? raw[0] : raw;
    cookie = (header ?? "").split(";")[0] ?? "";
  });

  afterEach(async () => {
    await server.close();
    context.store.close();
    await provider.close();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  function auth(): Record<string, string> {
    return { cookie };
  }

  async function configure(payload: Record<string, unknown> = {}): Promise<void> {
    const response = await server.inject({
      method: "PUT",
      url: "/api/ai/settings",
      headers: auth(),
      payload: { enabled: true, provider: "custom", model: "modelo-falso", baseUrl: provider.baseUrl, apiKey: "chave-secreta-de-teste", ...payload },
    });
    expect(response.statusCode).toBe(200);
  }

  async function createApp(): Promise<string> {
    const response = await server.inject({
      method: "POST",
      url: "/api/apps",
      headers: auth(),
      payload: { name: "Bot IA", runtime: "node", entry: "index.js" },
    });
    expect(response.statusCode).toBe(201);
    return response.json().app.slug as string;
  }

  interface WaitedAnalysis {
    id: number;
    status: string;
    result: string;
    error: string;
    excerpt: string;
  }

  async function waitForAnalysis(id: number): Promise<WaitedAnalysis> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const response = await server.inject({ method: "GET", url: `/api/ai/analyses/${id}`, headers: auth() });
      const analysis = response.json().analysis as WaitedAnalysis;
      if (analysis.status !== "running") return analysis;
    }
    throw new Error("a análise não terminou");
  }

  it("salva a configuração sem nunca devolver a chave", async () => {
    await configure();
    const response = await server.inject({ method: "GET", url: "/api/ai/settings", headers: auth() });
    const { settings, providers } = response.json() as { settings: Record<string, unknown>; providers: unknown[] };

    expect(settings["enabled"]).toBe(true);
    expect(settings["apiKeySet"]).toBe(true);
    expect(settings["apiKeyHint"]).toBe("cha••••este");
    expect(JSON.stringify(response.json())).not.toContain("chave-secreta-de-teste");
    expect(providers.length).toBeGreaterThanOrEqual(5);

    // Reenviar o formulário sem a chave mantém a chave salva.
    await server.inject({
      method: "PUT",
      url: "/api/ai/settings",
      headers: auth(),
      payload: { enabled: true, provider: "custom", model: "outro-modelo", baseUrl: provider.baseUrl },
    });
    const after = await server.inject({ method: "GET", url: "/api/ai/settings", headers: auth() });
    expect(after.json().settings.apiKeySet).toBe(true);

    // `clearApiKey` é a única forma de removê-la, e um provedor que exige chave
    // não pode ficar ativo sem ela.
    const cleared = await server.inject({
      method: "PUT",
      url: "/api/ai/settings",
      headers: auth(),
      payload: { enabled: false, clearApiKey: true },
    });
    expect(cleared.json().settings.apiKeySet).toBe(false);
  });

  it("recusa ativar um provedor que exige chave quando ela não foi informada", async () => {
    const response = await server.inject({
      method: "PUT",
      url: "/api/ai/settings",
      headers: auth(),
      payload: { enabled: true, provider: "openai", model: "gpt-4o-mini" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/exige uma chave/);
  });

  it("lista os modelos do provedor", async () => {
    await configure();
    const response = await server.inject({ method: "GET", url: "/api/ai/models", headers: auth() });
    expect(response.json().models.source).toBe("provider");
    expect(response.json().models.models).toEqual(["modelo-falso-1", "modelo-falso-2"]);
    expect(lastCall(provider.calls)?.url).toBe("/v1/models");
    expect(lastCall(provider.calls)?.headers["authorization"]).toBe("Bearer chave-secreta-de-teste");
  });

  it("lista e testa usando os campos do formulário, antes de salvar", async () => {
    // Este é o defeito que fazia o botão parecer quebrado: a busca usava a
    // configuração salva, então quem acabara de digitar a chave recebia apenas a
    // lista de sugestões do painel (e o modelo sugerido podia nem existir).
    const listed = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: auth(),
      payload: { provider: "custom", model: "modelo-falso-1", baseUrl: provider.baseUrl, apiKey: "chave-digitada-nao-salva" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().models.source).toBe("provider");
    expect(listed.json().models.models).toEqual(["modelo-falso-1", "modelo-falso-2"]);
    expect(lastCall(provider.calls)?.headers["authorization"]).toBe("Bearer chave-digitada-nao-salva");

    const tested = await server.inject({
      method: "POST",
      url: "/api/ai/test",
      headers: auth(),
      payload: { provider: "custom", model: "modelo-digitado", baseUrl: provider.baseUrl, apiKey: "chave-digitada-nao-salva" },
    });
    expect(tested.json().result.ok).toBe(true);
    expect(tested.json().result.model).toBe("modelo-digitado");
    expect(JSON.parse(String(lastCall(provider.calls)?.body))).toMatchObject({ model: "modelo-digitado" });

    // Sem corpo, vale a configuração salva (o `apiKeySet` continua falso porque
    // nada foi salvo nesta altura).
    const saved = await server.inject({ method: "GET", url: "/api/ai/settings", headers: auth() });
    expect(saved.json().settings.apiKeySet).toBe(false);
  });

  it("explica que o modelo não existe e manda usar 'buscar modelos'", async () => {
    await configure();
    await provider.close();
    provider = await startFakeProvider(() => ({
      status: 404,
      body: JSON.stringify({
        error: { message: "The model `llama-3.3-70b-versatile` does not exist or you do not have access to it." },
      }),
    }));

    const tested = await server.inject({
      method: "POST",
      url: "/api/ai/test",
      headers: auth(),
      payload: { provider: "custom", model: "llama-3.3-70b-versatile", baseUrl: provider.baseUrl },
    });
    const result = tested.json().result as { ok: boolean; message: string };
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/não existe nesta conta/);
    expect(result.message).toMatch(/buscar modelos/);
    expect(result.message).toMatch(/llama-3\.3-70b-versatile/);
  });

  it("testa a conexão sem analisar nenhum log", async () => {
    await configure();
    const response = await server.inject({ method: "POST", url: "/api/ai/test", headers: auth() });
    const { result } = response.json() as { result: { ok: boolean; message: string } };
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Conexão funcionando");
    expect(provider.calls).toHaveLength(1);
  });

  it("nunca envia a chave nem segredos do log para o provedor", async () => {
    await configure();
    const slug = await createApp();
    const logs = [
      "[bot] iniciando",
      "Authorization: Bot MTIzNDU2Nzg5MDEyMzQ1Njc4.Gh1jKl.abcdefghijklmnopqrstuvwxyz1234567",
      "ModuleNotFoundError: No module named 'aiohttp'",
    ].join("\n");

    const started = await server.inject({
      method: "POST",
      url: `/api/apps/${slug}/ai/analyze`,
      headers: auth(),
      payload: { logs, question: "por que quebrou?" },
    });
    expect(started.statusCode).toBe(202);
    const analysis = await waitForAnalysis(started.json().analysis.id as number);
    expect(analysis.status).toBe("success");
    expect(analysis.result).toContain("Resumo");
    expect(analysis.excerpt).toContain("ModuleNotFoundError");
    expect(analysis.excerpt).not.toContain("MTIzNDU2Nzg5MDEyMzQ1Njc4");

    const sent = lastCall(provider.calls);
    expect(sent?.url).toBe("/v1/chat/completions");
    expect(sent?.headers["authorization"]).toBe("Bearer chave-secreta-de-teste");
    // A chave pode ir no cabeçalho, mas nunca no corpo (que é o que fica salvo).
    expect(sent?.body).not.toContain("chave-secreta-de-teste");
    expect(sent?.body).not.toContain("MTIzNDU2Nzg5MDEyMzQ1Njc4");
    expect(sent?.body).toContain("por que quebrou?");
    expect(sent?.body).toContain("ModuleNotFoundError");

    const list = await server.inject({ method: "GET", url: `/api/apps/${slug}/ai/analyses`, headers: auth() });
    expect(list.json().analyses).toHaveLength(1);

    const removed = await server.inject({ method: "DELETE", url: `/api/ai/analyses/${analysis.id}`, headers: auth() });
    expect(removed.statusCode).toBe(200);
    const after = await server.inject({ method: "GET", url: `/api/apps/${slug}/ai/analyses`, headers: auth() });
    expect(after.json().analyses).toHaveLength(0);
  });

  it("registra a falha do provedor no lugar de um resultado inventado", async () => {
    await configure();
    const slug = await createApp();
    await provider.close();
    provider = await startFakeProvider(() => ({ status: 429, body: JSON.stringify({ error: { message: "quota esgotada" } }) }));
    await configure();

    const started = await server.inject({
      method: "POST",
      url: `/api/apps/${slug}/ai/analyze`,
      headers: auth(),
      payload: { logs: "[bot] erro\nstack trace", question: "" },
    });
    expect(started.statusCode).toBe(202);
    const analysis = await waitForAnalysis(started.json().analysis.id as number);
    expect(analysis.status).toBe("failed");
    expect(analysis.error).toMatch(/429/);
    expect(analysis.error).toMatch(/quota esgotada/);
    expect(analysis.result).toBe("");
  });

  it("recusa analisar com a IA desativada, sem logs ou sem aplicação", async () => {
    const slug = await createApp();
    const disabled = await server.inject({
      method: "POST",
      url: `/api/apps/${slug}/ai/analyze`,
      headers: auth(),
      payload: { logs: "alguma coisa", question: "" },
    });
    expect(disabled.statusCode).toBe(400);
    expect(disabled.json().error).toMatch(/desativada/);

    await configure();
    const empty = await server.inject({
      method: "POST",
      url: `/api/apps/${slug}/ai/analyze`,
      headers: auth(),
      payload: { logs: "", question: "" },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toMatch(/não há linhas/i);

    const missing = await server.inject({
      method: "POST",
      url: "/api/apps/nao-existe/ai/analyze",
      headers: auth(),
      payload: { logs: "x", question: "" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("exige sessão em todas as rotas de IA", async () => {
    for (const route of ["/api/ai/settings", "/api/ai/models", "/api/apps/x/ai/analyses"]) {
      const response = await server.inject({ method: "GET", url: route });
      expect(response.statusCode).toBe(401);
    }
  });
});
