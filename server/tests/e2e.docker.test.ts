/**
 * Testes end-to-end com Docker real.
 *
 * Valida o ciclo de vida completo: criação do container, instalação de
 * dependências Node.js, execução, limites de RAM/CPU/PIDs, isolamento entre
 * aplicações, logs em tempo real, console (stdin), persistência de /data,
 * atualização, rollback, comportamento após reiniciar o Docker e limpeza.
 *
 * Como rodar (precisa de Docker acessível e permissão de root):
 *
 *   BOTPANEL_E2E=1 npm run test:e2e
 *   BOTPANEL_E2E=1 BOTPANEL_E2E_DOCKER_RESTART=1 npm run test:e2e   # inclui o restart do daemon
 *
 * Sem BOTPANEL_E2E=1 a suíte é ignorada, para que `npm test` continue rápido.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.ts";
import type { AppContext } from "../src/context.ts";
import { Store } from "../src/db.ts";
import { DockerService } from "../src/docker/service.ts";
import { AppService } from "../src/apps/service.ts";
import { instanceIdForDataDir } from "../src/config.ts";
import { CONTAINER_PYTHON_PACKAGES } from "../src/apps/paths.ts";
import { makeZip } from "./helpers/zip.ts";
import { testConfig } from "./helpers/config.ts";

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

const dockerPath = "/var/run/docker.sock";

interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

/** A suíte só roda com BOTPANEL_E2E=1 e um daemon Docker acessível. */
async function dockerAvailable(): Promise<boolean> {
  if (process.env["BOTPANEL_E2E"] !== "1") return false;
  try {
    await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

// Os testes deste arquivo rodam em sequência (compartilham o mesmo daemon).
const suite = (await dockerAvailable()) ? describe : describe.skip;

// ---------------------------------------------------------------- fixtures

/** Bot A v1: dependência real (discord.js), heartbeat e comandos de estresse. */
const BOT_A_V1 = `
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const VERSION = "1.0.0";
const dataDir = process.env.DATA_DIR || "/data";
const stateFile = path.join(dataDir, "state.json");

let discordClient = "indefinido";
let discordVersion = "ausente";
try {
  const discord = require("discord.js");
  discordClient = typeof discord.Client;
  discordVersion = discord.version || "?";
} catch (error) {
  console.error("[bot] FALHA discord.js: " + error.message);
}

let state = { boots: 0 };
try { state = Object.assign(state, JSON.parse(fs.readFileSync(stateFile, "utf8"))); } catch {}
state.boots = (state.boots || 0) + 1;
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

console.log("[bot] versao=" + VERSION + " pid=" + process.pid + " boots=" + state.boots);
console.log("[bot] discord.js=" + discordVersion + " Client=" + discordClient);
console.log("[bot] env E2E_MARKER=" + process.env.E2E_MARKER);
console.log("[BOTREADY] version=" + VERSION + " boots=" + state.boots);

setInterval(function () {
  console.log("[heartbeat] " + new Date().toISOString() + " ram=" + (process.memoryUsage().rss / 1048576).toFixed(1) + "MB v=" + VERSION);
}, 2000);

let held = [];
const kids = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (chunk) {
  chunk.toString().split("\\n").forEach(function (raw) {
    const line = raw.trim();
    if (!line) return;
    console.log("[cmd] recebido: " + line);
    const parts = line.split(/\\s+/);
    const name = parts[0];
    const arg = parts[1];
    if (name === "ping") console.log("[cmd] pong");
    else if (name === "version") console.log("[cmd] versao=" + VERSION);
    else if (name === "state") console.log("[cmd] state=" + JSON.stringify(state));
    else if (name === "mem") { held = Buffer.alloc(Number(arg || 100) * 1048576, 7); console.log("[cmd] alocado " + arg + "MB"); }
    else if (name === "cpu") {
      const end = Date.now() + Math.min(Number(arg || 5), 60) * 1000;
      let spins = 0;
      while (Date.now() < end) spins += Math.sqrt(spins + 1);
      console.log("[cmd] burn concluido");
    }
    else if (name === "procs") {
      const count = Math.min(Number(arg || 50), 2000);
      for (let i = 0; i < count; i += 1) {
        try {
          const child = spawn("sleep", ["60"], { stdio: "ignore" });
          child.on("error", function () {});
          kids.push(child);
        } catch {}
      }
      console.log("[cmd] procs solicitados=" + count);
    }
    else if (name === "killprocs") {
      const total = kids.length;
      kids.forEach(function (child) { try { child.kill("SIGKILL"); } catch {} });
      kids.length = 0;
      console.log("[cmd] filhos encerrados=" + total);
    }
    else if (name === "listen") {
      if (!global.__srv) global.__srv = require("node:http").createServer(function (_q, r) { r.end("bot-a"); }).listen(Number(arg || 3999), "0.0.0.0", function () { console.log("[cmd] ouvindo em " + arg); });
      else console.log("[cmd] ja ouvindo");
    }
    else console.log("[cmd] desconhecido: " + name);
  });
});
process.stdin.resume();
`;

/** Bot A v2: nova dependência (dotenv), novo comando e marcador de versão. */
const BOT_A_V2 = BOT_A_V1
  .replace('const VERSION = "1.0.0";', 'const VERSION = "2.0.0";')
  .replace(
    'console.log("[bot] discord.js=" + discordVersion + " Client=" + discordClient);',
    'console.log("[bot] discord.js=" + discordVersion + " Client=" + discordClient + " dotenv=" + (function () { try { return typeof require("dotenv").config; } catch (e) { return "ausente"; } })());',
  )
  .replace(
    'else if (name === "version") console.log("[cmd] versao=" + VERSION);',
    'else if (name === "version") console.log("[cmd] versao=" + VERSION);\n    else if (name === "novidade") console.log("[cmd] comando exclusivo da v2 funcionando");',
  );

/** Bot B: sem dependências, com sondagens de isolamento. */
const BOT_B = `
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");

const dataDir = process.env.DATA_DIR || "/data";
fs.writeFileSync(path.join(dataDir, "marker-b.txt"), "botB pid=" + process.pid + "\\n");
console.log("[botB] iniciado pid=" + process.pid);

// HOST_DATA_DIR é injetado pelo painel: mesmo sabendo o caminho exato no host,
// a aplicação B não pode tocar nos arquivos da aplicação A.
const hostDir = process.env.HOST_DATA_DIR || "/var/lib/botpanel";
const targets = [
  hostDir + "/apps/e2e-bot-a/shared/state.json",
  hostDir + "/apps/e2e-bot-a/releases",
  hostDir + "/botpanel.db",
  path.join(dataDir, "..", "e2e-bot-a", "shared", "state.json"),
  "/data/state.json"
];
targets.forEach(function (target) {
  try { fs.readFileSync(target); console.log("[ISOLAMENTO] ler " + target + " -> ACESSIVEL (FALHA)"); }
  catch (error) { console.log("[ISOLAMENTO] ler " + target + " -> bloqueado (" + error.code + ")"); }
});
console.log("[ISOLAMENTO] /data contem: " + (fs.readdirSync("/data").join(",") || "(vazio)"));
console.log("[ISOLAMENTO] processos visiveis: " + fs.readdirSync("/proc").filter(function (n) { return /^[0-9]+$/.test(n); }).length);
console.log("[botB] env E2E_MARKER=" + process.env.E2E_MARKER);

setInterval(function () { console.log("[botB] heartbeat"); }, 2000);

process.stdin.setEncoding("utf8");
process.stdin.on("data", function (chunk) {
  chunk.toString().split("\\n").forEach(function (raw) {
    const line = raw.trim();
    if (!line) return;
    console.log("[botB] cmd recebido: " + line);
    const parts = line.split(/\\s+/);
    if (parts[0] === "probe") {
      const host = (parts[1] || "").split(":")[0];
      const port = Number((parts[1] || "").split(":")[1]);
      const socket = net.connect({ host: host, port: port }, function () {
        console.log("[NET] alcancou " + host + ":" + port + " (SEM isolamento de rede)");
        socket.end();
      });
      socket.setTimeout(3000);
      socket.on("timeout", function () { console.log("[NET] timeout ao alcancar " + host + ":" + port); socket.destroy(); });
      socket.on("error", function (error) { console.log("[NET] bloqueado " + host + ":" + port + " (" + error.code + ")"); });
    } else if (parts[0] === "ping") {
      console.log("[botB] pong");
    }
  });
});
process.stdin.resume();
`;

function zipForA(v2: boolean): Buffer {
  const pkg = v2
    ? { name: "e2e-bot-a", version: "2.0.0", private: true, main: "index.js", dependencies: { "discord.js": "^14.16.3", dotenv: "^16.4.5" } }
    : { name: "e2e-bot-a", version: "1.0.0", private: true, main: "index.js", dependencies: { "discord.js": "^14.16.3" } };
  return makeZip([
    { name: "e2e-bot-a-main/package.json", content: JSON.stringify(pkg, null, 2) },
    { name: "e2e-bot-a-main/index.js", content: v2 ? BOT_A_V2 : BOT_A_V1 },
  ]);
}

/** Bot B sem manifesto de dependências: nada para instalar. */
function zipForB(): Buffer {
  return makeZip([{ name: "index.js", content: BOT_B }]);
}

/** Bot Python: dependência real vinda do requirements.txt. */
const BOT_PY = `
import json
import os
import time

import six

DATA = os.environ.get("DATA_DIR", "/data")
state_file = os.path.join(DATA, "py-state.json")

boots = 0
try:
    with open(state_file, encoding="utf-8") as handle:
        boots = int(json.load(handle).get("boots", 0))
except Exception:
    boots = 0
boots += 1
with open(state_file, "w", encoding="utf-8") as handle:
    json.dump({"boots": boots}, handle)

print(f"[pybot] six={six.__version__} boots={boots}", flush=True)
print("[PYREADY] six=" + six.__version__ + " boots=" + str(boots), flush=True)

while True:
    print("[pyheartbeat] running v=" + six.__version__, flush=True)
    time.sleep(2)
`;

function zipForPy(): Buffer {
  return makeZip([
    { name: "e2e-bot-py/requirements.txt", content: "six\n" },
    { name: "e2e-bot-py/bot.py", content: BOT_PY },
  ]);
}

// ------------------------------------------------------------------ helpers

let baseUrl = "";
let cookie = "";

async function docker(args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function inspect(container: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await docker(["inspect", container]);
    return (JSON.parse(raw) as Record<string, unknown>[])[0] ?? null;
  } catch {
    return null;
  }
}

function dig<T>(source: unknown, pathExpression: string): T | undefined {
  return pathExpression.split(".").reduce<unknown>((accumulator, key) => {
    if (accumulator === null || accumulator === undefined) return undefined;
    if (Array.isArray(accumulator)) return (accumulator as unknown[])[Number(key)];
    return (accumulator as Record<string, unknown>)[key];
  }, source) as T | undefined;
}

async function waitFor<T>(label: string, probe: () => Promise<T | null | undefined | false>, timeoutMs = 60_000, intervalMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    const value = await probe().catch((error: unknown) => {
      last = error;
      return null;
    });
    if (value) return value as T;
    if (Date.now() > deadline) {
      throw new Error(`Tempo esgotado esperando: ${label}${last ? ` (último erro: ${String(last)})` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function json<T>(route: string, init: RequestInit = {}): Promise<T> {
  // Só anuncia JSON quando existe corpo: um POST/DELETE vazio com
  // content-type application/json é rejeitado pelo Fastify — e o frontend real
  // também não envia esse header em requisições sem corpo.
  const headers: Record<string, string> = { cookie };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${route} -> ${response.status}: ${text.slice(0, 300)}`);
  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}

async function uploadZip(zip: Buffer, fileName: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(zip)], { type: "application/zip" }), fileName);
  const response = await fetch(`${baseUrl}/api/uploads`, { method: "POST", headers: { cookie }, body: form });
  const text = await response.text();
  if (!response.ok) throw new Error(`upload falhou: ${response.status} ${text.slice(0, 300)}`);
  return (JSON.parse(text) as { upload: { id: string } }).upload.id;
}

async function deploy(slug: string, zip: Buffer, fileName: string, notes = ""): Promise<{ deploymentId: number; releaseSeq: number; log: string }> {
  const uploadId = await uploadZip(zip, fileName);
  const started = await json<{ deploymentId: number; releaseSeq: number }>(`/api/apps/${slug}/deploy`, {
    method: "POST",
    body: JSON.stringify({ uploadId, notes }),
  });

  const deployment = await waitFor(
    `deploy ${fileName} terminar`,
    async () => {
      const result = await json<{ deployment: { status: string; log: string } }>(`/api/apps/${slug}/deployments/${started.deploymentId}`);
      return result.deployment.status === "running" ? null : result.deployment;
    },
    420_000,
    1000,
  );

  return { ...started, log: deployment.log };
}

/**
 * Coleta eventos do Docker em segundo plano (usado para provar o OOM real
 * disparado pelo limite de memória).
 */
function collectDockerEvents(args: string[]): { stop: () => Promise<string> } {
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  return {
    stop: async () => {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("close", resolve));
      return output;
    },
  };
}

/** Abre o stream WebSocket (logs + métricas + console) e guarda as mensagens. */
function openStream(slug: string): {
  messages: Record<string, unknown>[];
  lines: () => string[];
  waitForLine: (needle: string, timeoutMs?: number) => Promise<string>;
  send: (data: string) => void;
  close: () => void;
} {
  const WebSocketImpl = requireFromHere("ws") as new (url: string, options?: { headers?: Record<string, string> }) => WsLike;
  const socket = new WebSocketImpl(`ws://127.0.0.1:${new URL(baseUrl).port}/api/apps/${slug}/stream`, {
    headers: { cookie },
  });
  const messages: Record<string, unknown>[] = [];

  socket.on("message", (raw: unknown) => {
    try {
      messages.push(JSON.parse(String(raw)) as Record<string, unknown>);
    } catch {
      // ignora payload inválido
    }
  });

  // O socket precisa estar aberto para aceitar comandos, e vários testes enviam
  // o primeiro comando logo depois de abrir o stream: enfileiramos até o "open".
  let isOpen = false;
  const queued: string[] = [];
  socket.on("open", () => {
    isOpen = true;
    while (queued.length > 0) socket.send(queued.shift() as string);
  });

  const lineTexts = (): string[] =>
    messages.filter((message) => message["type"] === "log").map((message) => String(message["line"] ?? ""));

  return {
    messages,
    lines: lineTexts,
    waitForLine: async (needle: string, timeoutMs = 20_000) => {
      const found = await waitFor(`linha "${needle}" no stream`, async () => {
        const match = lineTexts().find((line) => line.includes(needle));
        return match ?? null;
      }, timeoutMs, 300);
      return found;
    },
    send: (data: string) => {
      const payload = JSON.stringify({ type: "stdin", data });
      if (isOpen) socket.send(payload);
      else queued.push(payload);
    },
    close: () => socket.close(),
  };
}

// -------------------------------------------------------------------- setup

let workDir: string;
let server: FastifyInstance;
let context: AppContext;

const SLUG_A = "e2e-bot-a";
const SLUG_B = "e2e-bot-b";
const SLUG_PY = "e2e-bot-py";
const CONTAINER_A = `botpanel-${SLUG_A}`;
const CONTAINER_B = `botpanel-${SLUG_B}`;
const CONTAINER_PY = `botpanel-${SLUG_PY}`;
const NET_A = `botpanel-net-${SLUG_A}`;

suite("ciclo de vida completo com Docker", () => {
  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "botpanel-e2e-"));
    const built = await buildServer(
      testConfig(workDir, {
        dockerSocket: dockerPath,
        password: "e2e-secret",
        keepReleases: 10,
      }),
    );
    server = built.server;
    context = built.context;
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "e2e-secret" }),
    });
    const setCookie = login.headers.getSetCookie();
    cookie = (setCookie[0] ?? "").split(";")[0] ?? "";
    expect(cookie).toContain("botpanel_session");
  }, 120_000);

  afterAll(async () => {
    for (const slug of [SLUG_A, SLUG_B, SLUG_PY]) {
      await fetch(`${baseUrl}/api/apps/${slug}?deleteFiles=true`, { method: "DELETE", headers: { cookie } }).catch(() => undefined);
      await docker(["rm", "-f", `botpanel-${slug}`]).catch(() => undefined);
      await docker(["network", "rm", `botpanel-net-${slug}`]).catch(() => undefined);
    }
    await server.close().catch(() => undefined);
    context.store.close();
    await fs.rm(workDir, { recursive: true, force: true });
  }, 120_000);

  it("cria a aplicação, instala as dependências Node.js e sobe o container", async () => {
    const created = await json<{ app: { slug: string } }>("/api/apps", {
      method: "POST",
      body: JSON.stringify({
        name: "E2E Bot A",
        runtime: "node",
        image: "node:22-slim",
        entry: "index.js",
        depsFile: "package.json",
        memoryMb: 256,
        cpu: 0.5,
        pidsLimit: 128,
        env: [{ key: "E2E_MARKER", value: "ok", secret: false }],
      }),
    });
    expect(created.app.slug).toBe(SLUG_A);

    const result = await deploy(SLUG_A, zipForA(false), "bot-a-v1.zip", "primeira versão");

    expect(result.log).toContain("Extraindo pacote");
    expect(result.log).toContain('pasta "e2e-bot-a-main/" removida');
    expect(result.log).toContain("Instalando dependências: npm install");
    expect(result.log).toContain("Dependências instaladas");
    expect(result.log).toContain(`Container ${CONTAINER_A} criado`);
    expect(result.log).toContain("Release 1 publicado e em execução");
    // A falha de deploy precisa aparecer de forma explícita, não silenciosa.
    expect(result.log).not.toContain("Falha no deploy");

    const app = await json<{ app: { activeRelease: number; status: string } }>(`/api/apps/${SLUG_A}`);
    expect(app.app.activeRelease).toBe(1);

    // O release guarda o código, sem o prefixo do ZIP.
    const releaseDir = path.join(workDir, "apps", SLUG_A, "releases", "1");
    await expect(fs.access(path.join(releaseDir, "index.js"))).resolves.toBeUndefined();
    // Dependência real instalada dentro do release.
    const discordPackage = JSON.parse(
      await fs.readFile(path.join(releaseDir, "node_modules", "discord.js", "package.json"), "utf8"),
    ) as { version: string };
    expect(discordPackage.version).toMatch(/^\d+\./);
    // node_modules pertence ao UID dos containers (1000), para o app poder escrever.
    const stats = await fs.stat(path.join(releaseDir, "node_modules"));
    expect(stats.uid).toBe(1000);

    // O job de instalação não pode deixar lixo para trás.
    const leftovers = await docker(["ps", "-a", "--filter", "label=botpanel.job", "--format", "{{.Names}}"]);
    expect(leftovers).toBe("");

    const containerState = await waitFor("container em execução", async () => {
      const info = await inspect(CONTAINER_A);
      return dig<string>(info, "State.Status") === "running" ? info : null;
    }, 60_000);
    expect(dig<string>(containerState, "Config.User")).toBe("1000:1000");
  }, 480_000);

  it("instala as dependências Python dentro do release e o bot as importa", async () => {
    const created = await json<{ app: { slug: string } }>("/api/apps", {
      method: "POST",
      body: JSON.stringify({
        name: "E2E Bot Py",
        runtime: "python",
        image: "python:3.12-slim",
        entry: "bot.py",
        depsFile: "requirements.txt",
        memoryMb: 256,
        cpu: 0.5,
        pidsLimit: 128,
      }),
    });
    expect(created.app.slug).toBe(SLUG_PY);

    const result = await deploy(SLUG_PY, zipForPy(), "bot-py-v1.zip", "primeira versão");

    expect(result.log).toContain("Instalando dependências: pip install --no-cache-dir --user -r requirements.txt");
    expect(result.log).toContain("Dependências instaladas");
    expect(result.log).toContain("Release 1 publicado e em execução");
    // O job de instalação é descartável e só /app é montado nele: instalar no
    // user site padrão ($HOME/.local, com HOME=/tmp no job) fazia o pacote
    // desaparecer e o bot quebrava com ModuleNotFoundError no runtime.
    expect(result.log).not.toContain("/tmp/.local");

    const sitePackages = path.join(
      workDir,
      "apps",
      SLUG_PY,
      "releases",
      "1",
      CONTAINER_PYTHON_PACKAGES.replace(/^\/app\//, ""),
      "lib",
      "python3.12",
      "site-packages",
    );
    await expect(fs.access(path.join(sitePackages, "six.py"))).resolves.toBeUndefined();

    const info = await waitFor("container Python em execução", async () => {
      const current = await inspect(CONTAINER_PY);
      return dig<string>(current, "State.Status") === "running" ? current : null;
    }, 60_000);
    // O runtime precisa procurar os pacotes exatamente onde a instalação gravou.
    expect(dig<string[]>(info, "Config.Env") ?? []).toContain(`PYTHONUSERBASE=${CONTAINER_PYTHON_PACKAGES}`);

    const logs = await waitFor("log de inicialização do bot Python", async () => {
      const output = await json<{ logs: string }>(`/api/apps/${SLUG_PY}/logs?tail=200`);
      return output.logs.includes("[PYREADY]") ? output.logs : null;
    }, 90_000, 2000);
    expect(logs).toContain("[PYREADY] six=");
    expect(logs).not.toContain("ModuleNotFoundError");
  }, 480_000);

  it("inicia o bot de teste, injeta variáveis e registra os logs de inicialização", async () => {
    const logs = await waitFor("log de inicialização e heartbeat do bot", async () => {
      const result = await json<{ logs: string }>(`/api/apps/${SLUG_A}/logs?tail=400`);
      // O boot aparece em t=0 e o primeiro heartbeat só ~2s depois: esperar
      // apenas o [BOTREADY] tornava a asserção de heartbeat uma corrida.
      return result.logs.includes("[BOTREADY]") && result.logs.includes("[heartbeat]") ? result.logs : null;
    }, 90_000, 2000);

    expect(logs).toContain("[BOTREADY] version=1.0.0");
    // A dependência real (discord.js) foi instalada e é carregável pelo bot.
    expect(logs).toContain("Client=function");
    expect(logs).not.toContain("FALHA discord.js");
    expect(logs).toContain("env E2E_MARKER=ok");
    expect(logs).toContain("[heartbeat]");
  }, 180_000);

  it("ao parar pelo painel o estado fica 'parado' e o uptime para de contar", async () => {
    // O `docker stop` encerra o processo com o mesmo código (137, SIGKILL) de um
    // processo morto à força. Sem a intenção de parada registrada no banco, o
    // painel mostrava "Falhou" e sugeria reinício automático. E o uptime, lido do
    // `StartedAt` da última execução, continuava subindo com o bot desligado —
    // num container que nunca subiu, o `0001-01-01T00:00:00Z` do Docker fazia a
    // tela mostrar centenas de milhares de dias.
    interface StatsMessage {
      type: string;
      status: string;
      resources: { uptimeSeconds: number; startedAt: string | null } | null;
    }

    const stream = openStream(SLUG_A);
    const lastStats = (): StatsMessage | null => {
      for (let index = stream.messages.length - 1; index >= 0; index -= 1) {
        const message = stream.messages[index];
        if (message && message["type"] === "stats") return message as unknown as StatsMessage;
      }
      return null;
    };

    try {
      const rodando = await waitFor(
        "uptime correndo antes do stop",
        async () => {
          const stats = lastStats();
          return stats && stats.status === "running" && (stats.resources?.uptimeSeconds ?? 0) > 0 ? stats : null;
        },
        30_000,
        1000,
      );
      expect(rodando.resources?.uptimeSeconds ?? 0).toBeGreaterThan(0);
      expect(rodando.resources?.startedAt ?? null).not.toBeNull();

      await json(`/api/apps/${SLUG_A}/actions/stop`, { method: "POST" });

      const parado = await waitFor(
        "tempo real reportando a parada",
        async () => {
          const stats = lastStats();
          return stats && stats.status === "stopped" ? stats : null;
        },
        45_000,
        1000,
      );
      expect(parado.status).not.toBe("crashed");
      expect(parado.resources?.uptimeSeconds ?? 0).toBe(0);
      expect(parado.resources?.startedAt ?? null).toBeNull();

      // O cronômetro não pode voltar a subir com o container desligado.
      await new Promise((resolve) => setTimeout(resolve, 6000));
      const depois = lastStats();
      expect(depois?.status).toBe("stopped");
      expect(depois?.resources?.uptimeSeconds ?? 0).toBe(0);

      // A API REST precisa contar a mesma história que o tempo real.
      const resumo = await json<{ app: { status: string } }>(`/api/apps/${SLUG_A}`);
      expect(resumo.app.status).toBe("stopped");

      // E o Docker não pode trazer o container de volta sozinho.
      const info = await inspect(CONTAINER_A);
      expect(dig<boolean>(info, "State.Running")).toBe(false);
      expect(dig<boolean>(info, "State.Restarting")).toBe(false);
    } finally {
      stream.close();
      // Devolve o bot ao ar para os testes seguintes.
      await json(`/api/apps/${SLUG_A}/actions/start`, { method: "POST" });
      await waitFor(
        "bot de volta ao ar",
        async () => {
          const resultado = await json<{ app: { status: string } }>(`/api/apps/${SLUG_A}`);
          return resultado.app.status === "running" ? resultado : null;
        },
        90_000,
        1000,
      );
    }
  }, 300_000);

  it("aplica limites de RAM, CPU e PIDs no container", async () => {
    const info = await inspect(CONTAINER_A);
    expect(info).not.toBeNull();
    if (!info) throw new Error(`container ${CONTAINER_A} não encontrado`);
    expect(dig<number>(info, "HostConfig.Memory")).toBe(256 * 1024 * 1024);
    expect(dig<number>(info, "HostConfig.MemorySwap")).toBe(256 * 1024 * 1024);
    expect(dig<number>(info, "HostConfig.NanoCpus")).toBe(500_000_000);
    expect(dig<number>(info, "HostConfig.PidsLimit")).toBe(128);
    expect(dig<string[]>(info, "HostConfig.CapDrop")).toEqual(["ALL"]);
    expect(dig<string[]>(info, "HostConfig.SecurityOpt")).toEqual(["no-new-privileges"]);
    expect(dig<string>(info, "HostConfig.RestartPolicy.Name")).toBe("unless-stopped");
    // Rede dedicada da aplicação (isolamento entre apps).
    expect(Object.keys(dig<Record<string, unknown>>(info, "NetworkSettings.Networks") ?? {})).toEqual([NET_A]);
    expect(info["Mounts"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Destination: "/app" }),
        expect.objectContaining({ Destination: "/data" }),
      ]),
    );

    // Confirma os valores reais no cgroup visto de dentro do container.
    const limits = await docker([
      "exec",
      CONTAINER_A,
      "sh",
      "-c",
      "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max /sys/fs/cgroup/cpu.max 2>/dev/null",
    ]);
    const [memoryMax, pidsMax, cpuMax] = limits.split("\n");
    expect(memoryMax).toBe(String(256 * 1024 * 1024));
    expect(pidsMax).toBe("128");
    // cpu.max = "quota período" -> 0.5 vCPU = 50000/100000
    expect(cpuMax).toBe("50000 100000");
  }, 120_000);

  it("streama logs em tempo real e aceita comandos no console (stdin)", async () => {
    const stream = openStream(SLUG_A);
    try {
      // Log em tempo real: um heartbeat novo precisa chegar pelo WebSocket.
      const heartbeat = await stream.waitForLine("[heartbeat]", 25_000);
      expect(heartbeat).toContain("v=1.0.0");

      // Console: o comando enviado pelo painel chega ao stdin do processo.
      stream.send("ping");
      const pong = await stream.waitForLine("[cmd] pong", 20_000);
      expect(pong).toContain("pong");

      stream.send("state");
      expect(await stream.waitForLine("[cmd] state=", 20_000)).toContain("boots");

      // Métricas ao vivo publicadas pelo stream.
      const stats = await waitFor("mensagem de métricas", async () => {
        const found = stream.messages.find((message) => message["type"] === "stats" && message["resources"]);
        return found ?? null;
      }, 20_000, 500);
      const resources = stats["resources"] as { memoryBytes: number; memoryLimitBytes: number; status: string };
      expect(resources.status).toBe("running");
      expect(resources.memoryLimitBytes).toBe(256 * 1024 * 1024);
      expect(resources.memoryBytes).toBeGreaterThan(0);
    } finally {
      stream.close();
    }
  }, 120_000);

  it("limpa os logs quando o bot reinicia e mostra só a execução atual", async () => {
    // O log do container (json-file) acumula todas as execuções: sem tratar
    // isso, um crash-loop repetia o mesmo erro para sempre na tela.
    const antes = openStream(SLUG_A);
    let bootsAntes = 0;
    try {
      await antes.waitForLine("[BOTREADY]", 25_000);
      bootsAntes = antes.lines().filter((line) => line.includes("[BOTREADY]")).length;
    } finally {
      antes.close();
    }
    expect(bootsAntes).toBe(1);

    await json(`/api/apps/${SLUG_A}/actions/restart`, { method: "POST" });

    // Conexão nova depois do restart (equivale a recarregar a página): precisa
    // trazer apenas a execução atual, e não as duas.
    const depois = openStream(SLUG_A);
    try {
      await depois.waitForLine("[BOTREADY]", 30_000);
      await waitFor(
        "heartbeat da nova execução",
        async () => (depois.lines().some((line) => line.includes("[heartbeat]")) ? true : null),
        30_000,
        500,
      );
      expect(depois.lines().filter((line) => line.includes("[BOTREADY]")).length).toBe(1);

      // Toda linha carrega o instante da execução a que pertence, que é o que
      // permite ao frontend limpar a tela quando o container reinicia.
      const runs = new Set(
        depois.messages.filter((message) => message["type"] === "log").map((message) => String(message["startedAt"])),
      );
      expect(runs.size).toBe(1);
    } finally {
      depois.close();
    }

    // Prova de que o filtro é do painel: o log bruto do Docker tem as duas.
    const raw = await docker(["logs", CONTAINER_A]);
    expect(raw.split("\n").filter((line) => line.includes("[BOTREADY]")).length).toBeGreaterThanOrEqual(2);
  }, 180_000);

  it("mata o container ao estourar o limite de RAM e o reinicia automaticamente", async () => {
    const before = await inspect(CONTAINER_A);
    const restartsBefore = dig<number>(before, "RestartCount") ?? 0;

    // Escuta os eventos de OOM do Docker antes de estourar a memória.
    const events = collectDockerEvents([
      "events",
      "--filter",
      `container=${CONTAINER_A}`,
      "--filter",
      "event=oom",
      "--format",
      "{{.Action}}",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // O bot tenta alocar 900 MB dentro de um limite de 256 MB.
    const stream = openStream(SLUG_A);
    stream.send("mem 900");
    await stream.waitForLine("[cmd] alocado 900MB", 15_000).catch(() => undefined);
    stream.close();

    // O container precisa morrer e voltar sozinho (unless-stopped).
    const restarted = await waitFor("container reiniciado após OOM", async () => {
      const info = await inspect(CONTAINER_A);
      const restarts = dig<number>(info, "RestartCount") ?? 0;
      return restarts > restartsBefore && dig<string>(info, "State.Status") === "running" ? info : null;
    }, 90_000, 2000);
    expect(dig<number>(restarted, "RestartCount")).toBeGreaterThan(restartsBefore);

    // Prova de que o limite de memória foi respeitado: evento de OOM do kernel.
    expect(await events.stop()).toContain("oom");

    const logs = await waitFor("boot após o OOM", async () => {
      const result = await json<{ logs: string }>(`/api/apps/${SLUG_A}/logs?tail=200`);
      return result.logs.includes("boots=2") ? result.logs : null;
    }, 60_000, 2000);
    expect(logs).toContain("boots=2");
  }, 300_000);

  it("limita o consumo de CPU ao valor configurado", async () => {
    const stream = openStream(SLUG_A);
    stream.send("cpu 12");

    // Amostra o uso real enquanto o processo queima CPU em um loop.
    const samples: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const raw = await docker(["stats", "--no-stream", "--format", "{{.CPUPerc}}", CONTAINER_A]);
      samples.push(Number.parseFloat(raw.replace("%", "")));
    }
    stream.close();

    const peak = Math.max(...samples);
    const average = samples.reduce((total, value) => total + value, 0) / samples.length;
    // Sem limite chegaria a ~100% de um núcleo; com 0.5 vCPU precisa ficar perto de 50%.
    expect(peak).toBeLessThan(75);
    expect(average).toBeGreaterThan(10);
  }, 240_000);  it("limita a quantidade de processos (proteção contra fork bomb)", async () => {
    const stream = openStream(SLUG_A);
    try {
      stream.send("procs 300");
      await stream.waitForLine("[cmd] procs solicitados=300", 20_000);

      await new Promise((resolve) => setTimeout(resolve, 4000));

      // Lemos o pids.current pelo daemon: com o limite saturado pode não haver
      // espaço nem para abrir um `sh` dentro do container via `docker exec`.
      const pidsCurrent = Number(await docker(["stats", "--no-stream", "--format", "{{.PIDs}}", CONTAINER_A]));

      // Foram pedidos 300 processos e o cgroup segurou no limite de 128: a fork
      // bomb não estoura o limite nem derruba a VPS.
      expect(pidsCurrent).toBeLessThanOrEqual(128);
      expect(pidsCurrent).toBeGreaterThan(50);

      // Libera os filhos: sem isso o limite fica saturado e envenena os testes
      // seguintes (nem threads o próximo processo consegue criar).
      stream.send("killprocs");
      await stream.waitForLine("[cmd] filhos encerrados=", 20_000);
    } finally {
      stream.close();
    }

    const freed = await waitFor("processos liberados após encerrar a fork bomb", async () => {
      const current = Number(await docker(["stats", "--no-stream", "--format", "{{.PIDs}}", CONTAINER_A]));
      return current < 30 ? current : null;
    }, 30_000, 1000);
    expect(freed).toBeLessThan(30);
  }, 180_000);

  it("isola arquivos, processos e rede entre aplicações", async () => {
    const created = await json<{ app: { slug: string } }>("/api/apps", {
      method: "POST",
      body: JSON.stringify({
        name: "E2E Bot B",
        runtime: "node",
        image: "node:22-slim",
        entry: "index.js",
        memoryMb: 128,
        cpu: 0.25,
        pidsLimit: 96,
        env: [
          { key: "E2E_MARKER", value: "ok", secret: false },
          { key: "HOST_DATA_DIR", value: workDir, secret: false },
        ],
      }),
    });
    expect(created.app.slug).toBe(SLUG_B);

    const result = await deploy(SLUG_B, zipForB(), "bot-b.zip");
    // Sem dependências: o painel avisa e segue.
    expect(result.log).toContain("Nenhum arquivo de dependências detectado");

    const bLogs = await waitFor("sondagens de isolamento do bot B", async () => {
      const logsResult = await json<{ logs: string }>(`/api/apps/${SLUG_B}/logs?tail=300`);
      return logsResult.logs.includes("[ISOLAMENTO] /data contem") ? logsResult.logs : null;
    }, 90_000, 2000);

    // Arquivos: nem mesmo sabendo o caminho real no host, B não alcança o que é de A.
    expect(bLogs).toContain(`ler ${workDir}/apps/e2e-bot-a/shared/state.json -> bloqueado (ENOENT)`);
    expect(bLogs).toContain(`ler ${workDir}/botpanel.db -> bloqueado (ENOENT)`);
    expect(bLogs).toContain("/data contem: marker-b.txt");
    expect(bLogs).not.toContain("ACESSIVEL (FALHA)");

    // Processos: o bot B está num namespace de PID próprio e só enxerga a si
    // mesmo — muito menos do que o host, que vê dezenas de processos.
    const visible = Number(/processos visiveis: (\d+)/.exec(bLogs)?.[1] ?? "0");
    const hostPids = (await fs.readdir("/proc")).filter((name) => /^\d+$/.test(name)).length;
    expect(visible).toBeGreaterThanOrEqual(1);
    expect(visible).toBeLessThan(hostPids);
    expect(visible).toBeLessThan(30);

    // Rede: B não alcança uma porta aberta em A, mesmo sabendo o IP.
    const aIp = dig<string>(await inspect(CONTAINER_A), "NetworkSettings.Networks.botpanel-net-e2e-bot-a.IPAddress");
    expect(aIp).toBeTruthy();

    const streams = openStream(SLUG_A);
    streams.send("listen 3999");
    await streams.waitForLine("ouvindo em 3999", 20_000);

    // Controle positivo: a porta responde dentro do próprio container A. Sem
    // isso, "não alcançou" poderia significar apenas que o app não subiu.
    const localProbe = await docker([
      "exec",
      CONTAINER_A,
      "node",
      "-e",
      "fetch('http://127.0.0.1:3999').then(r=>r.text()).then(t=>console.log('A-local:'+t)).catch(e=>console.log('A-local:erro:'+e.message))",
    ]);
    expect(localProbe).toContain("A-local:bot-a");

    const streamB = openStream(SLUG_B);
    try {
      streamB.send(`probe ${aIp}:3999`);
      const verdict = await streamB.waitForLine("[NET]", 25_000);
      // Isolamento: a conexão não pode ser concluída. Conforme as regras de
      // iptables do Docker o SYN é descartado (timeout) ou recusado (ECONNREFUSED).
      expect(verdict).not.toContain("alcancou");
      expect(verdict).toMatch(/bloqueado|timeout/);
    } finally {
      streams.close();
      streamB.close();
    }

    // Ainda é possível sair para a internet (DNS da rede dedicada funciona).
    const egress = await docker(["exec", CONTAINER_B, "sh", "-c", "getent hosts registry.npmjs.org >/dev/null && echo ok || echo falhou"]);
    expect(egress).toBe("ok");
  }, 480_000);

  it("persiste /data na atualização e roda o código novo (v2)", async () => {
    // Escreve um arquivo no volume persistente pelo painel.
    await json(`/api/apps/${SLUG_A}/files/content`, {
      method: "PUT",
      body: JSON.stringify({ root: "data", path: "config/manual.json", content: '{"preservar":true}' }),
    });

    const before = JSON.parse(
      await fs.readFile(path.join(workDir, "apps", SLUG_A, "shared", "state.json"), "utf8"),
    ) as { boots: number };
    expect(before.boots).toBeGreaterThanOrEqual(2);

    const result = await deploy(SLUG_A, zipForA(true), "bot-a-v2.zip", "segunda versão");
    expect(result.log).toContain("Release 2 publicado e em execução");

    const app = await json<{ app: { activeRelease: number } }>(`/api/apps/${SLUG_A}`);
    expect(app.app.activeRelease).toBe(2);

    // A versão anterior continua no disco (rollback imediato).
    const releases = await json<{ releases: { seq: number }[] }>(`/api/apps/${SLUG_A}/releases`);
    expect(releases.releases.map((release) => release.seq).sort()).toEqual([1, 2]);

    // /data foi preservado e o contador de boots continuou de onde estava.
    const preserved = await fs.readFile(path.join(workDir, "apps", SLUG_A, "shared", "config", "manual.json"), "utf8");
    expect(preserved).toBe('{"preservar":true}');

    const logs = await waitFor("boot na versão 2", async () => {
      const logsResult = await json<{ logs: string }>(`/api/apps/${SLUG_A}/logs?tail=200`);
      return logsResult.logs.includes("[BOTREADY] version=2.0.0") ? logsResult.logs : null;
    }, 90_000, 2000);
    expect(logs).toContain("dotenv=function");
    expect(Number(/boots=(\d+)/.exec(logs)?.[1] ?? "0")).toBeGreaterThan(before.boots);

    // A dependência nova foi instalada no release 2.
    await expect(fs.access(path.join(workDir, "apps", SLUG_A, "releases", "2", "node_modules", "dotenv"))).resolves.toBeUndefined();

    // Comando exclusivo da v2 responde pelo console.
    const stream = openStream(SLUG_A);
    try {
      stream.send("novidade");
      expect(await stream.waitForLine("comando exclusivo da v2", 25_000)).toContain("comando exclusivo da v2");
    } finally {
      stream.close();
    }
  }, 480_000);

  it("faz rollback para a versão anterior preservando os dados", async () => {
    await json(`/api/apps/${SLUG_A}/releases/1/activate`, { method: "POST" });

    const app = await json<{ app: { activeRelease: number; memoryMb: number; cpu: number } }>(`/api/apps/${SLUG_A}`);
    expect(app.app.activeRelease).toBe(1);
    // Recursos configurados agora são preservados no rollback.
    expect(app.app.memoryMb).toBe(256);
    expect(app.app.cpu).toBe(0.5);

    const logs = await waitFor("v1 de volta em execução", async () => {
      const logsResult = await json<{ logs: string }>(`/api/apps/${SLUG_A}/logs?tail=200`);
      return logsResult.logs.includes("[BOTREADY] version=1.0.0") ? logsResult.logs : null;
    }, 90_000, 2000);
    expect(logs).toContain("v=1.0.0");

    // O comando da v2 não existe mais no código ativo.
    const stream = openStream(SLUG_A);
    try {
      stream.send("novidade");
      expect(await stream.waitForLine("[cmd] desconhecido", 25_000)).toContain("desconhecido");
    } finally {
      stream.close();
    }

    // Os dados persistentes sobreviveram ao rollback.
    const preserved = await fs.readFile(path.join(workDir, "apps", SLUG_A, "shared", "config", "manual.json"), "utf8");
    expect(preserved).toBe('{"preservar":true}');

    // Container recriado apontando para o release 1.
    const mount = dig<{ Source: string }[]>(await inspect(CONTAINER_A), "Mounts")?.find((item) => item.Source.includes("releases"));
    expect(mount?.Source.endsWith(path.join("releases", "1"))).toBe(true);
  }, 300_000);

  it("mantém as aplicações de pé após reiniciar o Docker", async () => {
    if (process.env["BOTPANEL_E2E_DOCKER_RESTART"] !== "1") {
      // Sem a flag, apenas confirma os pré-requisitos do boot automático.
      const infoA = await inspect(CONTAINER_A);
      expect(dig<string>(infoA, "HostConfig.RestartPolicy.Name")).toBe("unless-stopped");
      return;
    }

    // Container de controle com a política que o interruptor "iniciar com o
    // sistema" desligado usa (`on-failure`): ele reinicia após erro, mas não
    // depois de reiniciar o daemon — é essa a diferença que o painel promete.
    const probe = "botpanel-e2e-onfailure-probe";
    await docker(["rm", "-f", probe]).catch(() => undefined);
    await docker(["run", "-d", "--name", probe, "--restart", "on-failure", "alpine:3.20", "sleep", "900"]);

    await execFileAsync("systemctl", ["restart", "docker"], { timeout: 120_000 });

    const running = await waitFor("containers de volta após reiniciar o Docker", async () => {
      const infoA = await inspect(CONTAINER_A);
      const infoB = await inspect(CONTAINER_B);
      const bothRunning = dig<string>(infoA, "State.Status") === "running" && dig<string>(infoB, "State.Status") === "running";
      return bothRunning ? true : null;
    }, 180_000, 3000);
    expect(running).toBe(true);

    // O painel continua respondendo e enxerga as aplicações.
    const health = await fetch(`${baseUrl}/api/health`);
    expect(health.status).toBe(200);

    // Assim que o daemon volta os containers ficam running, mas o painel reporta
    // "starting" por uma janela curta (evita piscar a interface). Esperamos a
    // visão do painel — que é o que o usuário realmente enxerga.
    const statuses = await waitFor("painel reportar as aplicações como running", async () => {
      const snapshot = await json<{ apps: { slug: string; status: string }[] }>("/api/apps");
      const statusOf = (slug: string) => snapshot.apps.find((app) => app.slug === slug)?.status;
      return statusOf(SLUG_A) === "running" && statusOf(SLUG_B) === "running" ? snapshot : null;
    }, 120_000, 2000);
    expect(statuses.apps.find((app) => app.slug === SLUG_A)?.status).toBe("running");

    // `on-failure` **não** volta sozinho com o daemon (só `always`/`unless-stopped`).
    const probeInfo = await inspect(probe);
    expect(dig<string>(probeInfo, "HostConfig.RestartPolicy.Name")).toBe("on-failure");
    expect(dig<boolean>(probeInfo, "State.Running")).toBe(false);
    await docker(["rm", "-f", probe]).catch(() => undefined);
  }, 420_000);

  it("traduz os interruptores de início e reinício na política de reinício do Docker", async () => {
    const policyOf = async (container: string): Promise<string | undefined> =>
      dig<string>(await inspect(container), "HostConfig.RestartPolicy.Name");

    // Espera a política nova **e** o container de pé: salvar a configuração
    // recria o container, e entre o `create` e o `start` a política já mudou mas
    // o processo ainda não subiu.
    const setToggles = async (autoStart: boolean, autoRestart: boolean): Promise<void> => {
      await json(`/api/apps/${SLUG_A}`, {
        method: "PATCH",
        body: JSON.stringify({ autoStart, autoRestart }),
      });
      await waitFor(
        `política esperada (autoStart=${autoStart}, autoRestart=${autoRestart})`,
        async () => {
          const info = await inspect(CONTAINER_A);
          const esperada = autoRestart ? (autoStart ? "unless-stopped" : "on-failure") : "no";
          const policyOk = dig<string>(info, "HostConfig.RestartPolicy.Name") === esperada;
          const running = dig<string>(info, "State.Status") === "running";
          return policyOk && running ? true : null;
        },
        60_000,
        1000,
      );
    };

    try {
      // Padrão: sobe junto com o sistema e volta sozinho quando cai.
      await setToggles(true, true);
      expect(await policyOf(CONTAINER_A)).toBe("unless-stopped");

      // Desligar o reinício automático (mantendo o início com o sistema) deixa a
      // aplicação de pé — o container é recriado, não derrubado.
      await setToggles(true, false);
      expect(await policyOf(CONTAINER_A)).toBe("no");
      const rodando = await inspect(CONTAINER_A);
      expect(dig<string>(rodando, "State.Status")).toBe("running");
      const resumo = await json<{ app: { status: string; autoStart: boolean; autoRestart: boolean } }>(
        `/api/apps/${SLUG_A}`,
      );
      expect(resumo.app.status).toBe("running");
      expect(resumo.app.autoStart).toBe(true);
      expect(resumo.app.autoRestart).toBe(false);

      // Reiniciar ao cair, mas sem subir junto com a VPS: `on-failure`.
      await setToggles(false, true);
      expect(await policyOf(CONTAINER_A)).toBe("on-failure");

      // Nada automático: `no`.
      await setToggles(false, false);
      expect(await policyOf(CONTAINER_A)).toBe("no");
    } finally {
      await setToggles(true, true).catch(() => undefined);
    }
  }, 300_000);

  it("não reinicia sozinho quando o reinício automático está desligado", async () => {
    // A "queda" é um OOM de verdade (o bot tenta alocar 900 MB dentro de um
    // limite de 256 MB), igual ao teste de memória: `docker kill`/`docker stop`
    // não servem porque o Docker os trata como parada manual e nunca reinicia.
    const estaRodando = async (): Promise<boolean> =>
      dig<boolean>(await inspect(CONTAINER_A), "State.Running") === true;
    const reinicios = async (): Promise<number> => dig<number>(await inspect(CONTAINER_A), "RestartCount") ?? 0;
    const derrubar = async (): Promise<void> => {
      const stream = openStream(SLUG_A);
      stream.send("mem 900");
      await stream.waitForLine("[cmd] alocado 900MB", 15_000).catch(() => undefined);
      stream.close();
    };

    try {
      await json(`/api/apps/${SLUG_A}`, {
        method: "PATCH",
        body: JSON.stringify({ autoStart: true, autoRestart: false }),
      });
      await waitFor(
        "política `no` aplicada e container de pé",
        async () => {
          const info = await inspect(CONTAINER_A);
          return dig<string>(info, "HostConfig.RestartPolicy.Name") === "no" &&
            dig<string>(info, "State.Status") === "running"
            ? true
            : null;
        },
        60_000,
        1000,
      );

      // Sem reinício automático, o processo morre e fica morto — e o painel
      // precisa mostrar isso como falha, não como "parado pelo usuário".
      const antes = await reinicios();
      await derrubar();
      await waitFor(
        "container parado após o OOM",
        async () => ((await estaRodando()) ? null : true),
        60_000,
        1000,
      );
      await new Promise((resolve) => setTimeout(resolve, 8000));
      expect(await estaRodando()).toBe(false);
      expect(await reinicios()).toBe(antes);
      const depois = await json<{ app: { status: string } }>(`/api/apps/${SLUG_A}`);
      expect(["crashed", "stopped"]).toContain(depois.app.status);
      expect(depois.app.status).not.toBe("running");

      // Ligando o reinício automático, o Docker passa a ressuscitar o processo.
      // O painel não sobe sozinho o que já estava caído (quem cuida disso é a
      // política do Docker, e só a partir do próximo start) — então subimos uma
      // vez pelo botão e aí sim derrubamos de novo para ver a volta automática.
      await json(`/api/apps/${SLUG_A}`, { method: "PATCH", body: JSON.stringify({ autoRestart: true }) });
      await waitFor(
        "política `unless-stopped` aplicada",
        async () =>
          dig<string>(await inspect(CONTAINER_A), "HostConfig.RestartPolicy.Name") === "unless-stopped" ? true : null,
        60_000,
        1000,
      );
      await json(`/api/apps/${SLUG_A}/actions/start`, { method: "POST" });
      await waitFor("bot de pé pelo botão Iniciar", async () => ((await estaRodando()) ? true : null), 120_000, 2000);

      const antesDoCrash = await reinicios();
      await derrubar();
      await waitFor(
        "Docker trouxe o bot de volta sozinho",
        async () => {
          const info = await inspect(CONTAINER_A);
          return (dig<number>(info, "RestartCount") ?? 0) > antesDoCrash && dig<string>(info, "State.Status") === "running"
            ? true
            : null;
        },
        120_000,
        2000,
      );
    } finally {
      // Devolve ao ar para os testes seguintes (a política padrão já está ativa).
      await json(`/api/apps/${SLUG_A}/actions/start`, { method: "POST" }).catch(() => undefined);
      await waitFor("bot de volta ao ar", async () =>
        dig<boolean>(await inspect(CONTAINER_A), "State.Running") === true ? true : null, 120_000, 2000).catch(() => undefined);
    }
  }, 300_000);

  it("sobe no boot só o que está marcado como 'iniciar junto com o sistema'", async () => {
    const estaRodando = async (name: string): Promise<boolean> =>
      dig<boolean>(await inspect(name), "State.Running") === true;

    try {
      // 1. Parado de propósito pelo painel: o boot automático do painel NÃO pode
      //    ressuscitar (a intenção do usuário vence).
      await json(`/api/apps/${SLUG_A}/actions/stop`, { method: "POST" });
      expect(await estaRodando(CONTAINER_A)).toBe(false);
      await context.apps.startAutoApps();
      expect(await estaRodando(CONTAINER_A)).toBe(false);

      // 2. Parado fora do painel (queda/servidor reiniciado), com o interruptor
      //    ligado: o boot do painel sobe a aplicação.
      await json(`/api/apps/${SLUG_A}/actions/start`, { method: "POST" });
      await waitFor("app de volta ao ar", async () => ((await estaRodando(CONTAINER_A)) ? true : null), 120_000, 2000);
      await docker(["stop", CONTAINER_A]);
      expect(await estaRodando(CONTAINER_A)).toBe(false);
      const summary = await context.apps.startAutoApps();
      expect(summary.started).toContain(SLUG_A);
      await waitFor("painel subiu a aplicação no boot", async () =>
        ((await estaRodando(CONTAINER_A)) ? true : null), 60_000, 1000);

      // 3. Mesmo cenário, mas com "iniciar junto com o sistema" desligado: o boot
      //    deixa a aplicação parada.
      await json(`/api/apps/${SLUG_A}`, { method: "PATCH", body: JSON.stringify({ autoStart: false }) });
      await waitFor("container de pé antes de parar", async () =>
        ((await estaRodando(CONTAINER_A)) ? true : null), 60_000, 1000);
      await docker(["stop", CONTAINER_A]);
      await context.apps.startAutoApps();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(await estaRodando(CONTAINER_A)).toBe(false);
      const eventos = context.store.listEvents(50);
      expect(eventos.some((event) => event.message.includes("iniciada junto com o sistema"))).toBe(true);
    } finally {
      await json(`/api/apps/${SLUG_A}`, { method: "PATCH", body: JSON.stringify({ autoStart: true }) }).catch(() => undefined);
      await json(`/api/apps/${SLUG_A}/actions/start`, { method: "POST" }).catch(() => undefined);
      await waitFor("bot de volta ao ar", async () =>
        dig<boolean>(await inspect(CONTAINER_A), "State.Running") === true ? true : null, 120_000, 2000).catch(() => undefined);
    }
  }, 300_000);

  it("um painel não remove os containers e redes de outra instância do painel", async () => {
    // Dois painéis com diretórios de dados diferentes podem apontar para o mesmo
    // daemon Docker. O reconcile de um não pode tocar nos recursos do outro.
    const foreignDir = await fs.mkdtemp(path.join(os.tmpdir(), "botpanel-e2e-foreign-"));
    const foreignStore = await Store.open(foreignDir);
    const foreignDocker = new DockerService(dockerPath, instanceIdForDataDir(foreignDir));
    const foreignApps = new AppService(
      testConfig(foreignDir, { dockerSocket: dockerPath }),
      foreignStore,
      foreignDocker,
    );

    // Containers de fora: um com o slug de uma app nossa (que a instância
    // estrangeira não conhece) e um sem label de instância (versão antiga).
    const legacyName = "bp-e2e-legacy";
    await docker(["rm", "-f", legacyName]).catch(() => undefined);
    await docker(["run", "-d", "--name", legacyName, "--label", `botpanel.app=${SLUG_A}`, "alpine:3.20", "sleep", "120"]);

    try {
      const report = await foreignApps.reconcile();
      expect(report.containers).toEqual([]);
      expect(report.networks).toEqual([]);

      // O container da app A continua de pé, na rede isolada dela.
      const infoA = await inspect(CONTAINER_A);
      expect(dig<string>(infoA, "State.Status")).toBe("running");
      const networks = await docker(["network", "ls", "--filter", `name=^${NET_A}$`, "--format", "{{.Name}}"]);
      expect(networks).toContain(NET_A);
      // Container sem label de instância nunca é removido por outra instância.
      const legacy = await inspect(legacyName);
      expect(dig<string>(legacy, "State.Status")).toBe("running");
    } finally {
      await docker(["rm", "-f", legacyName]).catch(() => undefined);
      foreignStore.close();
      await fs.rm(foreignDir, { recursive: true, force: true });
    }

    // Em contrapartida, a NOSSA instância continua limpando os seus órfãos.
    const orphanName = "botpanel-orfa-e2e";
    await docker(["rm", "-f", orphanName]).catch(() => undefined);
    await docker([
      "run", "-d", "--name", orphanName,
      "--label", "botpanel.app=orfa-e2e",
      "--label", `botpanel.instance=${context.config.instanceId}`,
      "alpine:3.20", "sleep", "120",
    ]);

    const own = await context.apps.reconcile();
    expect(own.containers).toContain(orphanName);
    expect(await inspect(orphanName)).toBeNull();
    // As apps do painel não foram afetadas pela limpeza.
    expect(dig<string>(await inspect(CONTAINER_A), "State.Status")).toBe("running");
  }, 240_000);

  it("remove containers, redes e arquivos temporários ao excluir as aplicações", async () => {
    await json(`/api/apps/${SLUG_B}?deleteFiles=true`, { method: "DELETE" });
    await json(`/api/apps/${SLUG_A}?deleteFiles=true`, { method: "DELETE" });
    await json(`/api/apps/${SLUG_PY}?deleteFiles=true`, { method: "DELETE" });

    // Containers e redes do painel não podem sobrar.
    const containers = await docker(["ps", "-a", "--filter", "name=botpanel-", "--format", "{{.Names}}"]);
    expect(containers.split("\n").filter((name) => name.includes("e2e-bot"))).toEqual([]);
    const networks = await docker(["network", "ls", "--filter", "label=botpanel.managed", "--format", "{{.Name}}"]);
    expect(networks.split("\n").filter((name) => name.includes("e2e-bot"))).toEqual([]);

    // Arquivos dos apps e uploads temporários foram apagados.
    await expect(fs.access(path.join(workDir, "apps", SLUG_A))).rejects.toThrow();
    await expect(fs.access(path.join(workDir, "apps", SLUG_B))).rejects.toThrow();
    await expect(fs.access(path.join(workDir, "apps", SLUG_PY))).rejects.toThrow();
    const uploads = await fs.readdir(path.join(workDir, "tmp", "uploads")).catch(() => []);
    expect(uploads.filter((name) => name.endsWith(".zip"))).toEqual([]);

    // Jobs de instalação também não deixam containers para trás.
    const jobs = await docker(["ps", "-a", "--filter", "label=botpanel.job", "--format", "{{.Names}}"]);
    expect(jobs).toBe("");

    // O registro no painel foi limpo.
    const apps = await json<{ apps: unknown[] }>("/api/apps");
    expect(apps.apps).toEqual([]);
  }, 240_000);
});
