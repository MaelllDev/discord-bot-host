import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store, nowIso } from "../src/db.ts";
import type { AppRecord } from "../src/types.ts";

let workDir: string;
let store: Store;

function app(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "id-1",
    slug: "bot-um",
    name: "Bot Um",
    description: "teste",
    iconUrl: "",
    runtime: "node",
    image: "node:22-slim",
    entry: "index.js",
    startCommand: "",
    installCommand: "",
    depsFile: "",
    memoryMb: 512,
    cpu: 1,
    pidsLimit: 256,
    env: [{ key: "TOKEN", value: "abc", secret: true }],
    ports: ["8080:3000"],
    autoStart: true,
    autoRestart: true,
    stoppedByUser: false,
    activeRelease: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...overrides,
  };
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "botpanel-store-"));
  store = await Store.open(workDir);
});

afterEach(async () => {
  store.close();
  await fs.rm(workDir, { recursive: true, force: true });
});

describe("Store", () => {
  it("persiste e recupera aplicações com tipos corretos", () => {
    store.insertApp(app());

    const found = store.getApp("bot-um");
    expect(found).not.toBeNull();
    expect(found?.env).toEqual([{ key: "TOKEN", value: "abc", secret: true }]);
    expect(found?.ports).toEqual(["8080:3000"]);
    expect(found?.autoStart).toBe(true);
    expect(found?.autoRestart).toBe(true);
    expect(found?.memoryMb).toBe(512);
  });

  it("atualiza apenas os campos informados", () => {
    store.insertApp(app());
    const before = store.getApp("bot-um");

    store.updateApp("id-1", { memoryMb: 1024, autoStart: false, env: [] });
    const after = store.getApp("bot-um");

    expect(after?.memoryMb).toBe(1024);
    expect(after?.autoStart).toBe(false);
    expect(after?.env).toEqual([]);
    expect(after?.name).toBe(before?.name);
  });

  it("guarda os dois interruptores de inicialização", () => {
    store.insertApp(app({ autoStart: false, autoRestart: false }));
    expect(store.getApp("bot-um")?.autoStart).toBe(false);
    expect(store.getApp("bot-um")?.autoRestart).toBe(false);

    store.updateApp("id-1", { autoStart: true, autoRestart: true });
    expect(store.getApp("bot-um")?.autoStart).toBe(true);
    expect(store.getApp("bot-um")?.autoRestart).toBe(true);
  });

  it("guarda a intenção do usuário ao parar a aplicação", () => {
    store.insertApp(app());
    expect(store.getApp("bot-um")?.stoppedByUser).toBe(false);

    store.updateApp("id-1", { stoppedByUser: true });
    expect(store.getApp("bot-um")?.stoppedByUser).toBe(true);

    store.updateApp("id-1", { stoppedByUser: false });
    expect(store.getApp("bot-um")?.stoppedByUser).toBe(false);
  });

  it("adiciona a coluna nova em bancos criados por versões anteriores", async () => {
    // Simula um banco antigo: cria a tabela sem a coluna stopped_by_user.
    const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), "botpanel-legacy-"));
    const { DatabaseSync } = await import("node:sqlite");
    const legacy = new DatabaseSync(path.join(legacyDir, "botpanel.db"));
    legacy.exec(`
      CREATE TABLE apps (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', runtime TEXT NOT NULL DEFAULT 'node',
        image TEXT NOT NULL, entry TEXT NOT NULL DEFAULT '', start_command TEXT NOT NULL DEFAULT '',
        install_command TEXT NOT NULL DEFAULT '', deps_file TEXT NOT NULL DEFAULT '',
        memory_mb INTEGER NOT NULL DEFAULT 512, cpu REAL NOT NULL DEFAULT 1,
        pids_limit INTEGER NOT NULL DEFAULT 256, env TEXT NOT NULL DEFAULT '[]',
        ports TEXT NOT NULL DEFAULT '[]', auto_start INTEGER NOT NULL DEFAULT 1,
        active_release INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    legacy.close();

    const migrated = await Store.open(legacyDir);
    migrated.insertApp(app());
    expect(migrated.getApp("bot-um")?.stoppedByUser).toBe(false);
    // Sem a coluna, o padrão é manter o comportamento anterior: volta a subir.
    expect(migrated.getApp("bot-um")?.autoRestart).toBe(true);
    migrated.close();
    await fs.rm(legacyDir, { recursive: true, force: true });
  });

  it("detecta slug em uso", () => {
    store.insertApp(app());
    expect(store.slugTaken("bot-um")).toBe(true);
    expect(store.slugTaken("bot-um", "id-1")).toBe(false);
    expect(store.slugTaken("outro")).toBe(false);
  });

  it("sequencia releases e respeita a unicidade", () => {
    store.insertApp(app());
    expect(store.nextReleaseSeq("id-1")).toBe(1);

    store.insertRelease({
      appId: "id-1",
      seq: 1,
      dir: "/tmp/r1",
      image: "node:22-slim",
      entry: "index.js",
      startCommand: "",
      installCommand: "",
      notes: "",
      sizeBytes: 100,
      createdAt: nowIso(),
    });

    expect(store.nextReleaseSeq("id-1")).toBe(2);
    expect(store.listReleases("id-1")).toHaveLength(1);
    expect(store.countReleases("id-1")).toBe(1);
  });

  it("remove releases e mantém o histórico de deployments", () => {
    store.insertApp(app());
    store.insertRelease({
      appId: "id-1",
      seq: 1,
      dir: "/tmp/r1",
      image: "node:22-slim",
      entry: "",
      startCommand: "",
      installCommand: "",
      notes: "",
      sizeBytes: 0,
      createdAt: nowIso(),
    });

    const deploymentId = store.startDeployment("id-1", "deploy", 1);
    store.appendDeploymentLog(deploymentId, "linha 1\n");
    store.appendDeploymentLog(deploymentId, "linha 2\n");
    store.finishDeployment(deploymentId, "success");

    const deployment = store.getDeployment(deploymentId);
    expect(deployment?.log).toBe("linha 1\nlinha 2\n");
    expect(deployment?.status).toBe("success");
    expect(deployment?.finishedAt).not.toBeNull();

    store.deleteRelease("id-1", 1);
    expect(store.countReleases("id-1")).toBe(0);
    expect(store.listDeployments("id-1")).toHaveLength(1);
  });

  it("remove em cascata ao apagar a aplicação", () => {
    store.insertApp(app());
    store.startDeployment("id-1", "deploy", null);
    store.deleteApp("id-1");

    expect(store.getApp("bot-um")).toBeNull();
    expect(store.listDeployments("id-1")).toHaveLength(0);
  });

  it("registra eventos de atividade", () => {
    store.addEvent("id-1", "info", "publicado");
    store.addEvent(null, "error", "falhou");
    const events = store.listEvents();
    expect(events).toHaveLength(2);
    expect(events[0]?.message).toBe("falhou");
  });
});
