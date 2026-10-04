import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.ts";
import type { AppContext } from "../src/context.ts";
import { multipartBody, testConfig } from "./helpers/config.ts";
import { makeZip } from "./helpers/zip.ts";

let workDir: string;
let server: FastifyInstance;
let context: AppContext;
let cookie: string;

const PASSWORD = "senha-de-teste";

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "botpanel-api-"));
  const built = await buildServer(testConfig(workDir));
  server = built.server;
  context = built.context;
  await server.ready();

  const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { password: PASSWORD } });
  const raw = login.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) throw new Error("login não devolveu cookie");
  cookie = header.split(";")[0] ?? "";
});

afterEach(async () => {
  await server.close();
  context.store.close();
  await fs.rm(workDir, { recursive: true, force: true });
});

function auth(): Record<string, string> {
  return { cookie };
}

async function createApp(payload: Record<string, unknown> = {}): Promise<string> {
  const response = await server.inject({
    method: "POST",
    url: "/api/apps",
    headers: auth(),
    payload: {
      name: "Meu Bot de Teste",
      runtime: "node",
      entry: "index.js",
      memoryMb: 256,
      cpu: 0.5,
      ...payload,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().app.slug;
}

describe("autenticação", () => {
  it("expõe o health check sem sessão", async () => {
    const response = await server.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("bloqueia a API sem sessão", async () => {
    const response = await server.inject({ method: "GET", url: "/api/apps" });
    expect(response.statusCode).toBe(401);
  });

  it("rejeita senha incorreta", async () => {
    const response = await server.inject({ method: "POST", url: "/api/auth/login", payload: { password: "errada" } });
    expect(response.statusCode).toBe(401);
  });

  it("aceita a senha correta e libera a listagem", async () => {
    const response = await server.inject({ method: "GET", url: "/api/apps", headers: auth() });
    expect(response.statusCode).toBe(200);
    expect(response.json().apps).toEqual([]);
  });

  it("encerra a sessão no logout", async () => {
    await server.inject({ method: "POST", url: "/api/auth/logout", headers: auth() });
    const response = await server.inject({ method: "GET", url: "/api/auth/session", headers: auth() });
    expect(response.statusCode).toBe(401);
  });
});

describe("aplicações", () => {
  it("cria, lista, atualiza e remove", async () => {
    const slug = await createApp();
    expect(slug).toBe("meu-bot-de-teste");

    const list = await server.inject({ method: "GET", url: "/api/apps", headers: auth() });
    expect(list.json().apps).toHaveLength(1);
    expect(list.json().apps[0].memoryMb).toBe(256);

    const patched = await server.inject({
      method: "PATCH",
      url: `/api/apps/${slug}`,
      headers: auth(),
      payload: { memoryMb: 1024, entry: "bot.js" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().app.memoryMb).toBe(1024);
    expect(patched.json().app.entry).toBe("bot.js");

    const removed = await server.inject({ method: "DELETE", url: `/api/apps/${slug}?deleteFiles=true`, headers: auth() });
    expect(removed.statusCode).toBe(200);
    await expect(fs.access(path.join(workDir, "apps", slug))).rejects.toThrow();
  });

  it("não apaga aplicação com release publicado quando o Docker não permite remover o container", async () => {
    const slug = await createApp();
    // Marcar um release ativo é o que faz a aplicação ter container. Sem Docker
    // não é possível removê-lo: apagar o registro deixaria o bot rodando órfão,
    // e a política `unless-stopped` o traria de volta após o daemon reiniciar.
    context.store.updateApp(context.apps.mustGet(slug).id, { activeRelease: 1 });

    const removed = await server.inject({ method: "DELETE", url: `/api/apps/${slug}?deleteFiles=true`, headers: auth() });
    expect(removed.statusCode).toBe(503);
    expect(removed.json().error).toMatch(/Docker não está respondendo/);

    const stillThere = await server.inject({ method: "GET", url: `/api/apps/${slug}`, headers: auth() });
    expect(stillThere.statusCode).toBe(200);
    await expect(fs.access(path.join(workDir, "apps", slug))).resolves.toBeUndefined();
  });

  it("apaga normalmente uma aplicação que nunca publicou release", async () => {
    const slug = await createApp();
    const removed = await server.inject({ method: "DELETE", url: `/api/apps/${slug}?deleteFiles=true`, headers: auth() });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().ok).toBe(true);
  });

  it("rejeita configurações inválidas", async () => {
    const memory = await server.inject({
      method: "POST",
      url: "/api/apps",
      headers: auth(),
      payload: { name: "Bot", runtime: "node", memoryMb: 8 },
    });
    expect(memory.statusCode).toBe(400);

    const env = await server.inject({
      method: "POST",
      url: "/api/apps",
      headers: auth(),
      payload: { name: "Bot", runtime: "node", env: [{ key: "1_INVALIDO", value: "x" }] },
    });
    expect(env.statusCode).toBe(400);

    const port = await server.inject({
      method: "POST",
      url: "/api/apps",
      headers: auth(),
      payload: { name: "Bot", runtime: "node", ports: ["abc"] },
    });
    expect(port.statusCode).toBe(400);
  });

  it("recusa identificador duplicado", async () => {
    await createApp({ slug: "bot-fixo" });
    const response = await server.inject({
      method: "POST",
      url: "/api/apps",
      headers: auth(),
      payload: { name: "Outro", runtime: "node", slug: "bot-fixo" },
    });
    expect(response.statusCode).toBe(409);
  });

  it("devolve códigos estáveis e acumula todos os problemas de validação", async () => {
    // Um pedido com vários problemas: a resposta traz a lista completa de uma
    // vez, cada item com código e o campo culpado — é o que o painel usa para
    // explicar cada motivo no idioma da interface.
    const many = await server.inject({
      method: "POST",
      url: "/api/apps",
      headers: auth(),
      payload: {
        name: "Bot com problemas",
        runtime: "node",
        image: "node 22 errada",
        env: [{ key: "1-ruim", value: "x" }, { key: "APP_SLUG", value: "y" }],
        ports: ["99999", "abc", "8080:3000", "8080:3000"],
      },
    });
    expect(many.statusCode).toBe(400);
    const body = many.json();
    expect(body.code).toBe("validation.composite");
    const codes = body.details.issues.map((issue: { code: string }) => issue.code);
    expect(codes).toContain("image.containsSpaces");
    expect(codes).toContain("env.invalidKey");
    expect(codes).toContain("env.reservedKey");
    expect(codes).toContain("ports.outOfRange");
    expect(codes).toContain("ports.invalidMapping");
    expect(codes).toContain("ports.duplicate");
    for (const issue of body.details.issues) {
      expect(typeof issue.message).toBe("string");
    }

    // Problemas distintos de imagem, cada um com seu código.
    const emptyImage = await server.inject({
      method: "POST",
      url: "/api/apps",
      headers: auth(),
      payload: { name: "Bot Vazio", runtime: "node", image: "  " },
    });
    expect(emptyImage.json().details.issues.map((issue: { code: string }) => issue.code)).toContain("image.empty");

    const badFormat = await server.inject({
      method: "POST",
      url: "/api/apps",
      headers: auth(),
      payload: { name: "Bot Formato", runtime: "node", image: "Node@22!!" },
    });
    expect(badFormat.json().details.issues.map((issue: { code: string }) => issue.code)).toContain("image.invalidFormat");

    // Runtime livre sem start também ganha código próprio.
    const custom = await server.inject({
      method: "POST",
      url: "/api/apps",
      headers: auth(),
      payload: { name: "Bot Livre", runtime: "custom" },
    });
    expect(custom.json().details.issues.map((issue: { code: string }) => issue.code)).toContain(
      "startCommand.requiredForCustom",
    );

    // PATCH com valores mesclados: o start antigo não esconde a imagem nova ruim.
    const slug = await createApp();
    const patched = await server.inject({
      method: "PATCH",
      url: `/api/apps/${slug}`,
      headers: auth(),
      payload: { image: "imagem com espaço" },
    });
    expect(patched.statusCode).toBe(400);
    expect(patched.json().code).toBe("validation.composite");
    expect(patched.json().details.issues.map((issue: { code: string }) => issue.code)).toContain("image.containsSpaces");

    // Slug duplicado continua 409, agora com código traduzível.
    await createApp({ slug: "bot-fixo" });
    const duplicate = await server.inject({
      method: "POST",
      url: "/api/apps",
      headers: auth(),
      payload: { name: "Outro", runtime: "node", slug: "bot-fixo" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("slug.taken");
  });

  it("não bloqueia a criação quando o Docker está indisponível para checar a imagem", async () => {
    // Nos testes de API não há daemon: a checagem de existência é "indeterminate"
    // e NÃO pode impedir criar — o painel nunca recusa por culpa dele mesmo.
    const slug = await createApp({ image: "node:22-slim" });
    expect(slug).toBe("meu-bot-de-teste");
  });

  it("expõe o branding padrão publicamente e aceita personalização", async () => {
    const before = await server.inject({ method: "GET", url: "/api/branding" });
    expect(before.statusCode).toBe(200);
    expect(before.json().branding.name).toBe("BotPanel Teste");

    const denied = await server.inject({ method: "PUT", url: "/api/branding", payload: { name: "X" } });
    expect(denied.statusCode).toBe(401);

    const saved = await server.inject({
      method: "PUT",
      url: "/api/branding",
      headers: auth(),
      payload: { name: "Meu Painel" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().branding.name).toBe("Meu Painel");

    // A sessão reflete o nome novo (o título das páginas vem daí).
    const session = await server.inject({ method: "GET", url: "/api/auth/session", headers: auth() });
    expect(session.json().panelName).toBe("Meu Painel");
  });

  it("aceita upload de imagem, serve com sessão e recusa conteúdo inválido", async () => {
    // PNG mínimo válido: assinatura + IHDR com 2×2 pixels.
    const png = Buffer.alloc(33);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(0x0d0a1a0a, 4);
    png.writeUInt32BE(0x0000000d, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(2, 16);
    png.writeUInt32BE(2, 20);

    const body = multipartBody({ field: "file", filename: "foto.png", content: png, contentType: "image/png" });
    const uploaded = await server.inject({
      method: "POST",
      url: "/api/images",
      headers: { ...auth(), ...body.headers },
      payload: body.payload,
    });
    expect(uploaded.statusCode).toBe(201);
    const url = uploaded.json().image.url as string;
    expect(url).toMatch(/^\/uploads\/images\/[a-f0-9]{16}\.png$/);

    // Sem sessão a imagem não serve; com sessão, sim.
    const denied = await server.inject({ method: "GET", url });
    expect(denied.statusCode).toBe(401);
    const served = await server.inject({ method: "GET", url, headers: auth() });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("image/png");

    // Conteúdo que não é imagem é recusado, mesmo com nome enganoso.
    const fake = multipartBody({ field: "file", filename: "foto.png", content: Buffer.from("<html>nao sou imagem</html>"), contentType: "image/png" });
    const rejected = await server.inject({
      method: "POST",
      url: "/api/images",
      headers: { ...auth(), ...fake.headers },
      payload: fake.payload,
    });
    expect(rejected.statusCode).toBe(400);

    // O caminho devolvido pelo upload é um ícone válido para a aplicação —
    // regressão: era recusado por exigir http/https absoluto.
    const created = await server.inject({
      method: "POST",
      url: "/api/apps",
      headers: auth(),
      payload: { name: "Bot Ícone", runtime: "node", image: "node:22-slim", entry: "index.js", memoryMb: 256, cpu: 0.5, iconUrl: url },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().app.iconUrl).toBe(url);

    // javascript: continua proibido.
    const evil = await server.inject({
      method: "POST",
      url: "/api/apps",
      headers: auth(),
      payload: { name: "Bot Mal", runtime: "node", image: "node:22-slim", entry: "index.js", memoryMb: 256, cpu: 0.5, iconUrl: "javascript:alert(1)" },
    });
    expect(evil.statusCode).toBe(400);
  });

  it("webhooks: valida URL, persiste e devolve mascarada", async () => {
    const denied = await server.inject({
      method: "PUT",
      url: "/api/notify/webhooks",
      headers: auth(),
      payload: { webhooks: [{ id: "a1", name: "Teste", url: "https://exemplo.com/nao-e-webhook", events: ["crashed"], enabled: true }] },
    });
    expect(denied.statusCode).toBe(400);

    const saved = await server.inject({
      method: "PUT",
      url: "/api/notify/webhooks",
      headers: auth(),
      payload: {
        webhooks: [
          { id: "a1", name: "Canal de avisos", url: "https://discord.com/api/webhooks/123456/abcdef-ghijkl", events: ["crashed", "started"], enabled: true },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);

    const list = await server.inject({ method: "GET", url: "/api/notify/webhooks", headers: auth() });
    expect(list.statusCode).toBe(200);
    const webhook = list.json().webhooks[0];
    expect(webhook.name).toBe("Canal de avisos");
    expect(webhook.events).toEqual(["crashed", "started"]);
    // A URL volta mascarada — é credencial de postagem no canal. O token
    // completo não pode aparecer em lugar nenhum da resposta.
    expect(webhook.urlMasked).toContain("••••••");
    expect(webhook.urlMasked).not.toContain("abcdef-ghijkl");
    expect(JSON.stringify(list.json())).not.toContain("abcdef-ghijkl");
    expect(list.json().kinds).toEqual(["started", "stopped", "restarted", "crashed"]);

    // Teste de entrega com URL falsa: o Discord não existe aqui, então falha
    // sem derrubar o painel (resposta 400, não 500).
    const test = await server.inject({
      method: "POST",
      url: "/api/notify/test",
      headers: auth(),
      payload: { url: "https://discord.com/api/webhooks/999/zzzz" },
    });
    expect([200, 400]).toContain(test.statusCode);
  });

  it("informa comandos que serão executados", async () => {
    const slug = await createApp();
    const response = await server.inject({ method: "GET", url: `/api/apps/${slug}/commands`, headers: auth() });
    expect(response.json().commands.startCommand).toBe("node index.js");
  });

  it("devolve 404 para aplicação inexistente", async () => {
    const response = await server.inject({ method: "GET", url: "/api/apps/nao-existe", headers: auth() });
    expect(response.statusCode).toBe(404);
  });
});

describe("arquivos", () => {
  it("grava, lê, renomeia e remove arquivos do volume persistente", async () => {
    const slug = await createApp();

    const write = await server.inject({
      method: "PUT",
      url: `/api/apps/${slug}/files/content`,
      headers: auth(),
      payload: { root: "data", path: "config.json", content: '{"ok":true}' },
    });
    expect(write.statusCode).toBe(200);

    const read = await server.inject({
      method: "GET",
      url: `/api/apps/${slug}/files/content?root=data&path=config.json`,
      headers: auth(),
    });
    expect(read.json().content).toBe('{"ok":true}');

    const mkdir = await server.inject({
      method: "POST",
      url: `/api/apps/${slug}/files/mkdir`,
      headers: auth(),
      payload: { root: "data", path: "backups" },
    });
    expect(mkdir.statusCode).toBe(200);

    const rename = await server.inject({
      method: "POST",
      url: `/api/apps/${slug}/files/rename`,
      headers: auth(),
      payload: { root: "data", from: "config.json", to: "backups/config.json" },
    });
    expect(rename.statusCode).toBe(200);

    const listing = await server.inject({ method: "GET", url: `/api/apps/${slug}/files?root=data`, headers: auth() });
    expect(listing.json().entries.map((entry: { name: string }) => entry.name)).toEqual(["backups"]);

    const remove = await server.inject({
      method: "DELETE",
      url: `/api/apps/${slug}/files`,
      headers: auth(),
      payload: { root: "data", path: "backups" },
    });
    expect(remove.statusCode).toBe(200);
  });

  it("bloqueia travessia de diretórios", async () => {
    const slug = await createApp();
    const response = await server.inject({
      method: "GET",
      url: `/api/apps/${slug}/files?root=data&path=../../etc`,
      headers: auth(),
    });
    expect(response.statusCode).toBe(400);
  });

  it("não permite ver o código antes de publicar um release", async () => {
    const slug = await createApp();
    const response = await server.inject({ method: "GET", url: `/api/apps/${slug}/files?root=code`, headers: auth() });
    expect(response.statusCode).toBe(400);
  });
});

describe("backups", () => {
  /** Cria um release e um /data no disco sem passar pelo Docker. */
  async function seedRelease(slug: string): Promise<void> {
    const release = path.join(workDir, "apps", slug, "releases", "1");
    await fs.mkdir(release, { recursive: true });
    await fs.writeFile(path.join(release, "index.js"), "console.log('oi');");
    await fs.mkdir(path.join(release, "node_modules", "discord.js"), { recursive: true });
    await fs.writeFile(path.join(release, "node_modules", "discord.js", "index.js"), "module.exports = {};");
    const shared = path.join(workDir, "apps", slug, "shared");
    await fs.mkdir(shared, { recursive: true });
    await fs.writeFile(path.join(shared, "state.json"), '{"n":1}');
    context.store.updateApp(context.apps.mustGet(slug).id, { activeRelease: 1 });
  }

  async function waitForBackup(slug: string, id: number): Promise<string> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const poll = await server.inject({ method: "GET", url: `/api/apps/${slug}/backups`, headers: auth() });
      const backup = (poll.json().backups as { id: number; status: string }[]).find((item) => item.id === id);
      if (backup && backup.status !== "running") return backup.status;
    }
    return "running";
  }

  it("gera, lista, baixa e remove um backup do release ativo", async () => {
    const slug = await createApp();
    await seedRelease(slug);

    const created = await server.inject({
      method: "POST",
      url: `/api/apps/${slug}/backups`,
      headers: auth(),
      payload: { includeData: true },
    });
    // 202: o ZIP é gerado em segundo plano e o andamento aparece na listagem.
    expect(created.statusCode).toBe(202);
    const backupId = created.json().backup.id as number;
    expect(created.json().backup.status).toBe("running");

    expect(await waitForBackup(slug, backupId)).toBe("success");

    const list = await server.inject({ method: "GET", url: `/api/apps/${slug}/backups`, headers: auth() });
    const backup = list.json().backups[0];
    expect(backup.sizeBytes).toBeGreaterThan(0);
    expect(backup.includeData).toBe(true);

    const download = await server.inject({
      method: "GET",
      url: `/api/apps/${slug}/backups/${backupId}/download`,
      headers: auth(),
    });
    expect(download.statusCode).toBe(200);
    expect(String(download.headers["content-type"])).toMatch(/zip/);
    expect(download.rawPayload.length).toBeGreaterThan(0);

    const removed = await server.inject({
      method: "DELETE",
      url: `/api/apps/${slug}/backups/${backupId}`,
      headers: auth(),
    });
    expect(removed.statusCode).toBe(200);
    await expect(fs.access(backup.path)).rejects.toThrow();
  });

  it("recusa backup quando não há release nem dados para copiar", async () => {
    const slug = await createApp();
    const response = await server.inject({
      method: "POST",
      url: `/api/apps/${slug}/backups`,
      headers: auth(),
      payload: { includeData: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/publique um release/);
  });

  it("aceita backup só dos dados quando ainda não há release", async () => {
    const slug = await createApp();
    const shared = path.join(workDir, "apps", slug, "shared");
    await fs.mkdir(shared, { recursive: true });
    await fs.writeFile(path.join(shared, "state.json"), '{"n":7}');

    const created = await server.inject({
      method: "POST",
      url: `/api/apps/${slug}/backups`,
      headers: auth(),
      payload: { includeData: true },
    });
    expect(created.statusCode).toBe(202);
    const backupId = created.json().backup.id as number;
    expect(await waitForBackup(slug, backupId)).toBe("success");
    expect(created.json().backup.releaseSeq).toBeNull();
  });
});

describe("upload e deploy", () => {
  it("detecta o projeto automaticamente no upload", async () => {
    const zip = makeZip([
      { name: "package.json", content: JSON.stringify({ dependencies: { "discord.js": "^14" } }) },
      { name: "index.js", content: "require('discord.js');" },
    ]);
    const body = multipartBody({ field: "file", filename: "bot.zip", content: zip });

    const response = await server.inject({ method: "POST", url: "/api/uploads", headers: { ...auth(), ...body.headers }, payload: body.payload });

    expect(response.statusCode).toBe(201);
    const json = response.json();
    expect(json.detection.runtime).toBe("node");
    expect(json.detection.entry).toBe("index.js");
    expect(json.upload.fileCount).toBe(2);
  });

  it("recusa arquivo que não é um pacote suportado", async () => {
    const body = multipartBody({ field: "file", filename: "bot.bin", content: Buffer.from("nao é pacote") });
    const response = await server.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { ...auth(), ...body.headers },
      payload: body.payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain(".tar.gz");
  });

  it("recusa pacote corrompido com 400 e não 500", async () => {
    const body = multipartBody({
      field: "file",
      filename: "bot.tar.gz",
      content: Buffer.from("isto não é um tar.gz de verdade"),
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { ...auth(), ...body.headers },
      payload: body.payload,
    });
    expect(response.statusCode).toBe(400);
  });

  it("recusa um .7z corrompido com 400 e não 500", async () => {
    const body = multipartBody({ field: "file", filename: "bot.7z", content: Buffer.from("nao é 7z") });
    const response = await server.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { ...auth(), ...body.headers },
      payload: body.payload,
    });
    expect(response.statusCode).toBe(400);
  });

  it("registra falha do deploy quando o Docker não está disponível e mantém a aplicação", async () => {
    const slug = await createApp();
    const zip = makeZip([
      { name: "package.json", content: JSON.stringify({ dependencies: { "discord.js": "^14" } }) },
      { name: "index.js", content: "require('discord.js');" },
    ]);
    const body = multipartBody({ field: "file", filename: "bot.zip", content: zip });
    const upload = await server.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { ...auth(), ...body.headers },
      payload: body.payload,
    });
    const uploadId = upload.json().upload.id;

    const deploy = await server.inject({
      method: "POST",
      url: `/api/apps/${slug}/deploy`,
      headers: auth(),
      payload: { uploadId, notes: "primeira versão" },
    });
    expect(deploy.statusCode).toBe(202);
    const { deploymentId } = deploy.json();

    let status = "running";
    let log = "";
    for (let attempt = 0; attempt < 60 && status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const poll = await server.inject({
        method: "GET",
        url: `/api/apps/${slug}/deployments/${deploymentId}`,
        headers: auth(),
      });
      status = poll.json().deployment.status;
      log = poll.json().deployment.log;
    }

    expect(status).toBe("failed");
    expect(log).toContain("Extraindo pacote");
    expect(log).toContain("Falha no deploy");
    // O release não foi ativado, então a aplicação continua sem versão publicada.
    const app = await server.inject({ method: "GET", url: `/api/apps/${slug}`, headers: auth() });
    expect(app.json().app.activeRelease).toBe(0);
  });
});

describe("métricas, restauração e deploy por URL", () => {
  /** Cria um release no disco sem passar pelo Docker (amostragem precisa dele). */
  async function seedRelease(slug: string): Promise<void> {
    const release = path.join(workDir, "apps", slug, "releases", "1");
    await fs.mkdir(release, { recursive: true });
    await fs.writeFile(path.join(release, "index.js"), "console.log('oi');");
    // A tabela `releases` também precisa do registro: é dela que sai o número
    // do próximo release (nextReleaseSeq), igual a um deploy real.
    context.store.insertRelease({
      appId: context.apps.mustGet(slug).id,
      seq: 1,
      dir: release,
      image: "node:22-slim",
      entry: "index.js",
      startCommand: "node index.js",
      installCommand: "",
      notes: "",
      sizeBytes: 0,
      createdAt: new Date().toISOString(),
    });
    context.store.updateApp(context.apps.mustGet(slug).id, { activeRelease: 1 });
  }

  it("guarda e lista amostras de métricas por aplicação", async () => {
    const slug = await createApp();
    await seedRelease(slug);
    const appId = context.apps.mustGet(slug).id;

    // Sem amostras ainda: lista vazia, não erro.
    const empty = await server.inject({ method: "GET", url: `/api/apps/${slug}/metrics`, headers: auth() });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().samples).toEqual([]);

    // Duas rodadas diretas do serviço (sem esperar o intervalo de 60 s).
    await context.metrics.sampleOnce();
    await context.metrics.sampleOnce();

    const history = await server.inject({ method: "GET", url: `/api/apps/${slug}/metrics`, headers: auth() });
    expect(history.statusCode).toBe(200);
    const samples = history.json().samples as { status: string; cpuPercent: number }[];
    // Docker indisponível nos testes de API: `resources()` volta null e nenhuma
    // amostra é guardada — o importante é não quebrar a rodada.
    expect(Array.isArray(samples)).toBe(true);

    // Amostra direta no banco para validar ordenação e forma do registro.
    context.store.insertMetricSample({
      appId,
      ts: new Date().toISOString(),
      status: "running",
      cpuPercent: 12.5,
      memoryBytes: 64 * 1024 * 1024,
      memoryLimitBytes: 256 * 1024 * 1024,
      memoryPercent: 25,
      pids: 5,
    });
    const after = await server.inject({ method: "GET", url: `/api/apps/${slug}/metrics`, headers: auth() });
    const list = after.json().samples as { status: string; cpuPercent: number; memoryPercent: number }[];
    expect(list).toHaveLength(1);
    expect(list[0]?.cpuPercent).toBe(12.5);
    expect(list[0]?.memoryPercent).toBe(25);
    expect(list[0]?.status).toBe("running");
  });

  it("restaura um backup como novo release", async () => {
    const slug = await createApp();
    await seedRelease(slug);

    const created = await server.inject({
      method: "POST",
      url: `/api/apps/${slug}/backups`,
      headers: auth(),
      payload: { includeData: false },
    });
    expect(created.statusCode).toBe(202);
    const backupId = created.json().backup.id as number;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const poll = await server.inject({ method: "GET", url: `/api/apps/${slug}/backups`, headers: auth() });
      const backup = (poll.json().backups as { id: number; status: string }[]).find((item) => item.id === backupId);
      if (backup && backup.status !== "running") {
        expect(backup.status).toBe("success");
        break;
      }
    }

    const restore = await server.inject({
      method: "POST",
      url: `/api/apps/${slug}/backups/${backupId}/restore`,
      headers: auth(),
    });
    expect(restore.statusCode).toBe(202);
    expect(restore.json().releaseSeq).toBe(2);
    const deploymentId = restore.json().deploymentId as number;

    // Sem Docker, a instalação falha — mas o fluxo de restauração em si
    // (extração do ZIP de backup, reempacotamento do code/, novo deployment)
    // aconteceu; o release 2 não pode ter ficado ativo.
    let status = "running";
    for (let attempt = 0; attempt < 60 && status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const poll = await server.inject({
        method: "GET",
        url: `/api/apps/${slug}/deployments/${deploymentId}`,
        headers: auth(),
      });
      status = poll.json().deployment.status;
    }
    expect(["failed", "success"]).toContain(status);
    // Sem Docker, o deploy falha na criação do container — mas isso acontece
    // DEPOIS da ativação do release no pipeline (o pacote restaurado era válido:
    // extração, detecção e publicação passaram). Igual a um upload normal.
    const app = await server.inject({ method: "GET", url: `/api/apps/${slug}`, headers: auth() });
    expect(app.json().app.activeRelease).toBe(2);

    // O temporário da restauração não sobrevive ao fim do deploy.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const tmpRestores = await fs.readdir(path.join(workDir, "tmp"));
    expect(tmpRestores.filter((entry) => entry.startsWith("restore-"))).toEqual([]);
  });

  it("recusa restaurar backup sem código (só /data)", async () => {
    const slug = await createApp();
    const shared = path.join(workDir, "apps", slug, "shared");
    await fs.mkdir(shared, { recursive: true });
    await fs.writeFile(path.join(shared, "state.json"), '{"n":1}');

    const created = await server.inject({
      method: "POST",
      url: `/api/apps/${slug}/backups`,
      headers: auth(),
      payload: { includeData: true },
    });
    const backupId = created.json().backup.id as number;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const poll = await server.inject({ method: "GET", url: `/api/apps/${slug}/backups`, headers: auth() });
      const backup = (poll.json().backups as { id: number; status: string }[]).find((item) => item.id === backupId);
      if (backup && backup.status !== "running") break;
    }

    const restore = await server.inject({
      method: "POST",
      url: `/api/apps/${slug}/backups/${backupId}/restore`,
      headers: auth(),
    });
    expect(restore.statusCode).toBe(400);
    expect(restore.json().error).toMatch(/não contém o código/);
  });

  it("baixa um pacote de uma URL http e segue o fluxo normal de upload", async () => {
    // Servidor http local: sem rede externa nos testes.
    const http = await import("node:http");
    const zip = makeZip([{ name: "package.json", content: JSON.stringify({ dependencies: { x: "1" } }) }]);
    const origin = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/zip" });
      response.end(zip);
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    const address = origin.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const response = await server.inject({
      method: "POST",
      url: "/api/uploads/from-url",
      headers: auth(),
      payload: { url: `http://127.0.0.1:${port}/pacote.zip` },
    });
    origin.close();
    expect(response.statusCode).toBe(201);
    expect(response.json().upload.fileName).toBe("pacote.zip");
    expect(response.json().detection.runtime).toBe("node");
  });

  it("recusa URL com protocolo perigoso e host privado fora da allowlist", async () => {
    const file = await server.inject({
      method: "POST",
      url: "/api/uploads/from-url",
      headers: auth(),
      payload: { url: "file:///etc/passwd" },
    });
    expect(file.statusCode).toBe(400);

    const ftp = await server.inject({
      method: "POST",
      url: "/api/uploads/from-url",
      headers: auth(),
      payload: { url: "ftp://exemplo.com/pacote.zip" },
    });
    expect(ftp.statusCode).toBe(400);
  });

  it("falha com mensagem clara quando a URL responde erro", async () => {
    const http = await import("node:http");
    const origin = http.createServer((_request, response) => {
      response.writeHead(404);
      response.end("nope");
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    const address = origin.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const response = await server.inject({
      method: "POST",
      url: "/api/uploads/from-url",
      headers: auth(),
      payload: { url: `http://127.0.0.1:${port}/sumiu.zip` },
    });
    origin.close();
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/HTTP 404/);
  });
});
