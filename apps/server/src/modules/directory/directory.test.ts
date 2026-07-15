// Channel directory (M6 step 1): the REST path refreshes the shared cache
// over a live session against fchat-sim (real Postgres via testcontainers);
// the replace/cooldown/degradation semantics run against direct instances
// with a scripted session — the wire is not needed to prove cache behavior.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
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
import { FchatSim } from "@emberchat/fchat-sim";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createDb, type Db } from "../../db/index.js";
import { channelDirectory, identities } from "../../db/schema.js";
import { FlistApiClient } from "../flist-api/api-client.js";
import { SessionEventBus } from "../session-engine/event-bus.js";
import type { FchatSession } from "../session-engine/fchat-session.js";
import { ChannelDirectory, type DirectorySession } from "./directory.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const ACCOUNT = "amber@example.test";
const CHARACTER = "Amber Vale";

vi.setConfig({ testTimeout: 15_000 });

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: { end: () => Promise<void> };
let sim: FchatSim;
let app: FastifyInstance;

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
      FCHAT_URL: sim.wsUrl,
      FLIST_API_URL: sim.httpUrl,
    }),
    db,
    logger: false,
    flistApiClient: new FlistApiClient({
      baseUrl: sim.httpUrl,
      minRequestIntervalMs: 0,
    }),
    // Every GET refreshes — the cooldown semantics get their own direct
    // instances below where the clock is controllable.
    directoryTuning: { cooldownMs: 0, responseTimeoutMs: 5000 },
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
      email: `dir-${String(userCounter)}@example.test`,
      username: `dir${String(userCounter)}`,
      password: "hunter2hunter2",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ accessToken: string }>().accessToken;
}

async function createIdentity(
  token: string,
): Promise<{ identityId: string; accountId: string }> {
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
  return { identityId: identity!.id, accountId };
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

interface DirectoryBody {
  channels: {
    key: string;
    kind: "official" | "open";
    title: string;
    characters: number;
  }[];
  refreshedAt: string | null;
}

describe("directory REST (production path against fchat-sim)", () => {
  it("refreshes both listings over the live session", async () => {
    const token = await registerUser();
    const { identityId, accountId } = await createIdentity(token);
    const session = app.sessions.start({
      identityId,
      character: CHARACTER,
      accountId,
      accountName: ACCOUNT,
    });
    await waitForOnline(session);

    const response = await app.inject({
      method: "GET",
      url: `/api/identities/${identityId}/directory`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<DirectoryBody>();

    const official = body.channels.filter((c) => c.kind === "official");
    const open = body.channels.filter((c) => c.kind === "open");
    expect(official.map((c) => c.key)).toContain("Frontpage");
    // Official channels title as their key.
    expect(official.find((c) => c.key === "Frontpage")?.title).toBe(
      "Frontpage",
    );
    // Open rooms list by ADH- id with a display title.
    expect(open.map((c) => c.title)).toContain("Ember Lounge");
    expect(open.every((c) => c.key.startsWith("ADH-"))).toBe(true);
    expect(body.refreshedAt).not.toBeNull();
    // Counts are live member counts from the sim world (NPC-seeded rooms
    // exist), not a hardcoded zero.
    expect(body.channels.some((c) => c.characters > 0)).toBe(true);

    app.sessions.stop(identityId);
  });

  it("serves the cache when the identity has no live session", async () => {
    const token = await registerUser();
    const { identityId } = await createIdentity(token);
    const response = await app.inject({
      method: "GET",
      url: `/api/identities/${identityId}/directory`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<DirectoryBody>();
    // Populated by the previous test's refresh; no session, so served as-is.
    expect(body.channels.length).toBeGreaterThan(0);
    expect(body.refreshedAt).not.toBeNull();
  });

  it("refuses another user's identity", async () => {
    const ownerToken = await registerUser();
    const { identityId } = await createIdentity(ownerToken);
    const otherToken = await registerUser();
    const response = await app.inject({
      method: "GET",
      url: `/api/identities/${identityId}/directory`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(response.statusCode).toBe(404);
  });
});

const LOGGER = { warn: () => {}, error: () => {} };

function fakeSession(overrides: Partial<DirectorySession> = {}) {
  const events = new SessionEventBus();
  const session: DirectorySession = {
    events,
    status: "online",
    requestChannelLists: async () => {},
    ...overrides,
  };
  return { session, events };
}

function emitOfficial(
  events: SessionEventBus,
  channels: { name: string; characters: number }[],
): void {
  events.emit("command", {
    cmd: "CHA",
    payload: {
      channels: channels.map((c) => ({ ...c, mode: "both" })),
    },
  });
}

describe("directory cache semantics (direct instance)", () => {
  // Direct instances share the one channel_directory table with the REST
  // tests above — start each test from an empty directory.
  beforeEach(async () => {
    await db.delete(channelDirectory);
  });

  it("replaces a kind wholesale — dropped channels disappear, the other kind stays", async () => {
    const directory = new ChannelDirectory(db, LOGGER, { cooldownMs: 0 });
    const { session, events } = fakeSession();
    directory.attach(session);

    emitOfficial(events, [
      { name: "Alpha", characters: 3 },
      { name: "Beta", characters: 5 },
    ]);
    events.emit("command", {
      cmd: "ORS",
      payload: {
        channels: [{ name: "ADH-feed", characters: 2, title: "Bird Feeder" }],
      },
    });
    await directory.flushWrites();

    emitOfficial(events, [{ name: "Alpha", characters: 4 }]);
    await directory.flushWrites();

    const snapshot = await directory.get();
    expect(snapshot.channels).toEqual([
      expect.objectContaining({
        key: "ADH-feed",
        kind: "open",
        title: "Bird Feeder",
      }),
      expect.objectContaining({
        key: "Alpha",
        kind: "official",
        characters: 4,
      }),
    ]);
    expect(snapshot.refreshedAt).not.toBeNull();
  });

  it("serves a fresh cache without touching the wire", async () => {
    const directory = new ChannelDirectory(db, LOGGER, {
      cooldownMs: 60_000,
    });
    const { session, events } = fakeSession({
      requestChannelLists: () => {
        throw new Error("must not hit the wire inside the cooldown");
      },
    });
    directory.attach(session);
    emitOfficial(events, [{ name: "Alpha", characters: 1 }]);
    await directory.flushWrites();

    const snapshot = await directory.get(session);
    expect(snapshot.channels.map((c) => c.key)).toContain("Alpha");
  });

  it("degrades to the stale cache when the responses never arrive", async () => {
    const directory = new ChannelDirectory(db, LOGGER, {
      cooldownMs: 0,
      responseTimeoutMs: 50,
    });
    const { session, events } = fakeSession();
    directory.attach(session);
    emitOfficial(events, [{ name: "Alpha", characters: 1 }]);
    await directory.flushWrites();

    // requestChannelLists resolves but no CHA/ORS ever comes back.
    const snapshot = await directory.get(session);
    expect(snapshot.channels.map((c) => c.key)).toContain("Alpha");
  });

  it("degrades to the stale cache when the request itself fails", async () => {
    const directory = new ChannelDirectory(db, LOGGER, { cooldownMs: 0 });
    const { session, events } = fakeSession({
      requestChannelLists: () => Promise.reject(new Error("gate cleared")),
    });
    directory.attach(session);
    emitOfficial(events, [{ name: "Alpha", characters: 1 }]);
    await directory.flushWrites();

    const snapshot = await directory.get(session);
    expect(snapshot.channels.map((c) => c.key)).toContain("Alpha");
  });
});
