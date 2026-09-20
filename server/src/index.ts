import { loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";
import { errorMessage } from "./errors.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const { server, context } = await buildServer(config);

  const docker = await context.docker.info();
  if (!docker.available) {
    server.log.error(
      `Docker não está acessível em "${config.dockerSocket}". Instale o Docker e confirme o socket antes de usar o painel.`,
    );
  } else {
    server.log.info(`Docker conectado (versão ${docker.version ?? "?"}, ${docker.containers} containers).`);
  }

  await context.apps
    .reconcile()
    .then((removed) => {
      if (removed.containers.length > 0 || removed.networks.length > 0) {
        server.log.info(
          `Reconcile: removidos ${removed.containers.length} container(s) e ${removed.networks.length} rede(s) órfãos`,
        );
      }
    })
    .catch((error: unknown) => {
      server.log.warn(`Falha ao reconciliar containers: ${errorMessage(error)}`);
    });

  await server.listen({ host: config.host, port: config.port });

  // Sobe em segundo plano as aplicações marcadas com "iniciar junto com o
  // sistema": o painel fica disponível na hora e os containers entram no ar em
  // seguida. O que o usuário parou de propósito não é tocado.
  void context.apps
    .startAutoApps()
    .then((summary) => {
      if (summary.started.length > 0) {
        server.log.info(`Iniciar junto com o sistema: ${summary.started.join(", ")}`);
      }
      if (summary.policies.length > 0) {
        server.log.info(`Política de reinício sincronizada: ${summary.policies.join(", ")}`);
      }
      for (const failure of summary.failed) {
        server.log.warn(`Falha ao iniciar ${failure.slug}: ${failure.error}`);
      }
    })
    .catch((error: unknown) => {
      server.log.warn(`Falha na inicialização automática das aplicações: ${errorMessage(error)}`);
    });

  if (context.password.generated) {
    server.log.warn(`Senha inicial gerada: ${context.password.generated}`);
    server.log.warn(`Defina BOTPANEL_PASSWORD no serviço e reinicie para trocar a senha (arquivo ${config.dataDir}/.initial-password).`);
  }

  server.log.info(`Dados em ${config.dataDir} (instância ${config.instanceId})`);
  server.log.info(`Imagens de runtime permitidas: ${config.allowedImages?.join(", ") ?? "todas"}`);

  const cleanupTimer = setInterval(
    () => {
      void context.uploads.cleanup();
    },
    15 * 60 * 1000,
  );
  cleanupTimer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info(`Recebido ${signal}, encerrando...`);
    clearInterval(cleanupTimer);
    try {
      await server.close();
      context.store.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    server.log.error(`Promise rejeitada sem tratamento: ${errorMessage(reason)}`);
  });
}

main().catch((error: unknown) => {
  console.error("Falha ao iniciar o painel:", errorMessage(error));
  process.exit(1);
});
