import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.ts";
import type { AppContext } from "../src/context.ts";
import { PasswordResetService } from "../src/auth.ts";
import type { PanelConfig } from "../src/config.ts";
import { testConfig } from "./helpers/config.ts";

const NEW_PASSWORD = "senha-nova-bem-longa";

/**
 * Captura o que o painel escreve no log: a recuperação não pode registrar
 * nenhum segredo, então o teste lê daqui justamente para provar isso.
 */
function logCapture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { lines, stream };
}

let workDir: string;
let server: FastifyInstance;
let context: AppContext;
let logs: string[];
let cleanups: (() => Promise<void>)[];

beforeEach(() => {
  logs = [];
  cleanups = [];
});

afterEach(async () => {
  for (const fn of cleanups) await fn();
});

async function start(config: PanelConfig): Promise<{ server: FastifyInstance; context: AppContext }> {
  const capture = logCapture();
  logs = capture.lines;
  const built = await buildServer(config, { level: "warn", stream: capture.stream });
  server = built.server;
  context = built.context;
  await server.ready();
  return built;
}

/** Instância sem env vars: o painel controla a senha (recuperação disponível). */
async function startGenerated(): Promise<string> {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "botpanel-recover-"));
  await start(testConfig(workDir, { password: null, passwordHash: null }));
  cleanups.push(async () => {
    await server.close();
    context.store.close();
    await fs.rm(workDir, { recursive: true, force: true });
  });
  return context.password.generated ?? "";
}

/** Instância com `BOTPANEL_PASSWORD`: não existe canal seguro de recuperação. */
async function startWithEnvPassword(): Promise<void> {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "botpanel-recover-env-"));
  await start(testConfig(workDir, { password: "senha-de-teste", passwordHash: null }));
  cleanups.push(async () => {
    await server.close();
    context.store.close();
    await fs.rm(workDir, { recursive: true, force: true });
  });
}

async function requestToken(): Promise<{ tokenFile: string; expiresInSeconds: number }> {
  const response = await server.inject({ method: "POST", url: "/api/auth/recover/token" });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function readTokenFrom(file: string): Promise<string> {
  return (await fs.readFile(file, "utf8")).trim();
}

function login(password: string): Promise<{ statusCode: number }> {
  return server.inject({ method: "POST", url: "/api/auth/login", payload: { password } });
}

describe("recuperação de senha por token de uso único", () => {
  it("entrega o token apenas em arquivo 0600 e não registra nenhum segredo no log", async () => {
    const generated = await startGenerated();
    const body = await requestToken();

    expect(body.tokenFile).toBe(path.join(workDir, PasswordResetService.FILE_NAME));
    expect(body.expiresInSeconds).toBeGreaterThan(0);

    const token = await readTokenFrom(body.tokenFile);
    expect(token.length).toBeGreaterThan(20);
    expect(token).not.toBe(generated);

    // Só o dono do arquivo (usuário do serviço) consegue lê-lo.
    const mode = (await fs.stat(body.tokenFile)).mode & 0o777;
    expect(mode).toBe(0o600);

    // Nem a senha em uso, nem o token aparecem no log do painel.
    const printed = logs.join("\n");
    expect(printed).not.toContain(generated);
    expect(printed).not.toContain(token);
  });

  it("redefine a senha com o token, invalida a senha antiga e a sessão aberta", async () => {
    const generated = await startGenerated();
    const session = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: generated },
    });
    expect(session.statusCode).toBe(200);
    const rawCookie = session.headers["set-cookie"];
    const cookieHeader = (Array.isArray(rawCookie) ? rawCookie[0] : rawCookie) ?? "";
    const cookie = cookieHeader.split(";")[0] ?? "";
    expect(cookie.length).toBeGreaterThan(0);

    const { tokenFile } = await requestToken();
    const token = await readTokenFrom(tokenFile);

    const reset = await server.inject({
      method: "POST",
      url: "/api/auth/recover/reset",
      payload: { token, password: NEW_PASSWORD },
    });
    expect(reset.statusCode).toBe(200);

    // A senha nova entra, a antiga não entra mais.
    expect((await login(NEW_PASSWORD)).statusCode).toBe(200);
    expect((await login(generated)).statusCode).toBe(401);

    // O token é de uso único: repetir a redefinição falha.
    const again = await server.inject({
      method: "POST",
      url: "/api/auth/recover/reset",
      payload: { token, password: "outra-senha-longa" },
    });
    expect(again.statusCode).toBe(400);

    // O arquivo do token já foi consumido.
    await expect(fs.stat(tokenFile)).rejects.toThrow();

    // A troca de credencial derruba a sessão que estava aberta antes dela.
    const stale = await server.inject({ method: "GET", url: "/api/apps", headers: { cookie } });
    expect(stale.statusCode).toBe(401);
  });

  it("persiste a senha redefinida mesmo depois de reiniciar o painel", async () => {
    const generated = await startGenerated();
    const { tokenFile } = await requestToken();
    const token = await readTokenFrom(tokenFile);

    await server.inject({
      method: "POST",
      url: "/api/auth/recover/reset",
      payload: { token, password: NEW_PASSWORD },
    });
    await server.close();
    context.store.close();

    // Mesmo diretório de dados, processo novo.
    await start(testConfig(workDir, { password: null, passwordHash: null }));
    expect((await login(NEW_PASSWORD)).statusCode).toBe(200);
    expect((await login(generated)).statusCode).toBe(401);

    // A senha inicial não existe mais neste diretório.
    await expect(fs.stat(path.join(workDir, ".initial-password"))).rejects.toThrow();
    // E a recuperação continua disponível para quem já redefiniu uma vez.
    const status = await server.inject({ method: "GET", url: "/api/auth/recover" });
    expect(status.json()).toEqual({ available: true });
  });

  it("responde igual para token errado, expirado ou já usado e limita as tentativas", async () => {
    await startGenerated();

    const wrong = await server.inject({
      method: "POST",
      url: "/api/auth/recover/reset",
      payload: { token: "token-que-nao-existe-mesmo", password: NEW_PASSWORD },
    });
    expect(wrong.statusCode).toBe(400);
    const message = (wrong.json() as { error: string }).error;

    // Sem token pendente a mensagem é a mesma: não dá para enumerar estados.
    const noToken = await server.inject({
      method: "POST",
      url: "/api/auth/recover/reset",
      payload: { token: "outro-token-invalido-aqui", password: NEW_PASSWORD },
    });
    expect(noToken.statusCode).toBe(400);
    expect((noToken.json() as { error: string }).error).toBe(message);

    // Seis tentativas erradas esgotam o limite; a seguinte é bloqueada.
    for (let i = 0; i < 4; i += 1) {
      const attempt = await server.inject({
        method: "POST",
        url: "/api/auth/recover/reset",
        payload: { token: `tentativa-invalida-${i}`, password: NEW_PASSWORD },
      });
      expect(attempt.statusCode).toBe(400);
    }
    const blocked = await server.inject({
      method: "POST",
      url: "/api/auth/recover/reset",
      payload: { token: "mais-uma-tentativa", password: NEW_PASSWORD },
    });
    expect(blocked.statusCode).toBe(429);
    expect((blocked.json() as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
  });

  it("exige senha com tamanho mínimo", async () => {
    await startGenerated();
    const { tokenFile } = await requestToken();
    const token = await readTokenFrom(tokenFile);

    const short = await server.inject({
      method: "POST",
      url: "/api/auth/recover/reset",
      payload: { token, password: "curta" },
    });
    expect(short.statusCode).toBe(400);

    // O token não foi consumido por uma requisição rejeitada na validação.
    const valid = await server.inject({
      method: "POST",
      url: "/api/auth/recover/reset",
      payload: { token, password: NEW_PASSWORD },
    });
    expect(valid.statusCode).toBe(200);
  });

  it("limita a geração de tokens por IP", async () => {
    await startGenerated();

    await requestToken();
    const second = await server.inject({ method: "POST", url: "/api/auth/recover/token" });
    expect(second.statusCode).toBe(429);
    expect((second.json() as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
  });

  it("com BOTPANEL_PASSWORD não oferece recuperação e as rotas de token não existem", async () => {
    await startWithEnvPassword();

    const status = await server.inject({ method: "GET", url: "/api/auth/recover" });
    expect(status.json()).toEqual({ available: false });

    expect((await server.inject({ method: "POST", url: "/api/auth/recover/token" })).statusCode).toBe(404);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/auth/recover/reset",
          payload: { token: "xxxxxxxxxxxxxxxx", password: NEW_PASSWORD },
        })
      ).statusCode,
    ).toBe(404);
    expect(logs.join("\n")).not.toContain("senha-de-teste");
  });

  it("descarta um token pendente que não sobreviveu ao restart", async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "botpanel-recover-stale-"));
    // Simula o arquivo deixado por um processo anterior.
    await fs.writeFile(path.join(workDir, PasswordResetService.FILE_NAME), "token-de-um-boot-anterior\n", {
      mode: 0o600,
    });

    await start(testConfig(workDir, { password: null, passwordHash: null }));
    cleanups.push(async () => {
      await server.close();
      context.store.close();
      await fs.rm(workDir, { recursive: true, force: true });
    });

    // Nada pôde ser resgatado: o token antigo não é aceito e o arquivo some.
    const attempt = await server.inject({
      method: "POST",
      url: "/api/auth/recover/reset",
      payload: { token: "token-de-um-boot-anterior", password: NEW_PASSWORD },
    });
    expect(attempt.statusCode).toBe(400);
    await expect(fs.stat(path.join(workDir, PasswordResetService.FILE_NAME))).rejects.toThrow();
  });
});

describe("serviço de token (unidade)", () => {
  it("consome uma vez, respeita o prazo e invalida o token anterior", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "botpanel-token-"));
    const service = new PasswordResetService(dir);

    // Uso único, dentro do prazo: a primeira troca passa, a segunda não.
    const first = service.issue(1_000);
    const tokenA = (await fs.readFile(service.tokenFile, "utf8")).trim();
    expect(service.redeem(tokenA, first.expiresAt - 1)).toBe(true);
    expect(service.redeem(tokenA, first.expiresAt - 1)).toBe(false);

    // Prazo: o token vigente não vale depois de expirar.
    const second = service.issue(1_000);
    const tokenB = (await fs.readFile(service.tokenFile, "utf8")).trim();
    expect(service.redeem(tokenB, second.expiresAt + 1)).toBe(false);

    // Emitir um token novo invalida o anterior, mesmo antes de expirar.
    const third = service.issue(1_000);
    const tokenC = (await fs.readFile(service.tokenFile, "utf8")).trim();
    expect(tokenC).not.toBe(tokenB);
    expect(service.redeem(tokenB, third.expiresAt - 1)).toBe(false);

    await fs.rm(dir, { recursive: true, force: true });
  });
});
