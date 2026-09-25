export class AppError extends Error {
  readonly statusCode: number;
  readonly details: unknown;
  /**
   * Código estável de erro para a interface traduzir (`errors.<code>`).
   * O texto (`message`) continua sendo devolvido e continua em português: é o
   * fallback quando o painel não conhece o código.
   */
  readonly code?: string;

  constructor(message: string, statusCode = 500, details?: unknown, code?: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.details = details;
    this.code = code;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown, code?: string) {
    super(message, 400, details, code);
    this.name = "ValidationError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Não autenticado.") {
    super(message, 401, undefined, "auth.unauthorized");
    this.name = "UnauthorizedError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Recurso não encontrado.", code = "common.notFound") {
    super(message, 404, undefined, code);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code?: string) {
    super(message, 409, undefined, code);
    this.name = "ConflictError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
