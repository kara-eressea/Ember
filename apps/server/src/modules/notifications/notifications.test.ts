// Notification-inbox integration tests (#467) against real Postgres
// (testcontainers) and fchat-sim. Everything goes through the production
// path — register → add F-List account → start the session — so the sink and
// the RTB handler attach exactly as they do in production.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { asc, desc, eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FchatSim } from "@emberchat/fchat-sim";
import { serializeServerCommand } from "@emberchat/fchat-protocol";
import type { NotificationDto } from "@emberchat/protocol";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createDb, type Db } from "../../db/index.js";
import {
  conversations,
  identities,
  messages,
  notifications,
  userPreferences,
} from "../../db/schema.js";
import {
  CONTAINER_BOOT_MS,
  INTEGRATION_MS,
} from "../../test-support/budgets.js";
import { FlistApiClient } from "../flist-api/api-client.js";
import { RetentionJob } from "../history/retention.js";
import type { FchatSession } from "../session-engine/fchat-session.js";
import { excerptOf, NotificationStore } from "./store.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const ACCOUNT = "amber@example.test";
const CHARACTER = "Amber Vale";

vi.setConfig({ testTimeout: INTEGRATION_MS });

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
  });
}, CONTAINER_BOOT_MS);

afterAll(async () => {
  await app.close();
  await pool.end();
  await container.stop();
  await sim.stop();
});

let userCounter = 0;

interface Fixture {
  identityId: string;
  userId: string;
  session: FchatSession;
  token: string;
}

/** Fresh user + account + identity + a live session, like history.test.ts. */
let lastIdentityId: string | undefined;
async function startIdentity(): Promise<Fixture> {
  if (lastIdentityId !== undefined) {
    app.sessions.stop(lastIdentityId);
  }
  userCounter += 1;
  const registered = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `notif-${String(userCounter)}@example.test`,
      username: `notif${String(userCounter)}`,
      password: "hunter2hunter2",
    },
  });
  expect(registered.statusCode).toBe(201);
  const { accessToken: token, user } = registered.json<{
    accessToken: string;
    user: { id: string };
  }>();
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
  return { identityId: identity!.id, userId: user.id, session, token };
}

function waitForStatus(
  session: FchatSession,
  status: string,
  timeoutMs = 10_000,
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

/** The sink writes its inbox row inside the same serial task as the message,
 * so a flushed sink means the row has landed too. */
async function settle(): Promise<void> {
  await app.history.flush();
}

function rowsFor(identityId: string) {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.identityId, identityId))
    .orderBy(asc(notifications.id));
}

/** The RTB path is fire-and-forget from the session's command handler, so
 * its rows land a tick or two after the frame was processed. */
async function waitForRows(identityId: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await rowsFor(identityId)).length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${String(count)} inbox rows`);
}

describe("notification inbox — writers", () => {
  it("logs a mention exactly when the sink stamps one, and nothing else", async () => {
    const { identityId, session } = await startIdentity();
    await joinAndSettle(session, "Frontpage");

    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: `[b]hey[/b] ${CHARACTER}, over here`,
        channel: "Frontpage",
      },
    });
    // Not about us: no highlight rule matches, so no inbox row.
    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Tally Marsh",
        message: "nothing to see here",
        channel: "Frontpage",
      },
    });
    // A DM is already directed at the user and carries no mention verdict.
    await inject(session, {
      cmd: "PRI",
      payload: { character: "Nyx Firemane", message: `psst ${CHARACTER}` },
    });
    await settle();

    const rows = await rowsFor(identityId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "mention",
      character: "Nyx Firemane",
      muted: false,
      // BBCode stripped for the row preview.
      excerpt: `hey ${CHARACTER}, over here`,
    });

    // It points at the message the sink stamped, in that conversation.
    const [conversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.channelKey, "Frontpage"))
      .limit(1);
    const [stamped] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.mention, true))
      .orderBy(desc(messages.id))
      .limit(1);
    expect(rows[0]?.conversationId).toBe(conversation!.id);
    expect(rows[0]?.messageId).toBe(stamped!.id);
  });

  it("logs the three website RTB kinds and ignores the rest", async () => {
    const { identityId, session } = await startIdentity();

    await inject(session, {
      cmd: "RTB",
      payload: { type: "friendrequest", name: "Nyx Firemane" },
    });
    await inject(session, {
      cmd: "RTB",
      payload: {
        type: "note",
        character: "Tally Marsh",
        subject: "About last night",
      },
    });
    await inject(session, {
      cmd: "RTB",
      payload: { type: "comment", character: "Old Greywhisker" },
    });
    // A silent list sync: notice-less today, inbox-less too.
    await inject(session, {
      cmd: "RTB",
      payload: { type: "bookmarkadd", name: "Nyx Firemane" },
    });
    await waitForRows(identityId, 3);

    const rows = await rowsFor(identityId);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.kind)).toEqual([
      "friendrequest",
      "note",
      "comment",
    ]);
    expect(rows[0]).toMatchObject({
      character: "Nyx Firemane",
      excerpt: "",
      conversationId: null,
      messageId: null,
    });
    expect(rows[1]).toMatchObject({
      character: "Tally Marsh",
      excerpt: "About last night",
    });
  });

  it("logs a muted conversation's mention but keeps it out of the badge", async () => {
    const { identityId, userId, session } = await startIdentity();
    await joinAndSettle(session, "Frontpage");
    // One message first, purely to create the conversation row we mute.
    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Tally Marsh",
        message: "opening the room",
        channel: "Frontpage",
      },
    });
    await settle();
    const [conversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.identityId, identityId))
      .limit(1);
    await db
      .insert(userPreferences)
      .values({ userId, prefs: { mutedConvIds: [conversation!.id] } })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { prefs: { mutedConvIds: [conversation!.id] } },
      });
    app.notifications.invalidatePrefs(userId);

    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: `quietly, ${CHARACTER}`,
        channel: "Frontpage",
      },
    });
    await settle();

    const rows = await rowsFor(identityId);
    // The log keeps it — the inbox is a log, mutes only silence alerts.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.muted).toBe(true);
    expect(await app.notifications.unseenCount(identityId)).toBe(0);
  });
});

describe("notification inbox — REST", () => {
  it("pages by keyset newest-first and round-trips the seen watermark", async () => {
    const { identityId, token } = await startIdentity();
    const broadcasts = vi.spyOn(app.gatewayHub, "broadcast");
    const store = app.notifications;
    for (let i = 1; i <= 5; i += 1) {
      await store.recordRtb(
        identityId,
        "note",
        `Sender ${String(i)}`,
        `n${String(i)}`,
      );
    }
    const headers = { authorization: `Bearer ${token}` };

    const first = await app.inject({
      method: "GET",
      url: `/api/identities/${identityId}/notifications?limit=2`,
      headers,
    });
    expect(first.statusCode).toBe(200);
    const page1 = first.json<{
      notifications: NotificationDto[];
      hasMore: boolean;
      lastSeenId: number;
      unseen: number;
    }>();
    expect(page1.notifications.map((n) => n.excerpt)).toEqual(["n5", "n4"]);
    expect(page1.hasMore).toBe(true);
    expect(page1.lastSeenId).toBe(0);
    expect(page1.unseen).toBe(5);

    const second = await app.inject({
      method: "GET",
      url: `/api/identities/${identityId}/notifications?limit=2&before=${String(page1.notifications[1]!.id)}`,
      headers,
    });
    const page2 = second.json<{
      notifications: NotificationDto[];
      hasMore: boolean;
    }>();
    expect(page2.notifications.map((n) => n.excerpt)).toEqual(["n3", "n2"]);
    expect(page2.hasMore).toBe(true);

    // Marking the newest seen clears the badge...
    const newest = page1.notifications[0]!.id;
    const marked = await app.inject({
      method: "PUT",
      url: `/api/identities/${identityId}/notifications/seen`,
      headers,
      payload: { lastSeenId: newest },
    });
    expect(marked.json<{ lastSeenId: number; unseen: number }>()).toEqual({
      lastSeenId: newest,
      unseen: 0,
    });
    // ...and a lagging tab's stale mark never uncovers what was shown.
    const stale = await app.inject({
      method: "PUT",
      url: `/api/identities/${identityId}/notifications/seen`,
      headers,
      payload: { lastSeenId: 1 },
    });
    expect(stale.json<{ lastSeenId: number }>().lastSeenId).toBe(newest);

    // Multi-device: the moved watermark is fanned out, so another attached
    // browser's bell drops with this one instead of badging what was read.
    expect(broadcasts.mock.calls).toContainEqual([
      identityId,
      { kind: "notification.seen", d: { lastSeenId: newest, unseen: 0 } },
    ]);
    broadcasts.mockRestore();

    // A newer entry badges again, past the watermark.
    await store.recordRtb(identityId, "friendrequest", "Nyx Firemane");
    const after = await app.inject({
      method: "GET",
      url: `/api/identities/${identityId}/notifications?limit=50`,
      headers,
    });
    expect(after.json<{ unseen: number }>().unseen).toBe(1);
  });

  it("refuses an identity the caller does not own", async () => {
    const mine = await startIdentity();
    const other = await startIdentity();
    const response = await app.inject({
      method: "GET",
      url: `/api/identities/${mine.identityId}/notifications`,
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("notification inbox — lifecycle", () => {
  it("prunes down to the newest N per identity", async () => {
    const { identityId } = await startIdentity();
    const store = new NotificationStore(db, undefined, { maxPerIdentity: 3 });
    for (let i = 1; i <= 6; i += 1) {
      await store.recordRtb(
        identityId,
        "note",
        "Nyx Firemane",
        `p${String(i)}`,
      );
    }
    // The counter-driven pass has not fired yet at this volume — the cap is a
    // ceiling on growth, so ask for the pass explicitly.
    expect(await store.prune(identityId)).toBe(3);
    const rows = await rowsFor(identityId);
    expect(rows.map((row) => row.excerpt)).toEqual(["p4", "p5", "p6"]);
  });

  it("loses a mention entry when retention deletes its message", async () => {
    const { identityId, session } = await startIdentity();
    await joinAndSettle(session, "Frontpage");
    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: `about you, ${CHARACTER}`,
        channel: "Frontpage",
      },
    });
    await settle();
    const [row] = await rowsFor(identityId);
    expect(row?.messageId).not.toBeNull();

    // Age this identity's messages past the policy, then sweep: the cascade
    // must take the inbox row with it rather than leave a jump target
    // pointing at nothing.
    const [conversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.identityId, identityId))
      .limit(1);
    await db
      .update(messages)
      .set({ createdAt: new Date(Date.now() - 400 * 86_400_000) })
      .where(eq(messages.conversationId, conversation!.id));
    const retention = new RetentionJob({
      db,
      policy: "90d",
      sweepIntervalMs: 60_000,
    });
    expect((await retention.sweepOnce()).deleted).toBeGreaterThan(0);
    expect(await rowsFor(identityId)).toHaveLength(0);
  });
});

describe("excerptOf", () => {
  it("strips BBCode, collapses whitespace and truncates", () => {
    expect(excerptOf("[b]bold[/b]  and\n[i]more[/i]")).toBe("bold and more");
    expect(excerptOf("x".repeat(300))).toHaveLength(160);
    expect(excerptOf("x".repeat(300)).endsWith("…")).toBe(true);
  });
});
