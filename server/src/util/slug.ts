/** Nomes reservados que não podem virar slug de aplicação. */
const RESERVED = new Set(["api", "app", "apps", "admin", "static", "assets", "health", "panel", "botpanel", "ws"]);

/**
 * Converte um nome livre em slug seguro para nome de diretório e URL.
 * Remove acentos, troca qualquer caractere inválido por "-" e limita o tamanho.
 */
export function slugify(input: string): string {
  const normalized = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const trimmed = normalized.slice(0, 32).replace(/-+$/g, "");
  return trimmed.length >= 2 ? trimmed : "";
}

/** Valida um slug já formado. */
export function isValidSlug(slug: string): boolean {
  if (slug.length < 2 || slug.length > 32) return false;
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) return false;
  if (slug.includes("--")) return false;
  if (RESERVED.has(slug)) return false;
  return true;
}

/** Gera um slug único a partir de um nome, evitando colisões com slugs existentes. */
export function uniqueSlug(name: string, isTaken: (slug: string) => boolean): string {
  const base = slugify(name) || "app";
  if (!isTaken(base) && isValidSlug(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base.slice(0, 28)}-${index}`;
    if (!isTaken(candidate) && isValidSlug(candidate)) return candidate;
  }
  throw new Error(`Não foi possível gerar um identificador único para "${name}"`);
}
