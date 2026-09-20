import path from "node:path";
import { instanceIdForDataDir } from "../../src/config.ts";
import type { PanelConfig } from "../../src/config.ts";

export function testConfig(dataDir: string, overrides: Partial<PanelConfig> = {}): PanelConfig {
  return {
    panelName: "BotPanel Teste",
    host: "127.0.0.1",
    port: 0,
    dataDir,
    instanceId: instanceIdForDataDir(dataDir),
    // Socket inexistente: os testes de API rodam sem Docker.
    dockerSocket: path.join(dataDir, "docker-inexistente.sock"),
    password: "senha-de-teste",
    passwordHash: null,
    sessionSecret: "segredo-de-teste-com-tamanho-suficiente",
    sessionTtlMs: 3_600_000,
    runUid: 1000,
    runGid: 1000,
    maxUploadBytes: 32 * 1024 * 1024,
    publicDir: null,
    cookieSecure: false,
    allowedImages: null,
    keepReleases: 10,
    ...overrides,
  };
}

export interface MultipartBody {
  payload: Buffer;
  headers: Record<string, string>;
}

/** Monta um corpo multipart/form-data simples para o `server.inject`. */
export function multipartBody(
  file: { field: string; filename: string; content: Buffer; contentType?: string },
  fields: Record<string, string> = {},
): MultipartBody {
  const boundary = `----botpanel${Date.now().toString(36)}`;
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        "utf8",
      ),
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType ?? "application/zip"}\r\n\r\n`,
      "utf8",
    ),
    file.content,
    Buffer.from("\r\n", "utf8"),
    Buffer.from(`--${boundary}--\r\n`, "utf8"),
  );

  return {
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}
