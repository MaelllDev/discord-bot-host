import { describe, expect, it } from "vitest";
import { isValidSlug, slugify, uniqueSlug } from "../src/util/slug.ts";
import {
  isImageAllowed,
  parsePortMappings,
  renderInstallCommand,
  renderStartCommand,
  shellQuote,
} from "../src/docker/templates.ts";
import { LineBuffer, computeCpuPercent, mapContainerState, parseDockerTime, parseStats, secondsSince } from "../src/docker/parse.ts";
import { applyStopIntent } from "../src/apps/status.ts";
import { buildContainerSpec, buildEnvironment, networkNameFor, restartPolicyFor, toCreateOptions } from "../src/apps/spec.ts";
import { CONTAINER_PYTHON_PACKAGES } from "../src/apps/paths.ts";
import { KeyedMutex } from "../src/util/mutex.ts";
import { maskValue } from "../src/util/format.ts";
import { instanceIdForDataDir } from "../src/config.ts";
import { DockerService, isDockerUnavailable, isTransientDockerError } from "../src/docker/service.ts";
import type { AppRecord } from "../src/types.ts";

function makeApp(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    id: "id-1",
    slug: "meu-bot",
    name: "Meu Bot",
    description: "",
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
    env: [],
    ports: [],
    autoStart: true,
    autoRestart: true,
    stoppedByUser: false,
    activeRelease: 1,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("slug", () => {
  it("normaliza acentos e caracteres especiais", () => {
    expect(slugify("Bot do João")).toBe("bot-do-joao");
    expect(slugify("  Meu   BOT!! 2026 ")).toBe("meu-bot-2026");
    expect(slugify("a")).toBe("");
  });

  it("valida o formato aceito", () => {
    expect(isValidSlug("meu-bot")).toBe(true);
    expect(isValidSlug("bot2")).toBe(true);
    expect(isValidSlug("-bot")).toBe(false);
    expect(isValidSlug("bot-")).toBe(false);
    expect(isValidSlug("bot--x")).toBe(false);
    expect(isValidSlug("api")).toBe(false);
    expect(isValidSlug("BOT")).toBe(false);
  });

  it("gera identificadores únicos em caso de colisão", () => {
    const taken = new Set(["meu-bot"]);
    const slug = uniqueSlug("Meu Bot", (candidate) => taken.has(candidate));
    expect(slug).toBe("meu-bot-2");
  });
});

describe("comandos de execução", () => {
  it("deriva o comando do runtime e do arquivo principal", () => {
    expect(renderStartCommand(makeApp())).toBe("node index.js");
    expect(renderStartCommand(makeApp({ runtime: "python", entry: "main.py" }))).toBe("python main.py");
    expect(renderStartCommand(makeApp({ entry: "src/meu bot.js" }))).toBe("node 'src/meu bot.js'");
  });

  it("prefere o comando explícito", () => {
    expect(renderStartCommand(makeApp({ startCommand: "npm start" }))).toBe("npm start");
  });

  it("exige comando em runtime livre", () => {
    expect(() => renderStartCommand(makeApp({ runtime: "custom", entry: "" }))).toThrow();
  });

  it("só instala dependências quando o manifesto existe", () => {
    expect(renderInstallCommand(makeApp(), ["index.js"])).toBe("");
    expect(renderInstallCommand(makeApp(), ["index.js", "package.json"])).toBe("npm install --no-audit --no-fund");
    expect(renderInstallCommand(makeApp({ runtime: "python" }), ["main.py", "requirements.txt"])).toBe(
      "pip install --no-cache-dir --user -r requirements.txt",
    );
    expect(renderInstallCommand(makeApp({ runtime: "python", depsFile: "pyproject.toml" }), ["pyproject.toml"])).toBe(
      "pip install --no-cache-dir --user .",
    );
  });

  it("instala dependências Python dentro do release (o job é descartável)", () => {
    // O container de instalação é removido no fim e só /app é montado nele: sem
    // `--user` + PYTHONUSERBASE o pip gravaria em $HOME/.local e o pacote
    // desaparecia, deixando o bot em ModuleNotFoundError no runtime.
    const command = renderInstallCommand(makeApp({ runtime: "python" }), ["bot.py", "requirements.txt"]);
    expect(command).toContain("--user");

    const env = buildEnvironment(makeApp({ runtime: "python" }));
    expect(env).toContain(`PYTHONUSERBASE=${CONTAINER_PYTHON_PACKAGES}`);
    expect(CONTAINER_PYTHON_PACKAGES.startsWith("/app/")).toBe(true);

    // Node instala em ./node_modules, dentro do próprio /app: nada a acrescentar.
    expect(buildEnvironment(makeApp({ runtime: "node" }))).not.toContain(`PYTHONUSERBASE=${CONTAINER_PYTHON_PACKAGES}`);
  });

  it("escapa argumentos com segurança", () => {
    expect(shellQuote("simples.js")).toBe("simples.js");
    expect(shellQuote("com espaco.js")).toBe("'com espaco.js'");
    expect(shellQuote("a'b.js")).toBe(`'a'\\''b.js'`);
  });

  it("valida mapeamentos de porta", () => {
    expect(parsePortMappings(["8080:3000"])).toEqual([{ hostPort: 8080, containerPort: 3000 }]);
    expect(parsePortMappings(["3000"])).toEqual([{ hostPort: 3000, containerPort: 3000 }]);
    expect(parsePortMappings(["0", "99999", "abc"])).toEqual([]);
  });

  it("respeita a lista de imagens permitidas", () => {
    expect(isImageAllowed("node:22-slim", null)).toBe(true);
    expect(isImageAllowed("node:22-slim", ["node:22-slim"])).toBe(true);
    expect(isImageAllowed("ubuntu:24.04", ["node:22-slim"])).toBe(false);
  });
});

describe("métricas de container", () => {
  it("calcula o percentual de CPU como o docker stats", () => {
    const percent = computeCpuPercent({
      cpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 4_000_000_000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 1_000_000_000 }, system_cpu_usage: 2_000_000_000 },
    });
    expect(percent).toBe(200);
  });

  it("retorna zero quando não há variação", () => {
    expect(
      computeCpuPercent({
        cpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 10 },
        precpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 10 },
      }),
    ).toBe(0);
  });

  it("desconta o cache da memória usada", () => {
    const stats = parseStats({
      memory_stats: { usage: 200 * 1024 * 1024, limit: 512 * 1024 * 1024, stats: { inactive_file: 50 * 1024 * 1024 } },
    });
    expect(stats.memoryBytes).toBe(150 * 1024 * 1024);
    expect(stats.memoryPercent).toBeCloseTo(29.3, 1);
  });

  it("traduz o estado do container", () => {
    expect(mapContainerState({ Running: true, Status: "running", StartedAt: "2020-01-01T00:00:00Z" })).toBe("running");
    expect(mapContainerState({ Restarting: true, Status: "restarting" })).toBe("restarting");
    expect(mapContainerState({ Running: false, Status: "exited", ExitCode: 0 })).toBe("stopped");
    expect(mapContainerState({ Running: false, Status: "exited", ExitCode: 1 })).toBe("crashed");
    expect(mapContainerState({ Running: false, Status: "exited", ExitCode: 137, OOMKilled: true })).toBe("crashed");
    expect(mapContainerState(null)).toBe("stopped");
  });

  it("ignora o timestamp vazio do Docker ao calcular uptime", () => {
    // `0001-01-01T00:00:00Z` é o que o daemon devolve quando o container nunca
    // subiu; tratá-lo como data real dava uptimes de centenas de milhares de dias.
    expect(parseDockerTime("0001-01-01T00:00:00Z")).toBeNull();
    expect(parseDockerTime(undefined)).toBeNull();
    expect(parseDockerTime("")).toBeNull();
    expect(parseDockerTime("sem-data")).toBeNull();
    expect(parseDockerTime("2026-09-20T03:23:05.938209809Z")).toBe("2026-09-20T03:23:05.938209809Z");

    // `secondsSince` nunca devolve valor negativo nem o desvio do "zero".
    expect(secondsSince("0001-01-01T00:00:00Z")).toBe(0);
    expect(secondsSince(null)).toBe(0);
    expect(secondsSince(new Date(Date.now() - 60_000).toISOString())).toBeGreaterThanOrEqual(59);
  });

  it("só diz 'parado' quando o usuário pediu para parar", () => {
    // O código de saída 137 é o mesmo para `docker stop` e para um processo
    // morto à força: a intenção registrada é a única forma de distinguir.
    expect(applyStopIntent("crashed", true)).toBe("stopped");
    expect(applyStopIntent("stopped", true)).toBe("stopped");
    // Sem intenção, uma queda continua sendo falha.
    expect(applyStopIntent("crashed", false)).toBe("crashed");
    // Nunca rebaixa um processo que está de pé.
    expect(applyStopIntent("running", true)).toBe("running");
    expect(applyStopIntent("unknown", true)).toBe("unknown");
  });

  it("monta linhas completas a partir de pedaços", () => {
    const lines: string[] = [];
    const buffer = new LineBuffer((line) => lines.push(line));
    buffer.push("primeira\nsegun");
    expect(lines).toEqual(["primeira"]);
    buffer.push("da linha\nterceira\n");
    expect(lines).toEqual(["primeira", "segunda linha", "terceira"]);
    buffer.push("sem quebra");
    buffer.flush();
    expect(lines).toEqual(["primeira", "segunda linha", "terceira", "sem quebra"]);
  });
});

describe("especificação do container", () => {
  it("aplica limites de recursos e isolamento", () => {
    const spec = buildContainerSpec({
      app: makeApp({ memoryMb: 768, cpu: 1.5, pidsLimit: 128 }),
      releasePath: "/data/apps/meu-bot/releases/3",
      sharedPath: "/data/apps/meu-bot/shared",
      runUid: 1000,
      runGid: 1000,
    });

    expect(spec.name).toBe("botpanel-meu-bot");
    expect(spec.hostConfig.Memory).toBe(768 * 1024 * 1024);
    expect(spec.hostConfig.MemorySwap).toBe(768 * 1024 * 1024);
    expect(spec.hostConfig.NanoCpus).toBe(1_500_000_000);
    expect(spec.hostConfig.PidsLimit).toBe(128);
    expect(spec.hostConfig.CapDrop).toEqual(["ALL"]);
    expect(spec.hostConfig.SecurityOpt).toEqual(["no-new-privileges"]);
    expect(spec.hostConfig.RestartPolicy?.Name).toBe("unless-stopped");
    expect(spec.hostConfig.Binds).toEqual([
      "/data/apps/meu-bot/releases/3:/app:rw",
      "/data/apps/meu-bot/shared:/data:rw",
    ]);
    expect(spec.user).toBe("1000:1000");
    expect(spec.cmd).toEqual(["sh", "-c", "exec node index.js"]);
    expect(spec.openStdin).toBe(true);
    expect(spec.labels["botpanel.app"]).toBe("meu-bot");
  });

  it("traduz os dois interruptores para a política de reinício do Docker", () => {
    // Sobe com o sistema + reinicia ao cair: o Docker cuida dos dois casos.
    expect(restartPolicyFor({ autoStart: true, autoRestart: true })).toBe("unless-stopped");
    // Reinicia ao cair, mas não sobe com o sistema: reinicia só em erro.
    expect(restartPolicyFor({ autoStart: false, autoRestart: true })).toBe("on-failure");
    // Sem reinício automático, nunca volta sozinho — quem sobe é o painel, no
    // boot, quando "iniciar junto com o sistema" está ligado.
    expect(restartPolicyFor({ autoStart: true, autoRestart: false })).toBe("no");
    expect(restartPolicyFor({ autoStart: false, autoRestart: false })).toBe("no");
  });

  it("usa a política dos interruptores ao montar o container", () => {
    const build = (overrides: Partial<AppRecord> = {}): string | undefined =>
      buildContainerSpec({
        app: makeApp(overrides),
        releasePath: "/r",
        sharedPath: "/s",
        runUid: 1000,
        runGid: 1000,
      }).hostConfig.RestartPolicy?.Name;

    expect(build({ autoStart: true, autoRestart: true })).toBe("unless-stopped");
    expect(build({ autoStart: true, autoRestart: false })).toBe("no");
    expect(build({ autoStart: false, autoRestart: true })).toBe("on-failure");
  });

  it("marca o container com a instância do painel", () => {
    const spec = buildContainerSpec({
      app: makeApp(),
      releasePath: "/r",
      sharedPath: "/s",
      runUid: 1000,
      runGid: 1000,
      instanceId: "abc123def456",
    });
    expect(spec.labels["botpanel.instance"]).toBe("abc123def456");
  });

  it("injeta variáveis do painel e da aplicação", () => {
    const spec = buildContainerSpec({
      app: makeApp({
        runtime: "python",
        env: [
          { key: "DISCORD_TOKEN", value: "segredo", secret: true },
          { key: "DATA_DIR", value: "/ignorado", secret: false },
        ],
      }),
      releasePath: "/r",
      sharedPath: "/s",
      runUid: 1000,
      runGid: 1000,
    });

    expect(spec.env).toContain("DATA_DIR=/data");
    expect(spec.env).toContain("PYTHONUNBUFFERED=1");
    expect(spec.env).toContain("HOME=/data");
    expect(spec.env).toContain(`PYTHONUSERBASE=${CONTAINER_PYTHON_PACKAGES}`);
    expect(spec.env).toContain("DISCORD_TOKEN=segredo");
    // O painel não deixa a aplicação sobrescrever DATA_DIR.
    expect(spec.env.filter((item) => item.startsWith("DATA_DIR="))).toEqual(["DATA_DIR=/data"]);
  });

  it("usa uma rede Docker dedicada por aplicação", () => {
    const comRede = buildContainerSpec({
      app: makeApp(),
      releasePath: "/r",
      sharedPath: "/s",
      runUid: 1000,
      runGid: 1000,
      networkName: networkNameFor("meu-bot"),
    });
    expect(comRede.hostConfig.NetworkMode).toBe("botpanel-net-meu-bot");

    const semRede = buildContainerSpec({
      app: makeApp(),
      releasePath: "/r",
      sharedPath: "/s",
      runUid: 1000,
      runGid: 1000,
    });
    expect(semRede.hostConfig.NetworkMode).toBe("bridge");
  });

  it("cria mapeamento de portas quando configurado", () => {
    const spec = buildContainerSpec({
      app: makeApp({ ports: ["8080:3000"] }),
      releasePath: "/r",
      sharedPath: "/s",
      runUid: 1000,
      runGid: 1000,
    });

    expect(spec.exposedPorts["3000/tcp"]).toEqual({});
    expect(spec.hostConfig.PortBindings?.["3000/tcp"]).toEqual([{ HostIp: "0.0.0.0", HostPort: "8080" }]);
  });

  it("converte para o formato da API do Docker", () => {
    const spec = buildContainerSpec({
      app: makeApp(),
      releasePath: "/r",
      sharedPath: "/s",
      runUid: 1000,
      runGid: 1000,
    });
    const options = toCreateOptions(spec);
    expect(options.name).toBe("botpanel-meu-bot");
    expect(options.HostConfig?.Memory).toBe(512 * 1024 * 1024);
    expect(options.Labels?.["botpanel.app"]).toBe("meu-bot");
    expect(options.WorkingDir).toBe("/app");
  });

  it("monta o ambiente base sem duplicatas", () => {
    const env = buildEnvironment(makeApp({ env: [{ key: "A", value: "1", secret: false }] }));
    expect(env).toContain("A=1");
    expect(new Set(env.map((item) => item.split("=")[0])).size).toBe(env.length);
  });
});

describe("KeyedMutex", () => {
  it("serializa tarefas da mesma chave", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const slow = mutex.run("a", async () => {
      order.push("inicio-a");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("fim-a");
    });
    const fast = mutex.run("a", async () => {
      order.push("inicio-b");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["inicio-a", "fim-a", "inicio-b"]);
  });

  it("permite paralelismo entre chaves diferentes", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    await Promise.all([
      mutex.run("a", async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("a");
      }),
      mutex.run("b", async () => {
        order.push("b");
      }),
    ]);
    expect(order).toEqual(["b", "a"]);
  });

  it("continua a fila mesmo quando uma tarefa falha", async () => {
    const mutex = new KeyedMutex();
    await expect(
      mutex.run("a", async () => {
        throw new Error("falhou");
      }),
    ).rejects.toThrow("falhou");
    await expect(mutex.run("a", async () => "ok")).resolves.toBe("ok");
  });
});

describe("mascaramento de segredos", () => {
  it("esconde valores sensíveis", () => {
    expect(maskValue("DISCORD_TOKEN", "meutoken123")).not.toContain("token123");
    expect(maskValue("PREFIXO", "!")).toBe("!");
  });
});

describe("identidade da instância do painel", () => {
  it("deriva o id do diretório de dados, de forma estável", () => {
    const id = instanceIdForDataDir("/var/lib/botpanel");
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(instanceIdForDataDir("/var/lib/botpanel")).toBe(id);
    // Dois painéis com diretórios diferentes nunca compartilham o id.
    expect(instanceIdForDataDir("/outro/painel")).not.toBe(id);
  });
});

describe("cliente Docker", () => {
  it("reconhece erros transitórios de socket", () => {
    expect(isTransientDockerError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBe(true);
    expect(isTransientDockerError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isTransientDockerError(new Error("socket hang up"))).toBe(true);
    // Erro real do daemon não deve ser mascarado como transitório.
    expect(isTransientDockerError(Object.assign(new Error("no such container"), { statusCode: 404 }))).toBe(false);
  });

  it("distingue daemon fora do ar de erro da chamada", () => {
    // Comunicação quebrada: a API responde 503 com mensagem clara.
    expect(isDockerUnavailable(Object.assign(new Error("connect ECONNREFUSED /var/run/docker.sock"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isDockerUnavailable(new Error("socket hang up"))).toBe(true);
    // Erro devolvido pela própria API do Docker não é “daemon fora do ar”.
    expect(isDockerUnavailable(Object.assign(new Error("Invalid memory limit"), { statusCode: 500 }))).toBe(false);
    // ...mas continua sendo tratado como transitório para o retry.
    expect(isTransientDockerError(Object.assign(new Error("restart em andamento"), { statusCode: 503 }))).toBe(true);
  });

  it("não reporta aplicações como paradas quando o daemon está inacessível", async () => {
    // Socket inexistente: simula o daemon fora do ar (ou em restart).
    const docker = new DockerService("/tmp/botpanel-socket-inexistente.sock", "teste");

    expect(docker.instanceId).toBe("teste");
    await expect(docker.inspect("qualquer")).rejects.toThrow();
    // O ponto crítico: sem daemon não sabemos o estado — nunca "stopped".
    await expect(docker.status("qualquer")).resolves.toBe("unknown");
    await expect(docker.listManaged()).resolves.toEqual([]);
    await expect(docker.listManagedNetworks()).resolves.toEqual([]);
    await expect(docker.info()).resolves.toMatchObject({ available: false });
  }, 20_000);
});
