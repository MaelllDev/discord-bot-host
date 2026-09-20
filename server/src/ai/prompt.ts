/**
 * Padrões de segredo que costumam vazar para o log de um bot (token do Discord,
 * chaves de API, cabeçalhos de autenticação, strings de conexão). Os logs saem da
 * VPS para o provedor de IA escolhido pelo usuário, então o que for claramente
 * uma credencial é mascarado antes do envio.
 */
const SECRET_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  // "Bot <token>", "Bearer <token>", "Authorization: <token>"
  { pattern: /\b(Bot|Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, replacement: "$1 <redigido>" },
  { pattern: /(authorization\s*[:=]\s*)([^\s,;"']{8,})/gi, replacement: "$1<redigido>" },
  // Discord: três partes separadas por ponto, a primeira base64 de 18+ chars.
  { pattern: /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,40}\b/g, replacement: "<token-redigido>" },
  // Chaves com prefixo conhecido (OpenAI, Anthropic, Google, Groq, Slack, GitHub, AWS).
  {
    pattern:
      /\b(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|gsk_[A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g,
    replacement: "<chave-redigida>",
  },
  // Pares chave=valor com nome sugestivo.
  {
    pattern: /((?:api[_-]?key|apikey|secret|token|password|passwd|senha|client[_-]?secret)\s*[:=]\s*)("?)([^\s"',;]{6,})\2/gi,
    replacement: "$1$2<redigido>$2",
  },
  // Credenciais dentro de URL (postgres://user:senha@host).
  { pattern: /([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi, replacement: "$1<redigido>$3" },
  // JSON Web Token.
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: "<jwt-redigido>" },
];

/** Mascara credenciais óbvias no texto antes de enviá-lo a um terceiro. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (current, entry) => current.replace(entry.pattern, entry.replacement),
    text,
  );
}

/** O que o provedor recebe sobre a aplicação — sem variáveis de ambiente. */
export interface AnalysisContext {
  name: string;
  slug: string;
  runtime: string;
  image: string;
  entry: string;
  startCommand: string;
  installCommand: string;
  status: string;
  exitCode: number | null;
  activeRelease: number;
  memoryMb: number;
  cpu: number;
}

const SYSTEM_PROMPT = [
  "Você é um engenheiro de plantão experiente ajudando a diagnosticar um bot/aplicação que roda em um container Docker.",
  "Responda SEMPRE em português do Brasil, direto ao ponto, sem introdução e sem repetir o log.",
  "Formato da resposta (use exatamente estes títulos, em markdown):",
  "## Resumo",
  "Uma ou duas frases dizendo o que está acontecendo.",
  "## Causa provável",
  "O que mais provavelmente explica o comportamento, com a evidência do log que sustenta isso.",
  "## Como corrigir",
  "Passos concretos e numerados. Cite arquivos, comandos e configurações quando fizer sentido.",
  "## Verificar depois",
  "O que observar para confirmar que o problema foi resolvido.",
  "Regras: não invente arquivos, dependências ou configurações que não apareçam no log ou no contexto;",
  "se a evidência for insuficiente, diga o que falta e qual informação você precisaria;",
  "quando houver mais de uma hipótese plausível, ordene por probabilidade;",
  "valores como <redigido> foram mascarados de propósito — não tente adivinhá-los.",
].join("\n");

/**
 * Monta o prompt. O contexto vai em texto simples (nada de JSON cru) porque
 * modelos pequenos respondem melhor assim, e o log fica delimitado para não ser
 * confundido com instruções.
 */
export function buildPrompt(
  context: AnalysisContext,
  logExcerpt: string,
  question: string,
): { system: string; user: string } {
  const lines: string[] = [
    "Contexto da aplicação:",
    `- nome: ${context.name} (${context.slug})`,
    `- runtime: ${context.runtime} · imagem: ${context.image}`,
    `- arquivo principal: ${context.entry || "definido pelo comando de start"}`,
    `- comando de start: ${context.startCommand || "(usa o arquivo principal)"}`,
    `- comando de instalação: ${context.installCommand || "(nenhum)"}`,
    `- estado atual do container: ${context.status}${context.exitCode === null ? "" : ` (código de saída ${context.exitCode})`}`,
    `- versão ativa: ${context.activeRelease > 0 ? `v${context.activeRelease}` : "nenhuma publicada"}`,
    `- limites: ${context.memoryMb} MB de RAM, ${context.cpu} vCPU`,
    "",
    "Saída do console (últimas linhas, do mais antigo para o mais recente):",
    "```",
    logExcerpt,
    "```",
  ];

  if (question.trim().length > 0) {
    lines.push("", "Pergunta específica do administrador:", question.trim());
  } else {
    lines.push("", "Explique o que está errado neste bot e como corrigir.");
  }

  return { system: SYSTEM_PROMPT, user: lines.join("\n") };
}

/** Recorta a cauda do log e garante um teto de caracteres. */
export function tailExcerpt(logText: string, maxLines: number, maxChars = 48_000): string {
  const lines = logText.split(/\r?\n/).filter((line) => line.length > 0);
  let excerpt = lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
  if (excerpt.length > maxChars) excerpt = excerpt.slice(excerpt.length - maxChars);
  return excerpt;
}
