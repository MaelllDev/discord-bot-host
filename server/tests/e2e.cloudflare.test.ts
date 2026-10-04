/**
 * E2E da integração do Cloudflare Tunnel com Docker real.
 *
 * Exercita o ciclo completo contra um daemon de verdade: pull da imagem, criação
 * do container `botpanel-cloudflared`, labels, política `unless-stopped`, ausência
 * de portas publicadas, redaction do token nas respostas da API e limpeza.
 *
 * Segurança do próprio teste:
 *  - usa um TOKEN FICTÍCIO (não há credencial real em lugar nenhum);
 *  - roda com um diretório de dados temporário, então o `botpanel.instance` do
 *    container criado é diferente do painel de produção;
 *  - nunca toca em containers que não tenham as labels desta integração;
 *  - se já existir um `botpanel-cloudflared` no daemon, a suíte inteira é
 *    IGNORADA em vez de arriscar mexer no container de outra instalação.
 *
 * Como rodar (precisa de Docker e root):
 *
 *   BOTPANEL_E2E=1 npm run test:e2e
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.ts";
import type { AppContext } from "../src/context.ts";
import { readConfig } from "../src/cloudflare/config.ts";
import { testConfig } from "./helpers/config.ts";

const execFileAsync = promisify(execFile);

const DOCKER_SOCKET = "/var/run/docker.sock";
const CONTAINER = "botpanel-cloudflared";
const COMPONENT_LABEL = "cloudflare-tunnel";
/** Token fictício, no formato do Cloudflare (base64). Nenhuma credencial real. */
const TOKEN = "eyJhIjoiZmFrZS10dW5uZWwtdG9rZW4tZG8tZTJlLWRvLWJvdHBhbmVsIn0=";

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  return stdout.trim();
}

async function containerId(name: string): Promise<string | null> {
  try {
    return await docker(["inspect", name, "--format", "{{.Id}}"]);
  } catch {
    return null;
  }
}

async function enabledAndAvailable(): Promise<boolean> {
  if (process.env["BOTPANEL_E2E"] !== "1") return false;
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]);
  } catch {
    return false;
  }
  // Container de outra instalação com o mesmo nome: não mexer nele.
  return (await containerId(CONTAINER)) === null;
}

const suite = (await enabledAndAvailable()) ? describe : describe.skip;

let workDir: string;
let server: FastifyInstance;
let context: AppContext;
let cookie: string;
/** Containers que já existiam antes da suíte (todos devem seguir intactos). */
let containersBefore: string[] = [];

beforeAll(async () => {
  containersBefore = (await docker(["ps", "-a", "--format", "{{.Names}}"])).split("\n").filter(Boolean);
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "botpanel-e2e-cloudflare-"));
  const built = await buildServer(testConfig(workDir, { dockerSocket: DOCKER_SOCKET }));
  server = built.server;
  context = built.context;
  await server.ready();

  const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { password: "senha-de-teste" } });
  const raw = login.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) throw new Error("login não devolveu cookie");
  cookie = header.split(";")[0] ?? "";
}, 120_000);

afterEach(async () => {
  // Entre um teste e outro o container nunca deve sobrar.
  const id = await containerId(CONTAINER);
  if (!id) return;
  const component = await docker(["inspect", CONTAINER, "--format", '{{index .Config.Labels "botpanel.component"}}']);
  // Só remove o que é comprovadamente desta integração.
  if (component === COMPONENT_LABEL) await docker(["rm", "-f", CONTAINER]);
});

afterAll(async () => {
  if (server) await server.close();
  context?.store.close();
  if (workDir) await fs.rm(workDir, { recursive: true, force: true });
  await fs.rm("/tmp/bp-e2e-cloudflare-logs.txt", { force: true }).catch(() => undefined);
}, 120_000);

const auth = (): Record<string, string> => ({ cookie });

suite("cloudflare tunnel (docker real)", () => {
  it("cria o container com a imagem, as labels e a política exigidas", async () => {
    const saved = await server.inject({
      method: "PUT",
      url: "/api/cloudflare",
      headers: auth(),
      payload: { token: TOKEN, enabled: true },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(TOKEN);

    const connected = await server.inject({ method: "POST", url: "/api/cloudflare/connect", headers: auth() });
    expect(connected.statusCode).toBe(200);
    expect(connected.body).not.toContain(TOKEN);

    // O container existe de verdade e é do painel.
    const id = await containerId(CONTAINER);
    expect(id).toBeTruthy();

    const labels = JSON.parse(
      await docker(["inspect", CONTAINER, "--format", "{{json .Config.Labels}}"]),
    ) as Record<string, string>;
    expect(labels["botpanel.managed"]).toBe("1");
    expect(labels["botpanel.component"]).toBe(COMPONENT_LABEL);
    expect(labels["botpanel.instance"]).toBe(context.config.instanceId);
    // Não pode ser confundido com uma aplicação do usuário.
    expect(labels["botpanel.app"]).toBeUndefined();

    const image = await docker(["inspect", CONTAINER, "--format", "{{.Config.Image}}"]);
    expect(image).toBe("cloudflare/cloudflared:latest");

    const restart = await docker(["inspect", CONTAINER, "--format", "{{.HostConfig.RestartPolicy.Name}}"]);
    expect(restart).toBe("unless-stopped");

    // O túnel é outbound: nenhuma porta publicada, nenhuma porta no host.
    const ports = JSON.parse(await docker(["inspect", CONTAINER, "--format", "{{json .NetworkSettings.Ports}}"])) as
      | Record<string, unknown>
      | null;
    expect(ports === null || Object.keys(ports).length === 0).toBe(true);

    // O comando é exatamente o usado à mão — com o token, que NÃO vaza na API.
    const cmd = JSON.parse(await docker(["inspect", CONTAINER, "--format", "{{json .Config.Cmd}}"])) as string[];
    expect(cmd).toEqual(["tunnel", "--no-autoupdate", "run", "--token", TOKEN]);

    // O container está no ar (o token fake não conecta, mas o processo roda).
    const status = await docker(["inspect", CONTAINER, "--format", "{{.State.Status}}"]);
    expect(["running", "restarting", "exited"]).toContain(status);
  }, 240_000);

  it("a API não devolve o token e reconhece a conexão como inválida", async () => {
    await server.inject({
      method: "PUT",
      url: "/api/cloudflare",
      headers: auth(),
      payload: { token: TOKEN, enabled: true },
    });
    await server.inject({ method: "POST", url: "/api/cloudflare/connect", headers: auth() });

    const state = await server.inject({ method: "GET", url: "/api/cloudflare", headers: auth() });
    expect(state.statusCode).toBe(200);
    expect(state.body).not.toContain(TOKEN);

    const tunnel = state.json().tunnel as Record<string, unknown>;
    expect(tunnel["tokenSet"]).toBe(true);
    expect(tunnel["dockerAvailable"]).toBe(true);
    expect(tunnel["containerStatus"]).not.toBeNull();
    // Com um token fictício, o cloudflared não registra conexão: o painel não
    // pode afirmar "conectado" só porque o container está de pé.
    expect(tunnel["state"]).not.toBe("connected");

    // Os logs de diagnóstico continuam disponíveis para o usuário.
    const logs = await server.inject({ method: "GET", url: "/api/cloudflare/logs?lines=40", headers: auth() });
    expect(logs.statusCode).toBe(200);
    expect(logs.body).not.toContain(TOKEN);
  }, 240_000);

  it("desconecta mantendo a configuração e remove tudo no fim", async () => {
    await server.inject({
      method: "PUT",
      url: "/api/cloudflare",
      headers: auth(),
      payload: { token: TOKEN, enabled: true },
    });
    await server.inject({ method: "POST", url: "/api/cloudflare/connect", headers: auth() });

    const disconnected = await server.inject({ method: "POST", url: "/api/cloudflare/disconnect", headers: auth() });
    expect(disconnected.statusCode).toBe(200);
    expect((disconnected.json().tunnel as Record<string, unknown>)["enabled"]).toBe(false);
    // Desconectar não apaga o segredo nem o container.
    expect(readConfig(context.store).token).toBe(TOKEN);
    expect(await containerId(CONTAINER)).toBeTruthy();

    const removed = await server.inject({ method: "DELETE", url: "/api/cloudflare", headers: auth() });
    expect(removed.statusCode).toBe(200);
    expect(readConfig(context.store).token).toBe("");
    expect(await containerId(CONTAINER)).toBeNull();
  }, 240_000);

  it("reconcilia no boot: habilitado sobe, desconectado não ressuscita", async () => {
    await server.inject({
      method: "PUT",
      url: "/api/cloudflare",
      headers: auth(),
      payload: { token: TOKEN, enabled: true },
    });
    await context.cloudflare.reconcileOnStartup();
    expect(await containerId(CONTAINER)).toBeTruthy();

    // Uma segunda reconciliação não cria duplicata (o nome é fixo, então a
    // prova é o container seguir sendo o mesmo id).
    const firstId = await containerId(CONTAINER);
    await context.cloudflare.reconcileOnStartup();
    expect(await containerId(CONTAINER)).toBe(firstId);

    // Desconectado: o boot do painel não traz o túnel de volta.
    await server.inject({ method: "POST", url: "/api/cloudflare/disconnect", headers: auth() });
    await context.cloudflare.reconcileOnStartup();
    const status = await docker(["inspect", CONTAINER, "--format", "{{.State.Status}}"]);
    expect(status).not.toBe("running");
  }, 240_000);

  it("não afetou nenhum container que já existia", async () => {
    const now = (await docker(["ps", "-a", "--format", "{{.Names}}"])).split("\n").filter(Boolean);
    for (const name of containersBefore) {
      expect({ name, present: now.includes(name) }).toEqual({ name, present: true });
    }
  }, 60_000);
});
