export type RuntimeKind = "node" | "python" | "custom";

/**
 * Política de reinício do container. É a expressão, no Docker, dos dois
 * interruptores da aplicação:
 *
 * - `unless-stopped` — reinicia sozinho quando o processo morre **e** volta
 *   quando a VPS/daemon reinicia (o Docker faz as duas coisas sozinho).
 * - `on-failure` — reinicia sozinho quando o processo termina com erro, mas
 *   **não** volta sozinho depois de reiniciar o daemon.
 * - `no` — nunca reinicia sozinho. Significa que "iniciar junto com o sistema"
 *   fica por conta do painel, que sobe a aplicação quando ele próprio inicia.
 */
export type RestartPolicy = "unless-stopped" | "on-failure" | "no";

export type AppStatus =
  | "running"
  | "starting"
  | "restarting"
  | "paused"
  | "stopped"
  | "crashed"
  | "deploying"
  | "unknown";

export interface EnvVar {
  key: string;
  value: string;
  /** Marca o valor como sensível (fica mascarado na interface). */
  secret: boolean;
}

export interface AppRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  /**
   * URL (http/https) de uma imagem usada como ícone da aplicação no painel.
   * Vazia significa usar o ícone padrão derivado do runtime.
   */
  iconUrl: string;
  runtime: RuntimeKind;
  image: string;
  /** Arquivo principal que inicia a aplicação (ex.: index.js, main.py). */
  entry: string;
  /** Comando de start explícito; quando vazio é derivado do runtime + entry. */
  startCommand: string;
  /** Comando de instalação de dependências; quando vazio é derivado do runtime. */
  installCommand: string;
  /** Arquivo de dependências (package.json, requirements.txt...). */
  depsFile: string;
  memoryMb: number;
  cpu: number;
  pidsLimit: number;
  env: EnvVar[];
  /** Mapeamentos "portaHost:portaContainer". */
  ports: string[];
  /** Sobe sozinha quando a VPS (e o painel) reinicia. */
  autoStart: boolean;
  /**
   * Reinicia sozinha quando o processo termina com erro (o bot cai e volta, em
   * vez de ficar parado esperando alguém apertar Iniciar).
   */
  autoRestart: boolean;
  /**
   * O usuário parou a aplicação pelo painel. Sem isso não é possível
   * distinguir "parada de propósito" de um processo morto com SIGKILL: o
   * Docker reporta o mesmo código de saída (137) nos dois casos.
   */
  stoppedByUser: boolean;
  /** Sequência do release ativo (0 = nenhum release publicado). */
  activeRelease: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseRecord {
  id: number;
  appId: string;
  seq: number;
  dir: string;
  image: string;
  entry: string;
  startCommand: string;
  installCommand: string;
  notes: string;
  sizeBytes: number;
  createdAt: string;
}

export type DeploymentStatus = "running" | "success" | "failed";

export interface DeploymentRecord {
  id: number;
  appId: string;
  releaseSeq: number | null;
  kind: string;
  status: DeploymentStatus;
  log: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface ContainerResources {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  pids: number;
  uptimeSeconds: number;
  startedAt: string | null;
  exitCode: number | null;
  status: AppStatus;
}

export type BackupStatus = "running" | "success" | "failed";

/**
 * Um snapshot baixável da aplicação: código do release ativo (sem as pastas de
 * dependências, que são reproduzíveis) e, opcionalmente, o volume `/data`.
 */
export interface BackupRecord {
  id: number;
  appId: string;
  fileName: string;
  /** Caminho absoluto do ZIP no host. */
  path: string;
  sizeBytes: number;
  status: BackupStatus;
  /** Resumo do conteúdo ou a mensagem de erro. */
  message: string;
  releaseSeq: number | null;
  includeData: boolean;
  createdAt: string;
  finishedAt: string | null;
}

export type AiAnalysisStatus = "running" | "success" | "failed";

/**
 * Visão segura da configuração de IA. A chave nunca sai do servidor: a API
 * devolve apenas se ela existe e uma dica mascarada para o usuário reconhecê-la.
 */
export interface AiSettingsView {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  maxLines: number;
  temperature: number;
  apiKeySet: boolean;
  /** Ex.: `sk-…4f2a`. Vazia quando não há chave. */
  apiKeyHint: string;
}

/** Uma análise de logs feita por IA, com o trecho exato que foi enviado. */
export interface AiAnalysisRecord {
  id: number;
  appId: string;
  appSlug: string;
  provider: string;
  model: string;
  status: AiAnalysisStatus;
  question: string;
  lineCount: number;
  /** Trecho já redigido (sem credenciais) enviado ao provedor. */
  excerpt: string;
  result: string;
  error: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface AppSummary extends AppRecord {
  status: AppStatus;
  resources: ContainerResources | null;
  releaseCount: number;
  diskBytes: number;
}

/**
 * Informações somente-leitura do painel, do host e da configuração efetiva.
 * Nada aqui é necessário para operar as aplicações: é a base das telas de
 * Sistema e Configurações do painel web.
 */
export interface SystemInfo {
  panelName: string;
  dataDir: string;
  panel: {
    version: string | null;
    nodeVersion: string;
    startedAt: string;
    uptimeSeconds: number;
  };
  host: {
    platform: string;
    release: string;
    arch: string;
    cpuModel: string | null;
    cpuCount: number;
    loadAverage: [number, number, number];
    memoryTotalBytes: number;
    memoryFreeBytes: number;
    disk: {
      path: string;
      totalBytes: number;
      freeBytes: number;
      usedBytes: number;
    } | null;
  };
  config: {
    host: string;
    port: number;
    dockerSocket: string;
    allowedImages: string[] | null;
    keepReleases: number;
    sessionTtlHours: number;
    cookieSecure: boolean;
    maxUploadMb: number;
    runUid: number;
    runGid: number;
    instanceId: string;
  };
  docker: {
    available: boolean;
    version: string | null;
    apiVersion: string | null;
    /** `null` quando o daemon está inacessível — 0 seria informação falsa. */
    containers: number | null;
  };
  apps: {
    total: number;
    /** `null` quando o Docker está inacessível e o estado real é desconhecido. */
    running: number | null;
  };
  images: string[];
}
