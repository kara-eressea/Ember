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
import { contentSecurityDirectives } from "./security/csp.js";
import { ImagePreviewHostRegistry } from "./security/image-preview-hosts.js";
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
import {
  directoryRoutes,
  DIRECTORY_RATE_LIMIT_MAX,
} from "./modules/directory/routes.js";
import { enrichSocial, SocialCache } from "./modules/social/cache.js";
import { socialRoutes } from "./modules/social/routes.js";
import { SocialService } from "./modules/social/service.js";
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
import type { GatewayTuning } from "./modules/gateway/connection.js";
import { GatewayHub, gatewayRoutes } from "./modules/gateway/gateway.js";
import { UpdateChecker } from "./modules/meta/update-check.js";
import { HighlightMatcher } from "./modules/highlights/matcher.js";
import { highlightsRoutes } from "./modules/highlights/routes.js";
import { historyRoutes } from "./modules/history/routes.js";
import { identitiesRoutes } from "./modules/identities/routes.js";
import { RetentionJob } from "./modules/history/retention.js";
import { HistorySink } from "./modules/history/sink.js";
import { NotificationStore } from "./modules/notifications/store.js";
import { notificationsRoutes } from "./modules/notifications/routes.js";
import { Outbox } from "./modules/outbox/outbox.js";
import { SeenMembersStore } from "./modules/seen-members/store.js";
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
    notifications: NotificationStore;
    outbox: Outbox;
    detachedAway: DetachedAway;
    directory: ChannelDirectory;
    imagePreviewHosts: ImagePreviewHostRegistry;
    gatewayHub: GatewayHub;
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
  /** Test-only gateway connection knobs; production runs the defaults. */
  gatewayTuning?: GatewayTuning;
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
  gatewayTuning,
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
  // Live union of every user's image-preview allowlist, folded into the CSP so
  // a host a user adds in Preferences is actually fetchable (#342). Loaded once
  // here and refreshed whenever a user's imagePreviewHosts pref changes.
  const imagePreviewHosts = ImagePreviewHostRegistry.fromDb(db, app.log);
  await imagePreviewHosts.refresh();
  // Late-bound: the session registry's start callback needs it, but the
  // scheduler itself needs the hub/history built below.
  // Assigned once below; the session-start callback must close over it.
  // eslint-disable-next-line prefer-const -- forward declaration
  let campaignScheduler: CampaignScheduler | undefined;
  const notifications = new NotificationStore(db, app.log);
  const history = new HistorySink(db, app.log, { highlights, notifications });
  const hub = new GatewayHub({ history, notifications, logger: app.log });
  // Per-identity social lists (#194) — in memory alongside the sessions;
  // a restart just means the first GET refetches.
  const socialCache = new SocialCache();
  // Late-bound like the scheduler: the service needs the session registry,
  // whose start callback needs the service (RTB refresh, #364).
  // eslint-disable-next-line prefer-const -- forward declaration
  let socialService: SocialService | undefined;
  // Departed-member rosters (#200) — persisted so "Seen recently" survives
  // restarts; the snapshot reads them straight from the table.
  const seenMembers = new SeenMembersStore({ db, logger: app.log });
  seenMembers.start();
  const directory = new ChannelDirectory(
    db,
    app.log,
    process.env.NODE_ENV === "test" ? directoryTuning : undefined,
  );
  // In-process knobs stay behind NODE_ENV — nothing outside the test runner
  // may reach them. The env knobs carry their own gate instead (a sub-policy
  // floor refuses to boot against real F-Chat, config.ts), which is what lets
  // the E2E stack's *spawned* server binary shorten the sim's backoff.
  const tuning: SessionTuning = {
    ...(process.env.NODE_ENV === "test" ? sessionTuning : {}),
    ...(config.FCHAT_RECONNECT_FLOOR_MS !== undefined
      ? { backoffFloorMs: config.FCHAT_RECONNECT_FLOOR_MS }
      : {}),
    ...(config.FCHAT_RECONNECT_CAP_MS !== undefined
      ? { backoffCapMs: config.FCHAT_RECONNECT_CAP_MS }
      : {}),
  };
  const sessions = new SessionRegistry({
    tickets,
    wsUrl: config.FCHAT_URL,
    clientName: config.CLIENT_NAME,
    clientVersion: config.CLIENT_VERSION,
    logger: app.log,
    tuning,
    onSessionStarted: (identityId, session) => {
      // History first: message.new fan-out happens post-persistence via the
      // sink's bus, so the sink must see every command the hub translates.
      history.attach(identityId, session);
      hub.attachSession(identityId, session);
      seenMembers.attach(identityId, session);
      directory.attach(session);
      // Every session's manual ads must stamp the campaign scheduler's
      // app-wide spacing clock, campaign or not (M11 audit).
      campaignScheduler?.observeSession(identityId, session);
      // Website-side social changes arrive as RTB over the chat socket:
      // fold bookmark events into the cache and fan them out (#199);
      // friend events change upstream rows we cannot patch, so they drop
      // the cache and refetch (coalesced) to fan out fresh lists (#364).
      session.events.on("command", (command) => {
        if (command.cmd !== "RTB") {
          return;
        }
        const { type } = command.payload;
        // The three website events worth keeping (#467): they used to flash
        // as a transient notice and vanish, so a friend request that arrived
        // while the browser was closed was simply lost. The notice still
        // fires — this only adds the durable log entry behind it.
        if (type === "friendrequest" || type === "note" || type === "comment") {
          void notifications.recordRtb(
            identityId,
            type,
            command.payload.character ??
              command.payload.name ??
              command.payload.sender ??
              "",
            command.payload.subject,
          );
        }
        if (type === "bookmarkadd" || type === "bookmarkremove") {
          const name = command.payload.name ?? command.payload.character ?? "";
          if (name === "") {
            socialCache.invalidate(identityId);
            return;
          }
          const patched = socialCache.patchBookmark(
            identityId,
            type === "bookmarkadd" ? "add" : "remove",
            name,
          );
          if (patched) {
            hub.broadcast(identityId, {
              kind: "social.updated",
              d: { social: enrichSocial(patched, session.state.characters) },
            });
          }
        } else if (
          type === "friendadd" ||
          type === "friendremove" ||
          type === "friendrequest"
        ) {
          // Invalidate first so nothing serves the list we know is stale;
          // the refresh repopulates it and pushes social.updated, which is
          // what moves the new friend out of the DM section without a
          // manual ↻ (#364).
          socialCache.invalidate(identityId);
          socialService?.refreshSoon(identityId);
        }
      });
    },
  });
  socialService = new SocialService({
    db,
    sessions,
    tickets,
    flistApi,
    cache: socialCache,
    hub,
    logger: app.log,
  });
  app.decorate("sessions", sessions);
  app.decorate("history", history);
  app.decorate("notifications", notifications);
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
  app.decorate("imagePreviewHosts", imagePreviewHosts);
  app.decorate("gatewayHub", hub);
  const sessionJanitor = new SessionJanitor({ db, logger: app.log });
  sessionJanitor.start();
  const updates = new UpdateChecker({
    currentVersion: config.CLIENT_VERSION,
    repo: config.UPDATE_CHECK_REPO,
    clientName: config.CLIENT_NAME,
    // Test runs never phone home, whatever the config says.
    enabled: config.UPDATE_CHECK_ENABLED && process.env.NODE_ENV !== "test",
    logger: app.log,
  });
  updates.start();
  // Ad-rotation campaigns (M11): resumes persisted campaigns and runs the
  // conservative posting schedule. Attached-only gating rides the hub.
  campaignScheduler = new CampaignScheduler({
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
    seenMembers.stop();
    outbox.stop();
    campaignScheduler.stop();
    socialService?.stop();
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
            // The extra-hosts source is a function helmet evaluates per
            // response, so a pref update (which calls registry.refresh())
            // widens the policy without a restart or a per-request DB read.
            directives: contentSecurityDirectives(() =>
              imagePreviewHosts.mediaSourceString(),
            ),
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
  await app.register(notificationsRoutes, {
    prefix: "/api/identities",
    db,
    notifications,
    hub,
  });
  await app.register(directoryRoutes, {
    prefix: "/api/identities",
    db,
    sessions,
    directory,
    // A tenth of the instance's backstop, never below the production value:
    // the default config leaves this at 30, and an operator who raised the
    // backstop for many-clients-per-address gets a route cap that follows.
    rateLimitMax: Math.max(
      DIRECTORY_RATE_LIMIT_MAX,
      Math.floor(config.RATE_LIMIT_MAX / 10),
    ),
  });
  await app.register(socialRoutes, {
    prefix: "/api/identities",
    db,
    tickets,
    flistApi,
    cache: socialCache,
    service: socialService,
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
    notifications,
    imagePreviewHosts,
    campaigns: campaignScheduler,
    social: socialCache,
    ...(process.env.NODE_ENV === "test" && gatewayTuning !== undefined
      ? { tuning: gatewayTuning }
      : {}),
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
