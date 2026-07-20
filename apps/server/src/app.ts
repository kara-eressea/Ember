import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
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
import { adsRoutes } from "./modules/ads/routes.js";
import { authRoutes } from "./modules/auth/routes.js";
import { CampaignScheduler } from "./modules/campaigns/scheduler.js";
import { ratingsRoutes } from "./modules/ratings/routes.js";
import { SessionJanitor } from "./modules/auth/session-janitor.js";
import { DetachedAway } from "./modules/away/detached-away.js";
import {
  ChannelDirectory,
  type ChannelDirectoryOptions,
} from "./modules/directory/directory.js";
import { directoryRoutes } from "./modules/directory/routes.js";
import { socialRoutes } from "./modules/social/routes.js";
import { FlistApiClient } from "./modules/flist-api/api-client.js";
import { CharacterDataBudget } from "./modules/flist-api/character-data-budget.js";
import { TicketManagerRegistry } from "./modules/flist-api/ticket-manager.js";
import { EiconIndexService } from "./modules/eicons/index-service.js";
import { eiconsRoutes } from "./modules/eicons/routes.js";
import { ProfileService } from "./modules/profiles/service.js";
import { profilesRoutes } from "./modules/profiles/routes.js";
import { resumeStoredSessions } from "./modules/flist-accounts/boot-resume.js";
import { CredentialStore } from "./modules/flist-accounts/credential-store.js";
import { flistAccountsRoutes } from "./modules/flist-accounts/routes.js";
import { CredentialVault } from "./modules/flist-accounts/vault.js";
import { GatewayHub, gatewayRoutes } from "./modules/gateway/gateway.js";
import { UpdateChecker } from "./modules/meta/update-check.js";
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
  /** Injectable for tests (drain/inspect the profile budget). */
  characterDataBudget?: CharacterDataBudget;
}

export async function buildApp({
  config,
  db,
  logger = true,
  flistApiClient,
  sessionTuning,
  detachedAwayNow,
  directoryTuning,
  characterDataBudget,
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
  const credentialStore = new CredentialStore({
    db,
    key: config.CREDENTIALS_KEY,
    logger: app.log,
  });
  const flistApi =
    flistApiClient ??
    new FlistApiClient({
      baseUrl: config.FLIST_API_URL,
      minRequestIntervalMs: config.FLIST_API_MIN_INTERVAL_MS,
    });
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
    disconnectAfterMs: config.DETACHED_DISCONNECT_HOURS * 3_600_000,
    now: process.env.NODE_ENV === "test" ? detachedAwayNow : undefined,
  });
  hub.onFirstSubscribe = (identityId) => {
    detachedAway.onAttach(identityId);
  };
  detachedAway.start();
  app.decorate("detachedAway", detachedAway);
  const sessionJanitor = new SessionJanitor({ db, logger: app.log });
  sessionJanitor.start();
  const updates = new UpdateChecker({
    currentVersion: config.CLIENT_VERSION,
    repo: config.UPDATE_CHECK_REPO,
    // Test runs never phone home, whatever the config says.
    enabled: config.UPDATE_CHECK_ENABLED && process.env.NODE_ENV !== "test",
    logger: app.log,
  });
  updates.start();
  // Ad-rotation campaigns (M11): resumes persisted campaigns and runs the
  // conservative posting schedule. Attached-only gating rides the hub.
  const campaignScheduler = new CampaignScheduler({
    db,
    sessions,
    hub,
    history,
    logger: app.log,
    // Test-only shrunken timings (config guards them against real F-Chat).
    tickMs: config.CAMPAIGN_TICK_MS,
    baseIntervalMs: config.CAMPAIGN_BASE_INTERVAL_MS,
    startJitterMs: config.CAMPAIGN_START_JITTER_MS,
    intervalJitterMs: config.CAMPAIGN_INTERVAL_JITTER_MS,
    spacingMs: config.CAMPAIGN_SPACING_MS,
  });
  await campaignScheduler.start();
  app.addHook("onClose", () => {
    updates.stop();
    sessionJanitor.stop();
    detachedAway.stop();
    retention.stop();
    outbox.stop();
    campaignScheduler.stop();
    sessions.stopAll();
  });

  // Security headers (M7 exposure hardening). The CSP only matters when this
  // process serves the SPA (WEB_DIST) — in API-only/dev mode Vite serves the
  // pages and a CSP here would just decorate JSON. Note on CSRF: auth is a
  // bearer token in the Authorization header (no cookies anywhere), so
  // cross-site requests never carry credentials — no CSRF tokens needed;
  // revisit if cookie auth ever lands.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy:
      config.WEB_DIST !== undefined
        ? {
            directives: {
              "default-src": ["'self'"],
              "script-src": ["'self'"],
              // React style attributes need inline styles allowed.
              "style-src": ["'self'", "'unsafe-inline'"],
              // Avatars/eicons hotlink from F-List's static host (§6/§8).
              "img-src": ["'self'", "data:", "https://static.f-list.net"],
              "connect-src": ["'self'"],
              "font-src": ["'self'"],
              "object-src": ["'none'"],
              "frame-ancestors": ["'none'"],
              "base-uri": ["'self'"],
              "form-action": ["'self'"],
            },
          }
        : false,
    // F-List's static host serves images without CORP headers; embedder
    // policies would block them, so keep the helmet defaults that allow
    // plain cross-origin subresource loads.
    crossOriginEmbedderPolicy: false,
  });
  await app.register(fastifyCors, {
    origin: config.CORS_ORIGIN ? config.CORS_ORIGIN.split(",") : false,
  });
  // Global backstop; the auth endpoints set stricter per-route limits.
  await app.register(fastifyRateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: "1 minute",
  });
  await app.register(authPlugin, { secret: config.AUTH_SECRET, db });
  await app.register(authRoutes, {
    prefix: "/api/auth",
    db,
    rateLimitMax: config.AUTH_RATE_LIMIT_MAX,
    registrationEnabled: config.REGISTRATION_ENABLED,
  });
  await app.register(flistAccountsRoutes, {
    prefix: "/api/flist-accounts",
    db,
    vault,
    store: credentialStore,
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
  await app.register(socialRoutes, {
    prefix: "/api/identities",
    db,
    sessions,
    tickets,
    flistApi,
  });
  const profiles = new ProfileService({
    db,
    flistApi,
    tickets,
    budget:
      characterDataBudget ??
      new CharacterDataBudget({
        limit: config.CHARACTER_DATA_BUDGET_PER_HOUR,
      }),
    sessions,
    logger: app.log,
    cacheTtlMs: config.PROFILE_CACHE_TTL_MS,
    mappingsTtlMs: config.FLIST_MAPPINGS_TTL_MS,
  });
  await app.register(profilesRoutes, {
    prefix: "/api/identities",
    db,
    profiles,
  });
  const eicons = new EiconIndexService({
    db,
    baseUrl: config.EICON_INDEX_BASE_URL,
    refreshMs: config.EICON_INDEX_REFRESH_MS,
    logger: app.log,
  });
  await app.register(eiconsRoutes, { prefix: "/api/eicons", db, eicons });
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
  await app.register(adsRoutes, { prefix: "/api/identities", db, hub });
  await app.register(ratingsRoutes, { prefix: "/api/ad-ratings", db });
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
    campaigns: campaignScheduler,
    // Browsers may open the gateway from the app's own origin or any
    // configured CORS origin; anything else is a hostile page. The two
    // loopback spellings are treated as one so a local `docker compose up`
    // works whether the operator opens 127.0.0.1 or localhost (they resolve
    // to the same socket and neither is a meaningful trust boundary).
    allowedOrigins: [
      ...loopbackAliases(new URL(config.APP_BASE_URL).origin),
      ...(config.CORS_ORIGIN?.split(",").map((origin) => origin.trim()) ?? []),
    ],
  });

  // Liveness probe — unauthenticated on purpose, so it must not disclose
  // anything a scanner could fingerprint (the version lives on the
  // authenticated /api/meta instead).
  app.get("/healthz", () => ({ status: "ok" }));
  // Version/update surface for the UI (M7). Authenticated: the running
  // version is nobody else's business.
  app.get("/api/meta", { preHandler: app.authenticate }, () => updates.status);

  if (config.WEB_DIST !== undefined) {
    await app.register(webStatic, {
      root: config.WEB_DIST,
      appName: config.APP_NAME,
    });
  }

  // Boot-time session resume (§15): fire-and-forget after the app is
  // wired — a no-op without CREDENTIALS_KEY or stored rows, so tests and
  // key-less deployments are untouched. Not awaited: listening must not
  // wait on F-List ticket round-trips.
  void resumeStoredSessions({
    db,
    store: credentialStore,
    vault,
    sessions,
    history,
    detachedAway,
    logger: app.log,
    disconnectAfterMs: config.DETACHED_DISCONNECT_HOURS * 3_600_000,
  }).catch((error: unknown) => {
    app.log.error({ err: error }, "boot resume failed");
  });

  return app;
}

/**
 * Both loopback spellings of an origin (127.0.0.1 ⇄ localhost), or just the
 * origin itself for any non-loopback host. Lets the gateway origin check
 * accept a local browser regardless of which loopback name the operator
 * typed; a real deployment sets APP_BASE_URL to its public origin and this
 * is a no-op.
 */
function loopbackAliases(origin: string): string[] {
  const url = new URL(origin);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
    const other = url.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
    const alias = new URL(origin);
    alias.hostname = other;
    return [url.origin, alias.origin];
  }
  return [url.origin];
}
