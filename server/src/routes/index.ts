import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { registerAuthRoutes } from "./auth.ts";
import { registerAppRoutes } from "./apps.ts";
import { registerFileRoutes } from "./files.ts";
import { registerSystemRoutes } from "./system.ts";
import { registerAiRoutes } from "./ai.ts";
import { registerBrandingRoutes } from "./branding.ts";
import { registerNotifyRoutes } from "./notify.ts";
import { registerStreamRoute } from "../ws/stream.ts";

export function registerRoutes(server: FastifyInstance, context: AppContext): void {
  registerAuthRoutes(server, context);
  registerBrandingRoutes(server, context);
  registerSystemRoutes(server, context);
  registerAppRoutes(server, context);
  registerFileRoutes(server, context);
  registerAiRoutes(server, context);
  registerNotifyRoutes(server, context);
  registerStreamRoute(server, context);
}
