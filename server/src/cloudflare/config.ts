import type { Store } from "../db.ts";
import { nowIso } from "../db.ts";
import { redactSecrets } from "../ai/prompt.ts";

/**
 * Cloudflare Tunnel como integração do próprio painel — não é uma aplicação do
 * usuário: nada aqui entra no banco de `apps`, nem aparece em `/api/apps`, nem
 * é tocado pela reconciliação de aplicações (os containers da integração NÃO
 * levam o label `botpanel.app`, que é o que `AppService.reconcile()` procura).
 *
 * O token do túnel é o único segredo desta integração. Ele é guardado na tabela
 * `settings` do banco do painel (mesma estratégia já usada pela chave de IA):
 *
 * - o banco fica no diretório de dados (`0750`, dono root), que é o mesmo lugar
 *   onde já vivem a senha com hash, o segredo de sessão e a chave da IA;
 * - o token NUNCA é devolvido pela API — só `tokenSet` e uma dica mascarada;
 * - o token NUNCA vai para logs, erros, labels, URLs, nomes de container ou
 *   estado do frontend.
 *
 * Não há criptografia em repouso nesta versão: o projeto não tem um cofre de
 * segredos e inventar criptografia com a chave guardada ao lado do dado não
 * protegeria nada. A proteção real é a permissão do diretório de dados e o fato
 * de o token não sair do processo do painel.
 */

/** Imagem usada pelo container do túnel (configuração interna da integração). */
export const CLOUDFLARE_IMAGE = "cloudflare/cloudflared:latest";

/** Nome fixo e identificável do container do túnel. */
export const CLOUDFLARE_CONTAINER_NAME = "botpanel-cloudflared";

/** Chave na tabela `settings`. */
export const CLOUDFLARE_SETTINGS_KEY = "cloudflare.tunnel";

/** Labels que marcam o container como pertencente a esta integração. */
export const CLOUDFLARE_COMPONENT_LABEL = "cloudflare-tunnel";

export interface CloudflareConfig {
  /** Subir o túnel junto com o painel (e mantê-lo de pé). */
  enabled: boolean;
  /** Token do túnel (segredo). Vazio quando ainda não configurado. */
  token: string;
  /** Nome do container (fixo; persistido para diagnóstico). */
  containerName: string;
  /** Id do container conhecido pelo painel (null quando não existe). */
  containerId: string | null;
  /** Imagem do container (fixa nesta versão). */
  image: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** Último erro observado, já redigido. Limpo em uma operação bem-sucedida. */
  lastError: string | null;
  /** Instante da última conexão registrada nos logs do cloudflared. */
  lastConnectedAt: string | null;
}

export function defaultConfig(): CloudflareConfig {
  return {
    enabled: false,
    token: "",
    containerName: CLOUDFLARE_CONTAINER_NAME,
    containerId: null,
    image: CLOUDFLARE_IMAGE,
    createdAt: null,
    updatedAt: null,
    lastError: null,
    lastConnectedAt: null,
  };
}

/** Lê a configuração do banco, tolerando JSON ausente/corrompido. */
export function readConfig(store: Store): CloudflareConfig {
  const raw = store.getSetting(CLOUDFLARE_SETTINGS_KEY);
  if (!raw) return defaultConfig();
  try {
    const parsed = JSON.parse(raw) as Partial<CloudflareConfig>;
    const base = defaultConfig();
    return {
      enabled: parsed.enabled === true,
      // O token nunca vem de outra origem que não seja o próprio banco.
      token: typeof parsed.token === "string" ? parsed.token : "",
      containerName: CLOUDFLARE_CONTAINER_NAME,
      containerId: typeof parsed.containerId === "string" && parsed.containerId ? parsed.containerId : null,
      image: CLOUDFLARE_IMAGE,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      lastError: typeof parsed.lastError === "string" && parsed.lastError ? parsed.lastError : null,
      lastConnectedAt: typeof parsed.lastConnectedAt === "string" ? parsed.lastConnectedAt : null,
    };
  } catch {
    // Banco com JSON inválido (edição manual, escrita interrompida): começa do
    // zero em vez de derrubar a página da integração.
    return defaultConfig();
  }
}

export function writeConfig(store: Store, config: CloudflareConfig): void {
  const payload: CloudflareConfig = {
    ...config,
    containerName: CLOUDFLARE_CONTAINER_NAME,
    image: CLOUDFLARE_IMAGE,
    updatedAt: nowIso(),
  };
  store.setSetting(CLOUDFLARE_SETTINGS_KEY, JSON.stringify(payload));
}

/**
 * Dica do token para a interface: nunca o valor. Segue o mesmo formato da chave
 * de IA (`sk-…4f2a`), que o painel já usa.
 */
export function maskToken(token: string): string {
  if (token.length === 0) return "";
  if (token.length <= 10) return "••••";
  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}

/**
 * Redige um texto que possa conter o token. Duas camadas:
 *
 * 1. o valor exato do token guardado (o que o `cloudflared` poderia ecoar);
 * 2. os padrões genéricos de credencial já usados antes de enviar logs para
 *    provedores de IA — cobre o caso de o token ter sido rotacionado e o log
 *    ainda trazer o valor antigo.
 *
 * É a única função usada antes de qualquer texto sair da integração.
 */
export function redactToken(text: string, token?: string): string {
  let output = text;
  const secret = (token ?? "").trim();
  if (secret.length >= 8) {
    output = output.split(secret).join("<token-redigido>");
    // Um log pode trazer o token quebrado em pedaços por causa do wrap de linha.
    output = output.split(encodeURIComponent(secret)).join("<token-redigido>");
  }
  return redactSecrets(output);
}

export interface TokenValidation {
  ok: boolean;
  /** Código estável para a interface (só quando `ok` é falso). */
  code?: string;
  /** Mensagem em português (fallback da interface). */
  message?: string;
}

/**
 * Validação de forma — deliberadamente NÃO tenta provar que o token é
 * autêntico (isso só o `cloudflared` responde, ao conectar). Aqui só se recusa
 * o que comprovadamente não pode ser um token: vazio, curto demais, com espaços
 * ou caracteres de controle (o que indicaria colagem acidental de outra coisa).
 */
export function validateTokenShape(input: string): TokenValidation {
  const token = input.trim();
  if (token.length === 0) {
    return { ok: false, code: "cloudflare.tokenRequired", message: "Informe o token do túnel." };
  }
  if (token.length < 32) {
    return {
      ok: false,
      code: "cloudflare.tokenInvalid",
      message: "O token do túnel é curto demais — copie o valor completo do Cloudflare Zero Trust.",
    };
  }
  if (token.length > 4096) {
    return {
      ok: false,
      code: "cloudflare.tokenInvalid",
      message: "O token do túnel é longo demais para ser válido.",
    };
  }
  if (/[\s\u0000-\u001f\u007f]/.test(token)) {
    return {
      ok: false,
      code: "cloudflare.tokenInvalid",
      message: "O token do túnel contém espaços ou quebras de linha — cole apenas o valor do token.",
    };
  }
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(token)) {
    return {
      ok: false,
      code: "cloudflare.tokenInvalid",
      message: "O token do túnel contém caracteres inesperados — cole apenas o valor do token.",
    };
  }
  return { ok: true };
}
