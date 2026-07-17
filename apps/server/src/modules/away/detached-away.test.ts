// Detached auto-away integration (M5): real Postgres (testcontainers) +
// fchat-sim through the production path, with the sweep clock injected via
// buildApp's test knob. The GatewayHub attach-hook mechanics get their own
// container-free unit block at the bottom.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FchatSim } from "@emberchat/fchat-sim";
import type { UserPrefsPatch } from "@emberchat/protocol";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createDb, type Db } from "../../db/index.js";
import { flistAccounts, identities, userPreferences } from "../../db/schema.js";
import { FlistApiClient } from "../flist-api/api-client.js";
import { GatewayHub } from "../gateway/gateway.js";
import type { GatewayConnection } from "../gateway/connection.js";
import type { HistorySink } from "../history/sink.js";
import type { FchatSession } from "../session-engine/fchat-session.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const ACCOUNT = "amber@example.test";
const CHARACTER = "Amber Vale";
const MINUTE_MS = 60_000;

vi.setConfig({ testTimeout: 15_000 });

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: { end: () => Promise<void> };
let sim: FchatSim;
let app: FastifyInstance;
/** The injected sweep clock — tests advance it instead of waiting. */
let fakeNow = 1_000_000;

beforeAll(async () => {
  sim = new FchatSim();
  await sim.start();
  container = await new PostgreSqlContainer("postgres:18-alpine").start();
  ({ db, pool } = createDb(container.getConnectionUri()));
  await migrate(db, { migrationsFolder: MIGRATIONS });
  app = await buildApp({
    config: loadConfig({
      DATABASE_URL: container.getConnectionUri(),
      AUTH_SECRET: "integration-test-secret-0123456789abcdef",
      AUTH_RATE_LIMIT_MAX: "1000",
      REGISTRATION_ENABLED: "true",
      FCHAT_URL: sim.wsUrl,
      FLIST_API_URL: sim.httpUrl,
    }),
    db,
    logger: false,
    flistApiClient: new FlistApiClient({
      baseUrl: sim.httpUrl,
      minRequestIntervalMs: 0,
    }),
    detachedAwayNow: () => fakeNow,
  });
}, 180_000);

afterAll(async () => {
  await app.close();
  await pool.end();
  await container.stop();
  await sim.stop();
});

let userCounter = 0;
async function registerUser(): Promise<string> {
  userCounter += 1;
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `away-${String(userCounter)}@example.test`,
      username: `away${String(userCounter)}`,
      password: "hunter2hunter2",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ accessToken: string }>().accessToken;
}

/** Production path to a live session (cf. history.test.ts). */
let lastIdentityId: string | undefined;
async function startIdentity(): Promise<{
  identityId: string;
  userId: string;
  accountId: string;
  session: FchatSession;
}> {
  if (lastIdentityId !== undefined) {
    app.sessions.stop(lastIdentityId);
  }
  const token = await registerUser();
  const added = await app.inject({
    method: "POST",
    url: "/api/flist-accounts",
    headers: { authorization: `Bearer ${token}` },
    payload: { accountName: ACCOUNT, password: "hunter2" },
  });
  expect(added.statusCode).toBe(201);
  const accountId = added.json<{ account: { id: string } }>().account.id;
  const [account] = await db
    .select({ userId: flistAccounts.userId })
    .from(flistAccounts)
    .where(eq(flistAccounts.id, accountId));
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
  await waitForOnline(session);
  lastIdentityId = identity!.id;
  return {
    identityId: identity!.id,
    userId: account!.userId,
    accountId,
    session,
  };
}

function waitForOnline(session: FchatSession): Promise<void> {
  if (session.status === "online") {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for online (${session.status})`));
    }, 10_000);
    const off = session.events.on("status", ({ status }) => {
      if (status === "online") {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

/** setStatus round-trips the rate gate — poll until the status settles. */
async function expectOwnStatus(
  session: FchatSession,
  status: string,
  statusmsg: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const own = session.ownStatus;
    if (own.status === status && own.statusmsg === statusmsg) {
      return;
    }
    if (Date.now() > deadline) {
      expect(own).toEqual({ status, statusmsg });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function setPrefs(userId: string, prefs: UserPrefsPatch): Promise<unknown> {
  return db
    .insert(userPreferences)
    .values({ userId, prefs })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { prefs },
    });
}

describe("detached auto-away", () => {
  it("applies away past the threshold and hands back on attach", async () => {
    const { identityId, userId, session } = await startIdentity();
    await setPrefs(userId, {
      detachedAwayEnabled: true,
      detachedAwayMinutes: 1,
      autoAwayMessage: "Watering the moss",
    });

    // First subscriber-less sweep stamps the clock; the threshold counts
    // from there, not from some unobserved earlier moment.
    await app.detachedAway.sweep();
    fakeNow += 30_000;
    await app.detachedAway.sweep();
    expect(session.ownStatus.status).toBe("online");

    fakeNow += MINUTE_MS;
    await app.detachedAway.sweep();
    await expectOwnStatus(session, "away", "Watering the moss");

    // Attach: the bouncer's away hands back to what it replaced.
    app.detachedAway.onAttach(identityId);
    await expectOwnStatus(session, "online", "");
  });

  it("never clobbers a manually chosen status", async () => {
    const { userId, session } = await startIdentity();
    await setPrefs(userId, {
      detachedAwayEnabled: true,
      detachedAwayMinutes: 1,
    });
    await session.setStatus("busy", "renovating the terrarium");

    await app.detachedAway.sweep();
    fakeNow += 2 * MINUTE_MS;
    await app.detachedAway.sweep();
    await expectOwnStatus(session, "busy", "renovating the terrarium");
  });

  it("stays inert while the pref is off (the default)", async () => {
    const { session } = await startIdentity();

    await app.detachedAway.sweep();
    fakeNow += 24 * 60 * MINUTE_MS;
    await app.detachedAway.sweep();
    await expectOwnStatus(session, "online", "");
  });

  it("does not restore a status the user changed meanwhile", async () => {
    const { identityId, userId, session } = await startIdentity();
    await setPrefs(userId, {
      detachedAwayEnabled: true,
      detachedAwayMinutes: 1,
      autoAwayMessage: "afk",
    });
    await app.detachedAway.sweep();
    fakeNow += 2 * MINUTE_MS;
    await app.detachedAway.sweep();
    await expectOwnStatus(session, "away", "afk");

    // A manual STA between our away and the attach: theirs wins.
    await session.setStatus("looking", "back, and looking");
    app.detachedAway.onAttach(identityId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expectOwnStatus(session, "looking", "back, and looking");
  });
});

describe("detached auto-away lifecycle", () => {
  it("a session restart clears the applied record so the feature re-arms", async () => {
    const { identityId, userId, accountId, session } = await startIdentity();
    await setPrefs(userId, {
      detachedAwayEnabled: true,
      detachedAwayMinutes: 1,
      autoAwayMessage: "afk",
    });
    await app.detachedAway.sweep();
    fakeNow += 2 * MINUTE_MS;
    await app.detachedAway.sweep();
    await expectOwnStatus(session, "away", "afk");

    // Explicit disconnect → later reconnect: the fresh session starts
    // plain "online" and there is nothing to restore — a stale applied
    // record must not block going away again.
    app.sessions.stop(identityId);
    await app.detachedAway.sweep(); // prunes the dead session's state
    const restarted = app.sessions.start({
      identityId,
      character: CHARACTER,
      accountId,
      accountName: ACCOUNT,
    });
    await waitForOnline(restarted);
    await app.detachedAway.sweep(); // stamps a fresh detachment clock
    fakeNow += 2 * MINUTE_MS;
    await app.detachedAway.sweep();
    await expectOwnStatus(restarted, "away", "afk");
  });

  it("stops a session past the detached-disconnect ceiling (default 72h)", async () => {
    const { identityId, session } = await startIdentity();
    const events: { status: string; reason?: string }[] = [];
    session.events.on("status", (event) => events.push(event));

    // The ceiling needs no prefs — it is the operator's knob, applied even
    // with detached-away off (the default from registerUser).
    await app.detachedAway.sweep(); // stamps the detachment clock
    fakeNow += 71 * 60 * MINUTE_MS;
    await app.detachedAway.sweep();
    expect(session.status).toBe("online"); // under the ceiling — untouched

    fakeNow += 2 * 60 * MINUTE_MS; // 73h total
    await app.detachedAway.sweep();
    expect(session.status).toBe("stopped");
    expect(app.sessions.get(identityId)).toBeUndefined();
    expect(events.at(-1)).toEqual({
      status: "stopped",
      reason: "disconnected after 72h with no attached device",
    });
  });
});

describe("GatewayHub attach hook", () => {
  const fakeHistory = {
    events: { on: () => () => {} },
  } as unknown as HistorySink;

  it("fires on the zero→one transition only; hasSubscribers tracks the set", () => {
    const hub = new GatewayHub({ history: fakeHistory });
    const fired: string[] = [];
    hub.onFirstSubscribe = (identityId) => fired.push(identityId);
    const a = {} as GatewayConnection;
    const b = {} as GatewayConnection;

    expect(hub.hasSubscribers("i")).toBe(false);
    hub.subscribe("i", a);
    hub.subscribe("i", b); // second attach — no re-fire
    expect(fired).toEqual(["i"]);
    expect(hub.hasSubscribers("i")).toBe(true);

    hub.unsubscribe("i", a);
    hub.unsubscribe("i", b);
    expect(hub.hasSubscribers("i")).toBe(false);
    hub.subscribe("i", a); // zero→one again
    expect(fired).toEqual(["i", "i"]);
  });
});
