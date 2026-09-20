import { z } from "zod";
import { ValidationError } from "../errors.ts";

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    throw new ValidationError("Dados inválidos.", details);
  }
  return result.data;
}

export const envVarSchema = z.object({
  key: z.string().max(128),
  value: z.string().max(8192).default(""),
  secret: z.boolean().default(false),
});

export const runtimeSchema = z.enum(["node", "python", "custom"]);

export const appConfigFields = {
  description: z.string().max(280).optional(),
  iconUrl: z.string().max(500).optional(),
  runtime: runtimeSchema.optional(),
  image: z.string().max(200).optional(),
  entry: z.string().max(260).optional(),
  startCommand: z.string().max(2000).optional(),
  installCommand: z.string().max(2000).optional(),
  depsFile: z.string().max(260).optional(),
  memoryMb: z.number().int().min(64).max(32_768).optional(),
  cpu: z.number().min(0.1).max(16).optional(),
  pidsLimit: z.number().int().min(32).max(4096).optional(),
  env: z.array(envVarSchema).max(200).optional(),
  ports: z.array(z.string().max(20)).max(50).optional(),
  autoStart: z.boolean().optional(),
  autoRestart: z.boolean().optional(),
};

export const createAppSchema = z.object({
  name: z.string().min(2).max(48),
  slug: z.string().max(32).optional(),
  ...appConfigFields,
  // Runtime é obrigatório na criação (o spread acima o deixa opcional).
  runtime: runtimeSchema,
});

export const updateAppSchema = z.object({
  name: z.string().min(2).max(48).optional(),
  ...appConfigFields,
});

export const fileRootSchema = z.enum(["code", "data"]);

/**
 * Configuração de IA. `apiKey` só é tocada quando vem preenchida: a chave nunca
 * é devolvida pela API, então reenviar o formulário sem digitá-la não pode
 * apagá-la — para isso existe `clearApiKey`.
 */
export const aiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.string().max(40).optional(),
  model: z.string().max(120).optional(),
  apiKey: z.string().max(400).optional(),
  baseUrl: z.string().max(300).optional(),
  maxLines: z.number().int().min(20).max(1000).optional(),
  temperature: z.number().min(0).max(1).optional(),
  clearApiKey: z.boolean().optional(),
});

/**
 * Campos do formulário enviados junto com "testar conexão" e "buscar modelos".
 * Sem corpo, a chamada usa a configuração já salva.
 */
export const aiDraftSchema = z.object({
  provider: z.string().max(40).optional(),
  model: z.string().max(120).optional(),
  baseUrl: z.string().max(300).optional(),
  apiKey: z.string().max(400).optional(),
});

export const aiAnalyzeSchema = z.object({
  /** Trecho de log que o usuário está vendo na tela. */
  logs: z.string().max(400_000).default(""),
  question: z.string().max(500).default(""),
});
