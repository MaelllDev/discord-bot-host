import path from "node:path";

/**
 * Layout em disco de cada aplicação:
 *
 *   <dataDir>/apps/<slug>/
 *     releases/<seq>/   código imutável de cada versão publicada
 *     current           link simbólico para o release ativo
 *     shared/           dados persistentes (montado em /data no container)
 */
export function appsDir(dataDir: string): string {
  return path.join(dataDir, "apps");
}

export function appRoot(dataDir: string, slug: string): string {
  return path.join(appsDir(dataDir), slug);
}

export function releasesDir(dataDir: string, slug: string): string {
  return path.join(appRoot(dataDir, slug), "releases");
}

export function releaseDir(dataDir: string, slug: string, seq: number): string {
  return path.join(releasesDir(dataDir, slug), String(seq));
}

export function currentLink(dataDir: string, slug: string): string {
  return path.join(appRoot(dataDir, slug), "current");
}

export function sharedDir(dataDir: string, slug: string): string {
  return path.join(appRoot(dataDir, slug), "shared");
}

/**
 * ZIPs de backup da aplicação. Ficam dentro da pasta dela para que remover a
 * aplicação com "apagar arquivos" leve os backups junto, sem deixar lixo.
 */
export function backupsDir(dataDir: string, slug: string): string {
  return path.join(appRoot(dataDir, slug), "backups");
}

export function tmpDir(dataDir: string): string {
  return path.join(dataDir, "tmp");
}

/** Caminho dentro do container onde o volume persistente é montado. */
export const CONTAINER_DATA_DIR = "/data";

/** Caminho dentro do container onde o código do release é montado. */
export const CONTAINER_APP_DIR = "/app";

/**
 * Onde as dependências Python são instaladas. O container que roda `pip` é
 * descartável e apenas `/app` (o release) é montado nele: pacotes instalados em
 * site-packages ou em `$HOME/.local` desapareceriam junto com o job. Este mesmo
 * caminho é usado como `PYTHONUSERBASE` no runtime, então o Python encontra os
 * pacotes automaticamente (o user site é adicionado ao `sys.path`).
 */
export const CONTAINER_PYTHON_PACKAGES = `${CONTAINER_APP_DIR}/.botpanel-py`;
