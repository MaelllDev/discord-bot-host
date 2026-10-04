import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Store } from "../src/db.ts";
import { CloudflareService } from "../src/cloudflare/service.ts";
import {
  CLOUDFLARE_COMPONENT_LABEL,
  CLOUDFLARE_CONTAINER_NAME,
  CLOUDFLARE_SETTINGS_KEY,
  readConfig,
} from "../src/cloudflare/config.ts";
import { buildServer } from "../src/server.ts";
import type { AppContext } from "../src/context.ts";
import { FakeDocker } from "./helpers/docker.ts";
import { testConfig } from "./helpers/config.ts";

/** Token de teste: formato plausível (base64), sem valor real nenhum. */
const TOKEN = "eyJhIjoiZmFrZS10dW5uZWwtdG9rZW4tcGFyYS10ZXN0ZXMifQ==";
const OTHER_TOKEN = "eyJhIjoib3V0cm8tdG9rZW4tZmFrby1wYXJhLXRlc3Rlcy1hcXVpIn0=";

let workDir: string;
let store: Store;
let docker: FakeDocker;
let service: CloudflareService;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "botpanel-cloudflare-"));
  store = await Store.open(workDir);
  docker = new FakeDocker();
  service = new CloudflareService(store, docker.asService());
});

afterEach(async () => {
  store.close();
  await fs.rm(workDir, { recursive: true, force: true });
});

/** Container do túnel já pertencente ao painel, como o serviço o cria. */
function seedOwnContainer(options: { status?: string; exitCode?: number; startedAt?: string; restartPolicy?: string } = {}) {
  return docker.seedContainer(CLOUDFLARE_CONTAINER_NAME, {
    labels: {
      "botpanel.managed": "1",
      "botpanel.component": CLOUDFLARE_COMPONENT_LABEL,
      "botpanel.instance": docker.instanceId,
    },
    restartPolicy: "unless-stopped",
    ...options,
  });
}

describe("cloudflare: configuração e segredo", () => {
  it("começa não configurado, sem tocar no Docker", async () => {
    const view = await service.view();
    expect(view.configured).toBe(false);
    expect(view.tokenSet).toBe(false);
    expect(view.tokenHint).toBe("");
    expect(view.state).toBe("not_configured");
    expect(docker.created).toHaveLength(0);
  });

  it("recusa conectar sem token salvo", async () => {
    await expect(service.connect()).rejects.toMatchObject({ code: "cloudflare.tokenRequired" });
    expect(docker.created).toHaveLength(0);
  });

  it("salva o token e só expõe uma dica mascarada", async () => {
    const view = await service.save({ token: TOKEN, enabled: true });
    expect(view.tokenSet).toBe(true);
    expect(view.configured).toBe(true);
    // A dica mostra apenas as pontas; o valor completo não sai daqui.
    expect(view.tokenHint).not.toContain(TOKEN.slice(10, 30));
    expect(view.tokenHint.startsWith(TOKEN.slice(0, 4))).toBe(true);
    expect(readConfig(store).token).toBe(TOKEN);
  });

  it("não devolve o token em nenhuma resposta", async () => {
    await service.save({ token: TOKEN, enabled: true });
    seedOwnContainer();
    const payload = JSON.stringify(await service.view());
    expect(payload).not.toContain(TOKEN);
    expect(payload).not.toContain(TOKEN.slice(-12));
  });

  it("preserva o token quando o salvamento não envia um novo", async () => {
    await service.save({ token: TOKEN, enabled: true });
    const view = await service.save({ enabled: false });
    expect(view.tokenSet).toBe(true);
    expect(readConfig(store).token).toBe(TOKEN);
    expect(readConfig(store).enabled).toBe(false);
  });

  it("recusa um token com formato impossível sem apagar o que já existe", async () => {
    await service.save({ token: TOKEN });
    await expect(service.save({ token: "curto demais" })).rejects.toMatchObject({
      code: "cloudflare.tokenInvalid",
    });
    expect(readConfig(store).token).toBe(TOKEN);
  });

  it("a configuração sobrevive a um novo Store (restart do painel)", async () => {
    await service.save({ token: TOKEN, enabled: true });
    const reopened = await Store.open(workDir);
    try {
      const config = readConfig(reopened);
      expect(config.token).toBe(TOKEN);
      expect(config.enabled).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it("ignora um JSON corrompido no banco em vez de derrubar a página", async () => {
    store.setSetting(CLOUDFLARE_SETTINGS_KEY, "{isso não é json");
    const view = await service.view();
    expect(view.tokenSet).toBe(false);
    expect(view.state).toBe("not_configured");
  });
});

describe("cloudflare: container", () => {
  it("cria o container com a imagem, o comando e as labels da integração", async () => {
    await service.save({ token: TOKEN, enabled: true });
    await service.connect();

    expect(docker.created).toHaveLength(1);
    const options = docker.created[0]!;
    expect(options.name).toBe(CLOUDFLARE_CONTAINER_NAME);
    expect(options.Image).toBe("cloudflare/cloudflared:latest");
    // Mesmo comando usado à mão: `tunnel --no-autoupdate run --token <TOKEN>`.
    expect(options.Cmd).toEqual(["tunnel", "--no-autoupdate", "run", "--token", TOKEN]);
    expect(options.Labels).toMatchObject({
      "botpanel.managed": "1",
      "botpanel.component": CLOUDFLARE_COMPONENT_LABEL,
      "botpanel.instance": docker.instanceId,
    });
    // Sem `botpanel.app`: o container NÃO pode ser tratado como aplicação do
    // usuário pela reconciliação de apps.
    expect(Object.keys(options.Labels ?? {})).not.toContain("botpanel.app");
    expect(docker.started).toEqual([CLOUDFLARE_CONTAINER_NAME]);
  });

  it("usa a política de reinício unless-stopped", async () => {
    await service.save({ token: TOKEN, enabled: true });
    await service.connect();

    expect(docker.created[0]?.HostConfig?.RestartPolicy).toEqual({ Name: "unless-stopped", MaximumRetryCount: 0 });
    const view = await service.view();
    expect(view.restartPolicy).toBe("unless-stopped");
  });

  it("não publica portas e não usa host networking", async () => {
    await service.save({ token: TOKEN, enabled: true });
    await service.connect();

    const host = docker.created[0]?.HostConfig ?? {};
    expect(host.PortBindings ?? null).toBeNull();
    expect(host.NetworkMode).toBe("bridge");
    expect(host.AutoRemove).toBe(false);
  });

  it("reaproveita o container existente em vez de criar outro", async () => {
    await service.save({ token: TOKEN, enabled: true });
    seedOwnContainer({ status: "exited" });
    await service.connect();

    expect(docker.created).toHaveLength(0);
    expect(docker.started).toEqual([CLOUDFLARE_CONTAINER_NAME]);
    // A política é realinhada mesmo quando o container já existia.
    expect(docker.policies).toContainEqual({ name: CLOUDFLARE_CONTAINER_NAME, policy: "unless-stopped" });
  });

  it("nunca cria duplicata ao conectar duas vezes", async () => {
    await service.save({ token: TOKEN, enabled: true });
    await service.connect();
    await service.connect();
    expect(docker.created).toHaveLength(1);
  });

  it("não assume um container estranho com o mesmo nome", async () => {
    await service.save({ token: TOKEN, enabled: true });
    // Container de outro processo (sem as labels), com o nome que o painel usa.
    docker.seedContainer(CLOUDFLARE_CONTAINER_NAME, { labels: {}, restartPolicy: "always" });

    await expect(service.connect()).rejects.toMatchObject({ code: "cloudflare.containerNameTaken" });
    expect(docker.created).toHaveLength(0);
    expect(docker.removed).toHaveLength(0);
    const view = await service.view();
    expect(view.state).toBe("error");
    expect(view.lastErrorCode).toBe("cloudflare.containerNameTaken");
  });

  it("não remove um container estranho ao pedir exclusão", async () => {
    await service.save({ token: TOKEN });
    docker.seedContainer(CLOUDFLARE_CONTAINER_NAME, { labels: {} });

    await expect(service.remove()).rejects.toMatchObject({ code: "cloudflare.containerNameTaken" });
    expect(docker.removed).toHaveLength(0);
    // A configuração continua intacta: o usuário decide o que fazer com o container.
    expect(readConfig(store).token).toBe(TOKEN);
  });

  it("reporta container ausente como erro quando a integração está habilitada", async () => {
    await service.save({ token: TOKEN, enabled: true });
    const view = await service.view();
    expect(view.state).toBe("error");
    expect(view.lastErrorCode).toBe("cloudflare.containerMissing");
  });
});

describe("cloudflare: conexão, status e health", () => {
  it("conecta, registra o container e o estado seguro", async () => {
    await service.save({ token: TOKEN, enabled: true });
    const view = await service.connect();
    expect(view.enabled).toBe(true);
    expect(view.containerId).toBeTruthy();
    expect(view.tokenSet).toBe(true);
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });

  it("distingue container rodando de túnel conectado", async () => {
    await service.save({ token: TOKEN, enabled: true });
    seedOwnContainer();
    docker.logs = "2026-09-28T10:00:00Z INF Starting tunnel";
    const waiting = await service.view();
    expect(waiting.containerStatus).toBe("running");
    expect(waiting.state).toBe("disconnected");

    docker.logs = "2026-09-28T10:00:01Z INF Registered tunnel connection connIndex=0";
    const connected = await service.view();
    expect(connected.state).toBe("connected");
    expect(connected.lastErrorCode).toBeNull();
  });

  it("mostra starting enquanto o container acabou de subir", async () => {
    await service.save({ token: TOKEN, enabled: true });
    seedOwnContainer({ startedAt: new Date(Date.now() - 5_000).toISOString() });
    const view = await service.view();
    expect(view.state).toBe("starting");
    expect(view.uptimeSeconds).toBeGreaterThan(0);
  });

  it("trata falha nos logs como erro de conexão", async () => {
    await service.save({ token: TOKEN, enabled: true });
    seedOwnContainer();
    docker.logs = "2026-09-28T10:00:00Z ERR Failed to connect to edge: invalid tunnel token";
    const view = await service.view();
    expect(view.state).toBe("error");
    expect(view.lastErrorCode).toBe("cloudflare.connectionFailed");
    // A evidência é redigida antes de sair do serviço.
    expect(view.lastError).not.toContain(TOKEN);
  });

  it("o teste de conexão não cria nem reinicia nada", async () => {
    await service.save({ token: TOKEN, enabled: true });
    seedOwnContainer();
    docker.logs = "INF Registered tunnel connection";
    const view = await service.test();
    expect(view.state).toBe("connected");
    expect(docker.created).toHaveLength(0);
    expect(docker.restarted).toHaveLength(0);
    expect(docker.started).toHaveLength(0);
  });

  it("o teste falha com código estável quando o túnel não conectou", async () => {
    await service.save({ token: TOKEN, enabled: true });
    seedOwnContainer();
    docker.logs = "INF Starting tunnel";
    await expect(service.test()).rejects.toMatchObject({ code: "cloudflare.notConnected" });
  });

  it("o teste recusa quando o container ainda não existe", async () => {
    await service.save({ token: TOKEN, enabled: true });
    await expect(service.test()).rejects.toMatchObject({ code: "cloudflare.containerNotFound" });
  });
});

describe("cloudflare: ações", () => {
  it("desconecta sem apagar token nem configuração", async () => {
    await service.save({ token: TOKEN, enabled: true });
    seedOwnContainer();
    const view = await service.disconnect();

    expect(docker.stopped).toEqual([CLOUDFLARE_CONTAINER_NAME]);
    expect(view.enabled).toBe(false);
    expect(view.state).toBe("stopped");
    expect(readConfig(store).token).toBe(TOKEN);
  });

  it("reinicia o container mantendo a configuração", async () => {
    await service.save({ token: TOKEN, enabled: true });
    seedOwnContainer();
    docker.logs = "INF Registered tunnel connection";
    const view = await service.restart();

    expect(docker.restarted).toEqual([CLOUDFLARE_CONTAINER_NAME]);
    expect(readConfig(store).token).toBe(TOKEN);
    expect(view.enabled).toBe(true);
  });

  it("o reinício cria o container quando ele não existe", async () => {
    await service.save({ token: TOKEN, enabled: true });
    await service.restart();
    expect(docker.created).toHaveLength(1);
  });

  it("remover apaga container e configuração, inclusive o token", async () => {
    await service.save({ token: TOKEN, enabled: true });
    seedOwnContainer();
    const view = await service.remove();

    expect(docker.removed).toEqual([CLOUDFLARE_CONTAINER_NAME]);
    expect(readConfig(store).token).toBe("");
    expect(view.configured).toBe(false);
    expect(view.state).toBe("not_configured");
    expect(view.containerStatus).toBeNull();
  });

  it("trocar o token recria o container (o token vive no comando)", async () => {
    await service.save({ token: TOKEN, enabled: true });
    await service.connect();
    expect(docker.created).toHaveLength(1);

    await service.save({ token: OTHER_TOKEN, enabled: true });
    expect(docker.removed).toEqual([CLOUDFLARE_CONTAINER_NAME]);
    expect(docker.created).toHaveLength(2);
    expect(docker.created[1]?.Cmd).toContain(OTHER_TOKEN);
    expect(docker.created[1]?.Cmd).not.toContain(TOKEN);
  });
});

describe("cloudflare: boot", () => {
  it("sobe o container no start quando habilitado", async () => {
    await service.save({ token: TOKEN, enabled: true });
    await service.reconcileOnStartup();
    expect(docker.created).toHaveLength(1);
    expect(docker.started).toEqual([CLOUDFLARE_CONTAINER_NAME]);
  });

  it("realinha a política e o estado de um container já existente", async () => {
    await service.save({ token: TOKEN, enabled: true });
    seedOwnContainer({ status: "exited", restartPolicy: "no" });
    await service.reconcileOnStartup();
    expect(docker.created).toHaveLength(0);
    expect(docker.policies).toContainEqual({ name: CLOUDFLARE_CONTAINER_NAME, policy: "unless-stopped" });
    expect(docker.started).toEqual([CLOUDFLARE_CONTAINER_NAME]);
  });

  it("não faz nada quando o usuário desconectou", async () => {
    await service.save({ token: TOKEN, enabled: true });
    seedOwnContainer();
    await service.disconnect();
    docker.created.length = 0;
    docker.started.length = 0;

    await service.reconcileOnStartup();
    expect(docker.created).toHaveLength(0);
    expect(docker.started).toHaveLength(0);
  });

  it("não faz nada quando nunca foi configurado", async () => {
    await service.reconcileOnStartup();
    expect(docker.containers.size).toBe(0);
  });

  it("o boot do painel não falha quando o Docker está fora do ar", async () => {
    await service.save({ token: TOKEN, enabled: true });
    docker.available = false;
    await expect(service.reconcileOnStartup()).resolves.toBeUndefined();
    expect(readConfig(store).lastError).toMatch(/Docker indisponível/);
  });
});

describe("cloudflare: falhas", () => {
  it("trata Docker indisponível como estado, sem derrubar a leitura", async () => {
    await service.save({ token: TOKEN, enabled: true });
    docker.available = false;
    const view = await service.view();
    expect(view.dockerAvailable).toBe(false);
    expect(view.state).toBe("unknown");
    expect(view.lastErrorCode).toBe("cloudflare.dockerUnavailable");
  });

  it("conectar com Docker indisponível devolve código estável", async () => {
    await service.save({ token: TOKEN, enabled: true });
    docker.available = false;
    await expect(service.connect()).rejects.toMatchObject({ code: "cloudflare.dockerUnavailable" });
  });

  it("falha ao baixar a imagem devolve imagePullFailed", async () => {
    await service.save({ token: TOKEN, enabled: true });
    docker.ensureImageError = new Error("no such host: registry-1.docker.io");
    await expect(service.connect()).rejects.toMatchObject({ code: "cloudflare.imagePullFailed" });
    expect(docker.created).toHaveLength(0);
    expect(readConfig(store).lastError).toBeTruthy();
  });

  it("falha ao iniciar o container devolve containerStartFailed", async () => {
    await service.save({ token: TOKEN, enabled: true });
    docker.startError = new Error("driver failed programming external connectivity");
    await expect(service.connect()).rejects.toMatchObject({ code: "cloudflare.containerStartFailed" });
  });

  it("uma falha registrada é sempre redigida", async () => {
    await service.save({ token: TOKEN, enabled: true });
    docker.startError = new Error(`falha ao iniciar com o token ${TOKEN} no comando`);
    await expect(service.connect()).rejects.toBeTruthy();

    const stored = readConfig(store).lastError ?? "";
    expect(stored).not.toContain(TOKEN);
    expect(stored).toContain("<token-redigido>");
    // E a mensagem devolvida à API também não vaza o segredo.
    await expect(service.connect()).rejects.toSatisfy((error: unknown) => !String((error as Error).message).includes(TOKEN));
  });

  it("os logs devolvidos não contêm o token", async () => {
    await service.save({ token: TOKEN, enabled: true });
    docker.logs = `INF test with token ${TOKEN}\nINF Registered tunnel connection`;
    const lines = await service.logs(50);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines.join("\n")).toContain("<token-redigido>");
  });

  it("limita a quantidade de linhas pedidas", async () => {
    await service.save({ token: TOKEN, enabled: true });
    docker.logs = Array.from({ length: 500 }, (_, index) => `linha ${index}`).join("\n");
    const lines = await service.logs(200);
    expect(lines.length).toBeLessThanOrEqual(200);
    expect(lines.at(-1)).toBe("linha 499");
  });
});

describe("cloudflare: API", () => {
  let apiDir: string;
  let server: FastifyInstance;
  let context: AppContext;
  let cookie: string;

  beforeEach(async () => {
    apiDir = await fs.mkdtemp(path.join(os.tmpdir(), "botpanel-cloudflare-api-"));
    // Socket inexistente: cobre o caminho "Docker fora do ar" pela API.
    const built = await buildServer(testConfig(apiDir));
    server = built.server;
    context = built.context;
    await server.ready();
    const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { password: "senha-de-teste" } });
    const raw = login.headers["set-cookie"];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header) throw new Error("login não devolveu cookie");
    cookie = header.split(";")[0] ?? "";
  });

  afterEach(async () => {
    await server.close();
    context.store.close();
    await fs.rm(apiDir, { recursive: true, force: true });
  });

  it("exige sessão em todas as rotas da integração", async () => {
    for (const [method, url] of [
      ["GET", "/api/cloudflare"],
      ["GET", "/api/cloudflare/logs"],
      ["PUT", "/api/cloudflare"],
      ["POST", "/api/cloudflare/connect"],
      ["POST", "/api/cloudflare/disconnect"],
      ["POST", "/api/cloudflare/restart"],
      ["POST", "/api/cloudflare/test"],
      ["DELETE", "/api/cloudflare"],
    ] as const) {
      const response = await server.inject({ method, url, payload: {} });
      expect({ route: `${method} ${url}`, status: response.statusCode }).toEqual({
        route: `${method} ${url}`,
        status: 401,
      });
    }
  });

  it("o GET devolve o estado seguro sem o token", async () => {
    await server.inject({ method: "PUT", url: "/api/cloudflare", headers: { cookie }, payload: { token: TOKEN, enabled: true } });
    const response = await server.inject({ method: "GET", url: "/api/cloudflare", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).not.toContain(TOKEN);
    const tunnel = response.json().tunnel as Record<string, unknown>;
    expect(tunnel["tokenSet"]).toBe(true);
    expect(tunnel["tokenHint"]).toBeTruthy();
    expect(tunnel["state"]).toBe("unknown");
    expect(tunnel["dockerAvailable"]).toBe(false);
  });

  it("o PUT sem token preserva o token salvo", async () => {
    await server.inject({ method: "PUT", url: "/api/cloudflare", headers: { cookie }, payload: { token: TOKEN } });
    const response = await server.inject({ method: "PUT", url: "/api/cloudflare", headers: { cookie }, payload: { enabled: true } });

    expect(response.statusCode).toBe(200);
    expect(response.json().tunnel.tokenSet).toBe(true);
    expect(readConfig(context.store).token).toBe(TOKEN);
  });

  it("conectar sem Docker responde erro com código estável", async () => {
    await server.inject({ method: "PUT", url: "/api/cloudflare", headers: { cookie }, payload: { token: TOKEN, enabled: true } });
    const response = await server.inject({ method: "POST", url: "/api/cloudflare/connect", headers: { cookie } });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(TOKEN);
  });

  it("conectar sem token responde 400 com o código da interface", async () => {
    const response = await server.inject({ method: "POST", url: "/api/cloudflare/connect", headers: { cookie } });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("cloudflare.tokenRequired");
  });

  it("recusa um token inválido com 400", async () => {
    const response = await server.inject({
      method: "PUT",
      url: "/api/cloudflare",
      headers: { cookie },
      payload: { token: "sem-formato-nenhum 123" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("cloudflare.tokenInvalid");
  });

  it("o DELETE limpa container e configuração", async () => {
    await server.inject({ method: "PUT", url: "/api/cloudflare", headers: { cookie }, payload: { token: TOKEN } });
    const response = await server.inject({ method: "DELETE", url: "/api/cloudflare", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json().tunnel.configured).toBe(false);
    expect(readConfig(context.store).token).toBe("");
  });

  it("não aceita o token por query string", async () => {
    const response = await server.inject({
      method: "PUT",
      url: `/api/cloudflare?token=${encodeURIComponent(TOKEN)}`,
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    // O corpo da query é ignorado: nada foi salvo.
    expect(readConfig(context.store).token).toBe("");
  });
});
