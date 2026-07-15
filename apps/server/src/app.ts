import fastifyCors from "@fastify/cors";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyWebsocket from "@fastify/websocket";
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
import { DetachedAway } from "./modules/away/detached-away.js";
import {
  ChannelDirectory,
  type ChannelDirectoryOptions,
} from "./modules/directory/directory.js";
import { directoryRoutes } from "./modules/directory/routes.js";
import { FlistApiClient } from "./modules/flist-api/api-client.js";
import { TicketManagerRegistry } from "./modules/flist-api/ticket-manager.js";
import { flistAccountsRoutes } from "./modules/flist-accounts/routes.js";
import { CredentialVault } from "./modules/flist-accounts/vault.js";
import { GatewayHub, gatewayRoutes } from "./modules/gateway/gateway.js";
import { HighlightMatcher } from "./modules/highlights/matcher.js";
import { highlightsRoutes } from "./modules/highlights/routes.js";
import { historyRoutes } from "./modules/history/routes.js";
import { identitiesRoutes } from "./modules/identities/routes.js";
import { RetentionJob } from "./modules/history/retention.js";
import { HistorySink } from "./modules/history/sink.js";
import { Outbox } from "./modules/outbox/outbox.js";
import {
  SessionRegistry,
  type SessionTuning,
} from "./modules/session-engine/registry.js";
import { authPlugin } from "./plugins/auth.js";
import { webStatic } from "./plugins/web-static.js";

declare module "fastify" {
  interface FastifyInstance {
    sessions: SessionRegistry;
    history: HistorySink;
    outbox: Outbox;
    detachedAway: DetachedAway;
    directory: ChannelDirectory;
  }
}

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  logger?: FastifyServerOptions["logger"];
  /** Injectable for tests (e.g. a client with no request throttle). */
  flistApiClient?: FlistApiClient;
  /** Test-only session timing knobs; production always runs policy defaults. */
  sessionTuning?: SessionTuning;
  /** Test-only clock for the detached-away sweep. */
  detachedAwayNow?: () => number;
  /** Test-only directory cooldown/timeout knobs. */
  directoryTuning?: ChannelDirectoryOptions;
}

export async function buildApp({
  config,
  db,
  logger = true,
  flistApiClient,
  sessionTuning,
  detachedAwayNow,
  directoryTuning,
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
  const highlights = new HighlightMatcher(db, app.log);
  const history = new HistorySink(db, app.log, { highlights });
  const hub = new GatewayHub({ history, logger: app.log });
  const directory = new ChannelDirectory(
    db,
    app.log,
    process.env.NODE_ENV === "test" ? directoryTuning : undefined,
  );
  const sessions = new SessionRegistry({
    tickets,
    wsUrl: config.FCHAT_URL,
    clientName: config.CLIENT_NAME,
    clientVersion: config.CLIENT_VERSION,
    logger: app.log,
    // Hard gate, not just wiring discipline: the 10s backoff floor is
    // developer policy, so timing knobs are inert outside the test runner.
    tuning: process.env.NODE_ENV === "test" ? sessionTuning : undefined,
    onSessionStarted: (identityId, session) => {
      // History first: message.new fan-out happens post-persistence via the
      // sink's bus, so the sink must see every command the hub translates.
      history.attach(identityId, session);
      hub.attachSession(identityId, session);
      directory.attach(session);
    },
  });
  app.decorate("sessions", sessions);
  app.decorate("history", history);
  app.decorate("directory", directory);
  const outbox = new Outbox({ db, sessions, hub, logger: app.log });
  outbox.start();
  app.decorate("outbox", outbox);
  const retention = new RetentionJob({
    db,
    policy: config.RETENTION_POLICY,
    sweepIntervalMs: config.RETENTION_SWEEP_INTERVAL_MS,
    logger: app.log,
  });
  retention.start();
  const detachedAway = new DetachedAway({
    db,
    sessions,
    hub,
    logger: app.log,
    now: process.env.NODE_ENV === "test" ? detachedAwayNow : undefined,
  });
  hub.onFirstSubscribe = (identityId) => {
    detachedAway.onAttach(identityId);
  };
  detachedAway.start();
  app.decorate("detachedAway", detachedAway);
  app.addHook("onClose", () => {
    detachedAway.stop();
    retention.stop();
    outbox.stop();
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
    sessions,
    history,
    hub,
    // Same knob as the auth endpoints: these routes hold F-List credentials
    // and consume the process-wide F-List API throttle.
    rateLimitMax: config.AUTH_RATE_LIMIT_MAX,
  });
  await app.register(historyRoutes, { prefix: "/api/identities", db });
  await app.register(directoryRoutes, {
    prefix: "/api/identities",
    db,
    sessions,
    directory,
  });
  await app.register(highlightsRoutes, {
    prefix: "/api/highlight-rules",
    db,
    highlights,
  });
  await app.register(identitiesRoutes, {
    prefix: "/api/identities",
    db,
    sessions,
    tickets,
    hub,
    history,
  });
  // Gateway frames are tiny; without a cap the ws default (100 MiB) lets a
  // pre-hello client force huge buffers + JSON.parse work.
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 128 * 1024 },
  });
  await app.register(gatewayRoutes, {
    db,
    sessions,
    history,
    hub,
    outbox,
    highlights,
  });

  app.get("/healthz", () => ({ status: "ok" }));

  if (config.WEB_DIST !== undefined) {
    await app.register(webStatic, {
      root: config.WEB_DIST,
      appName: config.APP_NAME,
    });
  }

  return app;
}
