import fastifyCors from "@fastify/cors";
import fastifyRateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/index.js";
import { authRoutes } from "./modules/auth/routes.js";
import { authPlugin } from "./plugins/auth.js";

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  logger?: boolean;
}

export async function buildApp({
  config,
  db,
  logger = true,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifyCors, {
    origin: config.CORS_ORIGIN ? config.CORS_ORIGIN.split(",") : false,
  });
  // Global backstop; the auth endpoints set stricter per-route limits.
  await app.register(fastifyRateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(authPlugin, { secret: config.AUTH_SECRET });
  await app.register(authRoutes, {
    prefix: "/api/auth",
    db,
    rateLimitMax: config.AUTH_RATE_LIMIT_MAX,
  });

  app.get("/healthz", () => ({ status: "ok" }));

  return app;
}
