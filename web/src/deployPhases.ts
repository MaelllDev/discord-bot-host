/**
 * As etapas abaixo são derivadas do log que o backend realmente grava no
 * deployment (ver `runDeploy` em server/src/apps/service.ts). Não há etapas
 * inventadas: cada marcador corresponde a uma linha real do log.
 *
 * ATENÇÃO: os marcadores (`done`/`active`) casam com o texto do log do backend,
 * que é escrito em português e não acompanha o idioma da interface. Só o
 * `titleKey` é traduzido.
 */
export interface DeployPhase {
  /** Chave da mensagem com o nome da etapa. */
  titleKey: string;
  /** Marcadores que, quando presentes no log, indicam que a etapa foi concluída. */
  done: string[];
  /** Marcadores que indicam que a etapa está em andamento. */
  active: string[];
}

import { tActive } from "./i18n/language.ts";

export const DEPLOY_PHASES: DeployPhase[] = [
  {
    titleKey: "deploy.extracting",
    done: ["✓", "arquivo(s)"],
    active: ["Extraindo pacote"],
  },
  {
    titleKey: "deploy.detecting",
    done: ["Runtime detectado"],
    active: ["Extraindo pacote"],
  },
  {
    titleKey: "deploy.installing",
    done: ["Dependências instaladas", "instalação ignorada"],
    active: ["Instalando dependências"],
  },
  {
    titleKey: "deploy.creating",
    done: ["Container iniciado", "publicado e em execução"],
    active: ["Criando rede isolada", "Container", "criado"],
  },
  {
    titleKey: "deploy.starting",
    done: ["publicado e em execução"],
    active: ["Ativando release"],
  },
  {
    titleKey: "deploy.done",
    done: ["publicado e em execução"],
    active: [],
  },
];

export function contains(log: string, markers: string[]): boolean {
  return markers.some((marker) => log.includes(marker));
}

export type PhaseState = "done" | "active" | "pending";

/** Estado de cada etapa a partir do log atual do deployment. */
export function phaseStates(log: string, finished: boolean, failed: boolean): PhaseState[] {
  const states: PhaseState[] = DEPLOY_PHASES.map(() => "pending");
  let firstPending = -1;

  DEPLOY_PHASES.forEach((phase, index) => {
    if (contains(log, phase.done)) {
      states[index] = "done";
      return;
    }
    if (firstPending === -1) firstPending = index;
  });

  // Nunca marca duas etapas como "em andamento": a primeira pendente assume o
  // papel quando o deploy está rodando.
  if (!finished && firstPending !== -1) states[firstPending] = "active";
  if (failed && firstPending !== -1) states[firstPending] = "active";
  return states;
}

/** Etapa em que o deploy parou, para mensagens de erro. */
export function currentPhaseLabel(log: string, finished: boolean, failed: boolean): string {
  const states = phaseStates(log, finished, failed);
  const index = states.findIndex((state) => state !== "done");
  const phase = DEPLOY_PHASES[index === -1 ? DEPLOY_PHASES.length - 1 : index];
  return tActive(phase ? phase.titleKey : "deploy.processing");
}
