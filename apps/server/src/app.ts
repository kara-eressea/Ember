import fastifyCors from "@fastify/cors";
import fastifyRateLimit from "@fastify/rate-limit";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { trustProxyValue, type AppConfig } from "./config.js";
import type { Db } from "./db/index.js";
import { authRoutes } from "./modules/auth/routes.js";
import { FlistApiClient } from "./modules/flist-api/api-client.js";
import { TicketManagerRegistry } from "./modules/flist-api/ticket-manager.js";
import { flistAccountsRoutes } from "./modules/flist-accounts/routes.js";
import { CredentialVault } from "./modules/flist-accounts/vault.js";
import { SessionRegistry } from "./modules/session-engine/registry.js";
import { authPlugin } from "./plugins/auth.js";

declare module "fastify" {
  interface FastifyInstance {
    sessions: SessionRegistry;
  }
}

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  logger?: FastifyServerOptions["logger"];
  /** Injectable for tests (e.g. a client with no request throttle). */
  flistApiClient?: FlistApiClient;
}

export async function buildApp({
  config,
  db,
  logger = true,
  flistApiClient,
}: BuildAppOptions): Promise<FastifyInstance> {
  // Without the right trustProxy, every client behind a reverse proxy shares
  // the proxy's IP and the per-IP rate limits become one global bucket.
  const app = Fastify({
    logger,
    trustProxy: trustProxyValue(config.TRUST_PROXY),
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const vault = new CredentialVault();
  const flistApi =
    flistApiClient ?? new FlistApiClient({ baseUrl: config.FLIST_API_URL });
  const tickets = new TicketManagerRegistry(flistApi, vault);
  const sessions = new SessionRegistry({
    tickets,
    wsUrl: config.FCHAT_URL,
    clientName: config.CLIENT_NAME,
    clientVersion: config.CLIENT_VERSION,
    logger: app.log,
  });
  app.decorate("sessions", sessions);
  app.addHook("onClose", () => {
    sessions.stopAll();
  });

  await app.register(fastifyCors, {
    origin: config.CORS_ORIGIN ? config.CORS_ORIGIN.split(",") : false,
  });
  // Global backstop; the auth endpoints set stricter per-route limits.
  await app.register(fastifyRateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(authPlugin, { secret: config.AUTH_SECRET, db });
  await app.register(authRoutes, {
    prefix: "/api/auth",
    db,
    rateLimitMax: config.AUTH_RATE_LIMIT_MAX,
  });
  await app.register(flistAccountsRoutes, {
    prefix: "/api/flist-accounts",
    db,
    vault,
    tickets,
  });

  app.get("/healthz", () => ({ status: "ok" }));

  return app;
}
