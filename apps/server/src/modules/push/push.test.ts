// Web Push integration tests (design/web-push.md §5) against real Postgres
// (testcontainers) and fchat-sim, modelled on notifications.test.ts. The push
// endpoints point at an HTTP listener this file owns, so a "push service" is
// a real socket with real status codes rather than a mock.
//
// The bodies are never decrypted — the encryption is the library's contract,
// not ours. What is asserted here is everything around it: that a POST goes
// out at all, that it carries the VAPID/TTL/urgency headers a push service
// requires, and that the filtering, pruning and cascade rules hold. What is
// INSIDE the ciphertext is asserted in payload.test.ts, which is why that
// seam exists.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { asc, eq } from "drizzle-orm";
import { createECDH, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as webpush from "web-push";
import { FchatSim } from "@emberchat/fchat-sim";
import { serializeServerCommand } from "@emberchat/fchat-protocol";
import type { UserPrefs } from "@emberchat/protocol";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createDb, type Db } from "../../db/index.js";
import {
  authSessions,
  identities,
  pushSubscriptions,
  userPreferences,
} from "../../db/schema.js";
import {
  CONTAINER_BOOT_MS,
  INTEGRATION_MS,
} from "../../test-support/budgets.js";
import { type FchatSession, FlistApiClient } from "@emberchat/session-engine";
import { MAX_SUBSCRIPTIONS_PER_USER } from "./routes.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const ACCOUNT = "amber@example.test";
const CHARACTER = "Amber Vale";

vi.setConfig({ testTimeout: INTEGRATION_MS });

/** One captured request to the fake push service. */
interface CapturedPush {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  bodyLength: number;
}

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: { end: () => Promise<void> };
let sim: FchatSim;
let app: FastifyInstance;
/** A second instance with no VAPID config — invariant 6's control group. */
let unconfigured: FastifyInstance;
let pushService: Server;
let pushBase: string;
let captured: CapturedPush[] = [];
/** Status the fake service answers with; per-path overrides win. */
let defaultStatus = 201;
const statusByPath = new Map<string, number>();

const vapid = webpush.generateVAPIDKeys();
/**
 * What a browser hands over: a real P-256 public point and a 16-byte auth
 * secret. Real because RFC 8291 encryption does an ECDH against the point and
 * a placeholder string would be rejected before anything hit the wire. The
 * matching private key is deliberately thrown away — nothing here decrypts.
 */
const clientKeys = (() => {
  const curve = createECDH("prime256v1");
  curve.generateKeys();
  return {
    p256dh: curve.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
})();

beforeAll(async () => {
  pushService = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = request.url ?? "";
      captured.push({
        path,
        headers: request.headers,
        bodyLength: Buffer.concat(chunks).length,
      });
      response.writeHead(statusByPath.get(path) ?? defaultStatus).end();
    });
  });
  await new Promise<void>((resolve) => {
    pushService.listen(0, "127.0.0.1", resolve);
  });
  pushBase = `http://127.0.0.1:${String((pushService.address() as AddressInfo).port)}`;

  sim = new FchatSim();
  await sim.start();
  container = await new PostgreSqlContainer("postgres:18-alpine").start();
  ({ db, pool } = createDb(container.getConnectionUri()));
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const baseEnv = {
    DATABASE_URL: container.getConnectionUri(),
    AUTH_SECRET: "integration-test-secret-0123456789abcdef",
    AUTH_RATE_LIMIT_MAX: "1000",
    RATE_LIMIT_MAX: "1000",
    REGISTRATION_ENABLED: "true",
    FCHAT_URL: sim.wsUrl,
    FLIST_API_URL: sim.httpUrl,
  };
  app = await buildApp({
    config: loadConfig({
      ...baseEnv,
      PUSH_VAPID_PUBLIC_KEY: vapid.publicKey,
      PUSH_VAPID_PRIVATE_KEY: vapid.privateKey,
      PUSH_VAPID_SUBJECT: "mailto:admin@example.test",
    }),
    db,
    logger: false,
    flistApiClient: new FlistApiClient({
      baseUrl: sim.httpUrl,
      minRequestIntervalMs: 0,
    }),
  });
  unconfigured = await buildApp({
    config: loadConfig(baseEnv),
    db,
    logger: false,
    flistApiClient: new FlistApiClient({
      baseUrl: sim.httpUrl,
      minRequestIntervalMs: 0,
    }),
  });
}, CONTAINER_BOOT_MS);

afterAll(async () => {
  await unconfigured.close();
  await app.close();
  await pool.end();
  await container.stop();
  await sim.stop();
  await new Promise<void>((resolve) => {
    pushService.close(() => {
      resolve();
    });
  });
});

beforeEach(() => {
  captured = [];
  defaultStatus = 201;
  statusByPath.clear();
});

let userCounter = 0;
let endpointCounter = 0;
let lastIdentityId: string | undefined;

interface Fixture {
  identityId: string;
  userId: string;
  session: FchatSession;
  token: string;
  refreshToken: string;
}

/**
 * Fresh user + account + identity + live session, like notifications.test.ts.
 * Preferences are written BEFORE anything can push, which is what keeps the
 * process-wide prefs cache honest here: it is populated lazily on first read,
 * and every test uses a user it has never read.
 */
async function startIdentity(prefs: Partial<UserPrefs> = {}): Promise<Fixture> {
  if (lastIdentityId !== undefined) {
    app.sessions.stop(lastIdentityId);
  }
  userCounter += 1;
  const registered = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `push-${String(userCounter)}@example.test`,
      username: `push${String(userCounter)}`,
      password: "hunter2hunter2",
    },
  });
  expect(registered.statusCode).toBe(201);
  const {
    accessToken: token,
    refreshToken,
    user,
  } = registered.json<{
    accessToken: string;
    refreshToken: string;
    user: { id: string };
  }>();
  await db.insert(userPreferences).values({
    userId: user.id,
    prefs: {
      // Push rides the existing desktop-notification prefs, which are all
      // off by default — an opted-in user is the interesting case.
      desktopNotifyMentions: true,
      desktopNotifyPms: true,
      desktopNotifyNotes: true,
      ...prefs,
    },
  });
  const added = await app.inject({
    method: "POST",
    url: "/api/flist-accounts",
    headers: { authorization: `Bearer ${token}` },
    payload: { accountName: ACCOUNT, password: "hunter2" },
  });
  expect(added.statusCode).toBe(201);
  const accountId = added.json<{ account: { id: string } }>().account.id;
  const [identity] = await db
    .insert(identities)
    .values({ flistAccountId: accountId, characterName: CHARACTER })
    .returning({ id: identities.id });
  const session = app.sessions.start({
    identityId: identity!.id,
    character: CHARACTER,
    accountId,
    accountName: ACCOUNT,
  });
  await waitForStatus(session, "online");
  lastIdentityId = identity!.id;
  return {
    identityId: identity!.id,
    userId: user.id,
    session,
    token,
    refreshToken,
  };
}

/**
 * Register an endpoint on the local listener. Inserted directly rather than
 * through PUT /api/push/subscription, which (rightly) only accepts https:
 * endpoints — the route's own validation is exercised in its own describe.
 */
async function subscribe(fixture: Fixture): Promise<{ path: string }> {
  endpointCounter += 1;
  const path = `/push/${String(endpointCounter)}`;
  const [session] = await db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(eq(authSessions.userId, fixture.userId))
    .orderBy(asc(authSessions.createdAt))
    .limit(1);
  await db.insert(pushSubscriptions).values({
    userId: fixture.userId,
    authSessionId: session!.id,
    endpoint: `${pushBase}${path}`,
    p256dh: clientKeys.p256dh,
    auth: clientKeys.auth,
  });
  return { path };
}

function waitForStatus(
  session: FchatSession,
  status: string,
  timeoutMs = INTEGRATION_MS,
): Promise<void> {
  if (session.status === status) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`timed out waiting for ${status} (now ${session.status})`),
      );
    }, timeoutMs);
    session.events.on("status", (event) => {
      if (event.status === status) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function joinAndSettle(session: FchatSession, channel: string): Promise<void> {
  const settled = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out joining ${channel}`));
    }, 5000);
    const off = session.events.on("command", (command) => {
      if (command.cmd === "CDS" && command.payload.channel === channel) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
  session.joinChannel(channel);
  return settled;
}

/** Injects a server frame and resolves once the session processed it. */
function inject(
  session: FchatSession,
  frame: Parameters<typeof serializeServerCommand>[0],
): Promise<void> {
  const seen = new Promise<void>((resolve) => {
    const off = session.events.on("command", (command) => {
      if (command.cmd === frame.cmd) {
        off();
        resolve();
      }
    });
  });
  sim.sendRawTo(CHARACTER, serializeServerCommand(frame));
  return seen;
}

/** Pushes are fire-and-forget by design (invariant 3): the sink returns long
 * before the POST lands, so waiting is the only correct assertion shape. */
async function waitForPushes(count: number): Promise<CapturedPush[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (captured.length >= count) {
      return captured;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `timed out waiting for ${String(count)} pushes (saw ${String(captured.length)})`,
  );
}

/** The negative assertion: nothing arrives. Deliberately short and explicit —
 * a "no push" test cannot wait for an event that will never come. */
async function expectNoPush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(captured).toHaveLength(0);
}

async function subscriptionCount(userId: string): Promise<number> {
  const rows = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));
  return rows.length;
}

describe("push sender — triggers", () => {
  it("posts an encrypted, VAPID-signed notification for a mention", async () => {
    const fixture = await startIdentity();
    const { path } = await subscribe(fixture);
    await joinAndSettle(fixture.session, "Frontpage");

    await inject(fixture.session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: `hey ${CHARACTER}, over here`,
        channel: "Frontpage",
      },
    });
    await app.history.flush();

    const [push] = await waitForPushes(1);
    expect(push?.path).toBe(path);
    // What a push service requires of us, and what the payload is.
    expect(push?.headers.authorization).toMatch(/^vapid t=/);
    expect(push?.headers["content-encoding"]).toBe("aes128gcm");
    expect(push?.headers.ttl).toBeDefined();
    expect(push?.headers.urgency).toBe("high");
    // Encrypted, so only its existence is assertable here.
    expect(push?.bodyLength).toBeGreaterThan(0);
  });

  it("pushes an inbound PM, and never our own send", async () => {
    const fixture = await startIdentity();
    await subscribe(fixture);

    await inject(fixture.session, {
      cmd: "PRI",
      payload: { character: "Nyx Firemane", message: "psst" },
    });
    await app.history.flush();
    await waitForPushes(1);

    // Our own DM is persisted the same way and must not notify us about
    // ourselves.
    captured = [];
    await fixture.session.sendPrivateMessage("Nyx Firemane", "hello back");
    await app.history.flush();
    await expectNoPush();
  });

  it("pushes the website events, one per subscribed device", async () => {
    const fixture = await startIdentity();
    await subscribe(fixture);
    await subscribe(fixture);

    await inject(fixture.session, {
      cmd: "RTB",
      payload: { type: "friendrequest", name: "Nyx Firemane" },
    });

    const pushes = await waitForPushes(2);
    expect(new Set(pushes.map((push) => push.path)).size).toBe(2);
  });
});

describe("push sender — filtering", () => {
  it("stays silent when the kind's preference is off", async () => {
    const fixture = await startIdentity({ desktopNotifyMentions: false });
    await subscribe(fixture);
    await joinAndSettle(fixture.session, "Frontpage");

    await inject(fixture.session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: `hey ${CHARACTER}`,
        channel: "Frontpage",
      },
    });
    await app.history.flush();
    await expectNoPush();
  });

  it("never pushes a muted identity's mention or PM", async () => {
    // Muting an identity silences alerts across both triggers: the store
    // stamps `muted` on the inbox row (bus side) and the PM hook applies the
    // same list itself.
    const fixture = await startIdentity();
    await db
      .update(userPreferences)
      .set({
        prefs: {
          desktopNotifyMentions: true,
          desktopNotifyPms: true,
          desktopNotifyNotes: true,
          mutedIdentityIds: [fixture.identityId],
        },
      })
      .where(eq(userPreferences.userId, fixture.userId));
    await subscribe(fixture);
    await joinAndSettle(fixture.session, "Frontpage");

    await inject(fixture.session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: `hey ${CHARACTER}`,
        channel: "Frontpage",
      },
    });
    await inject(fixture.session, {
      cmd: "PRI",
      payload: { character: "Nyx Firemane", message: "psst" },
    });
    await app.history.flush();
    await expectNoPush();
  });
});

describe("push sender — subscription lifetime", () => {
  it("prunes a subscription the push service reports as gone", async () => {
    const fixture = await startIdentity();
    const gone = await subscribe(fixture);
    const live = await subscribe(fixture);
    statusByPath.set(gone.path, 410);

    await inject(fixture.session, {
      cmd: "PRI",
      payload: { character: "Nyx Firemane", message: "psst" },
    });
    await app.history.flush();
    await waitForPushes(2);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await subscriptionCount(fixture.userId)) === 1) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const rows = await db
      .select({ endpoint: pushSubscriptions.endpoint })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, fixture.userId));
    // The 410 endpoint went; the healthy one stayed.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endpoint).toBe(`${pushBase}${live.path}`);
  });

  it("keeps a subscription a push service merely refused", async () => {
    const fixture = await startIdentity();
    await subscribe(fixture);
    defaultStatus = 500;

    await inject(fixture.session, {
      cmd: "PRI",
      payload: { character: "Nyx Firemane", message: "psst" },
    });
    await app.history.flush();
    await waitForPushes(1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // A push service having a bad day is not the device saying goodbye.
    expect(await subscriptionCount(fixture.userId)).toBe(1);
  });

  it("takes subscriptions with the auth session on logout", async () => {
    const fixture = await startIdentity();
    await subscribe(fixture);
    expect(await subscriptionCount(fixture.userId)).toBe(1);

    const loggedOut = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      payload: { refreshToken: fixture.refreshToken },
    });
    expect(loggedOut.statusCode).toBe(204);

    // The whole revocation story is this cascade — no push janitor exists.
    expect(await subscriptionCount(fixture.userId)).toBe(0);
  });
});

describe("push routes", () => {
  const ENDPOINT = "https://push.example.test/endpoint/aaa";

  it("refuses every route without a token", async () => {
    // Well-formed bodies on purpose: fastify validates before preHandler, so
    // a malformed one would 400 and prove nothing about the auth guard.
    for (const [method, url, payload] of [
      ["GET", "/api/push/vapid-key", undefined],
      [
        "PUT",
        "/api/push/subscription",
        { endpoint: ENDPOINT, keys: clientKeys },
      ],
      ["DELETE", "/api/push/subscription", { endpoint: ENDPOINT }],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it("advertises the public key, and reports disabled without config", async () => {
    const fixture = await startIdentity();
    const headers = { authorization: `Bearer ${fixture.token}` };
    const enabled = await app.inject({
      method: "GET",
      url: "/api/push/vapid-key",
      headers,
    });
    expect(enabled.json()).toEqual({ enabled: true, key: vapid.publicKey });

    // Invariant 6: an instance with no VAPID config never advertises a key,
    // which is how the client knows to hide the feature entirely.
    const off = await unconfigured.inject({
      method: "GET",
      url: "/api/push/vapid-key",
      headers,
    });
    expect(off.json()).toEqual({ enabled: false });
    const stored = await unconfigured.inject({
      method: "PUT",
      url: "/api/push/subscription",
      headers,
      payload: { endpoint: ENDPOINT, keys: clientKeys },
    });
    expect(stored.statusCode).toBe(404);
  });

  it("upserts on endpoint rather than collecting duplicates", async () => {
    const fixture = await startIdentity();
    const headers = { authorization: `Bearer ${fixture.token}` };
    for (const auth of ["first-auth-secret", "second-auth-secret"]) {
      const response = await app.inject({
        method: "PUT",
        url: "/api/push/subscription",
        headers,
        payload: {
          endpoint: ENDPOINT,
          keys: { p256dh: clientKeys.p256dh, auth },
        },
      });
      expect(response.statusCode).toBe(200);
    }
    const rows = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, ENDPOINT));
    expect(rows).toHaveLength(1);
    // A rotated key must overwrite: sending to the stale one fails forever.
    expect(rows[0]?.auth).toBe("second-auth-secret");
    expect(rows[0]?.userId).toBe(fixture.userId);
  });

  it("refuses an endpoint that is not an https URL", async () => {
    const fixture = await startIdentity();
    const response = await app.inject({
      method: "PUT",
      url: "/api/push/subscription",
      headers: { authorization: `Bearer ${fixture.token}` },
      payload: { endpoint: `${pushBase}/push/nope`, keys: clientKeys },
    });
    expect(response.statusCode).toBe(400);
  });

  it("caps the installs one login may keep, dropping the oldest", async () => {
    const fixture = await startIdentity();
    const headers = { authorization: `Bearer ${fixture.token}` };
    const total = MAX_SUBSCRIPTIONS_PER_USER + 2;
    for (let index = 0; index < total; index += 1) {
      const response = await app.inject({
        method: "PUT",
        url: "/api/push/subscription",
        headers,
        payload: {
          endpoint: `https://push.example.test/cap/${String(index)}`,
          keys: clientKeys,
        },
      });
      expect(response.statusCode).toBe(200);
    }
    const rows = await db
      .select({ endpoint: pushSubscriptions.endpoint })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, fixture.userId))
      .orderBy(asc(pushSubscriptions.createdAt));
    expect(rows).toHaveLength(MAX_SUBSCRIPTIONS_PER_USER);
    // The two oldest went, newest kept.
    expect(rows[0]?.endpoint).toBe("https://push.example.test/cap/2");
  });

  it("deletes only the requesting user's endpoint", async () => {
    const owner = await startIdentity();
    const stored = await app.inject({
      method: "PUT",
      url: "/api/push/subscription",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { endpoint: ENDPOINT, keys: clientKeys },
    });
    expect(stored.statusCode).toBe(200);

    const stranger = await startIdentity();
    const refused = await app.inject({
      method: "DELETE",
      url: "/api/push/subscription",
      headers: { authorization: `Bearer ${stranger.token}` },
      payload: { endpoint: ENDPOINT },
    });
    // Idempotent, not 404 — but somebody else's row is untouched.
    expect(refused.json()).toEqual({ removed: false });
    expect(await subscriptionCount(owner.userId)).toBe(1);

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/push/subscription",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { endpoint: ENDPOINT },
    });
    expect(removed.json()).toEqual({ removed: true });
    expect(await subscriptionCount(owner.userId)).toBe(0);
  });
});
