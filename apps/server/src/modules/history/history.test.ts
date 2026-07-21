// Integration tests: history sink + cursor pagination against real Postgres
// (testcontainers) and fchat-sim. Each scenario goes through the production
// path: register → add F-List account (vaults the password) → start the
// session via app.sessions, so the sink attaches exactly as in production.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq, sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FchatSim } from "@emberchat/fchat-sim";
import { serializeServerCommand } from "@emberchat/fchat-protocol";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createDb, type Db } from "../../db/index.js";
import { conversations, identities, messages } from "../../db/schema.js";
import { FlistApiClient } from "../flist-api/api-client.js";
import { CATCHUP_REPLAY_BUDGET, catchupPlan } from "../gateway/snapshot.js";
import type { FchatSession } from "../session-engine/fchat-session.js";
import { RetentionJob } from "./retention.js";
import { exportChunks, type ExportRow } from "./routes.js";
import { SessionEventBus } from "../session-engine/event-bus.js";
import {
  ConversationLimitError,
  HistorySink,
  type ConversationRow,
} from "./sink.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const ACCOUNT = "amber@example.test";
const CHARACTER = "Amber Vale";

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
}, 180_000);

afterAll(async () => {
  await app.close(); // onClose stops all sessions
  await pool.end();
  await container.stop();
  await sim.stop();
});

let userCounter = 0;
/** Registers a fresh app user; returns its access token. */
async function registerUser(): Promise<string> {
  userCounter += 1;
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `history-${String(userCounter)}@example.test`,
      username: `history${String(userCounter)}`,
      password: "hunter2hunter2",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ accessToken: string }>().accessToken;
}

/**
 * Production path to a live session: fresh user, add-account (which verifies
 * against the sim and vaults the password), an identity row (CRUD arrives in
 * a later step), then app.sessions.start. Every scenario logs in the same
 * character, so the previous session is stopped first — otherwise the sim
 * displaces it and it would reconnect mid-test and displace ours back.
 */
let lastIdentityId: string | undefined;
async function startIdentity(): Promise<{
  identityId: string;
  session: FchatSession;
  token: string;
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
  return { identityId: identity!.id, session, token };
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

/** Joins a channel and resolves when its CDS arrived. */
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

describe("history sink", () => {
  it("persists inbound channel messages, PMs, and channel SYS", async () => {
    const { identityId, session } = await startIdentity();
    await joinAndSettle(session, "Frontpage");

    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: "Welcome, [b]traveler[/b]!",
        channel: "Frontpage",
      },
    });
    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Tally Marsh",
        message: "Second message.",
        channel: "Frontpage",
      },
    });
    await inject(session, {
      cmd: "PRI",
      payload: { character: "Nyx Firemane", message: "psst, over here" },
    });
    await inject(session, {
      cmd: "SYS",
      payload: { message: "Channel notice.", channel: "Frontpage" },
    });
    await app.history.flush();

    const convs = await db
      .select()
      .from(conversations)
      .where(eq(conversations.identityId, identityId));
    expect(convs).toHaveLength(2);
    const channelConv = convs.find((c) => c.kind === "channel");
    const pmConv = convs.find((c) => c.kind === "pm");
    expect(channelConv).toMatchObject({
      channelKey: "Frontpage",
      title: "Frontpage",
      joined: true,
    });
    expect(pmConv).toMatchObject({
      partnerCharacter: "Nyx Firemane",
      title: "Nyx Firemane",
    });

    const channelRows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, channelConv!.id))
      .orderBy(messages.id);
    expect(
      channelRows.map((r) => [r.kind, r.senderCharacter, r.bbcode]),
    ).toEqual([
      ["msg", "Nyx Firemane", "Welcome, [b]traveler[/b]!"],
      ["msg", "Tally Marsh", "Second message."],
      ["sys", "", "Channel notice."],
    ]);

    const pmRows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, pmConv!.id));
    expect(pmRows).toHaveLength(1);
    expect(pmRows[0]).toMatchObject({
      kind: "pm",
      senderCharacter: "Nyx Firemane",
      bbcode: "psst, over here",
      sentByUs: false,
    });
  });

  it("persists our own sends with sentByUs", async () => {
    const { identityId, session } = await startIdentity();
    await joinAndSettle(session, "Development");

    await session.sendChannelMessage("Development", "shipping it");
    await app.history.flush();

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.identityId, identityId));
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "msg",
      senderCharacter: CHARACTER,
      bbcode: "shipping it",
      sentByUs: true,
    });
  });

  it("persists ads and rolls with their own kinds (M6)", async () => {
    const { identityId, session } = await startIdentity();
    await joinAndSettle(session, "Development");

    // Inbound ad from someone else.
    await inject(session, {
      cmd: "LRP",
      payload: {
        character: "Tally Marsh",
        message: "[b]Open for scenes![/b]",
        channel: "Development",
      },
    });
    // Our own send goes out as an LRP frame → persisted as a sent ad.
    await session.sendChannelAd("Development", "Looking for a partner.");
    // Rolls are echoed to everyone including the roller; sentByUs follows
    // the character on the payload.
    await inject(session, {
      cmd: "RLL",
      payload: {
        channel: "Development",
        type: "dice",
        message: `[b]${CHARACTER}[/b] rolls 1d6: [b]4[/b]`,
        character: CHARACTER,
        results: [4],
        rolls: ["1d6"],
        endresult: 4,
      },
    });
    await app.history.flush();

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.identityId, identityId));
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv!.id))
      .orderBy(messages.id);
    expect(rows.map((r) => [r.kind, r.senderCharacter, r.sentByUs])).toEqual([
      ["lrp", "Tally Marsh", false],
      ["lrp", CHARACTER, true],
      ["rll", CHARACTER, true],
    ]);
  });

  it("merges PM threads case-insensitively (F-Chat resolves recipients regardless of casing)", async () => {
    const { identityId, session } = await startIdentity();

    // Outbound to a lowercased name, then the reply arrives with the
    // canonical casing — one thread, not two.
    const opened = await app.history.ensurePmConversation(
      identityId,
      "nyx firemane",
    );
    await inject(session, {
      cmd: "PRI",
      payload: { character: "Nyx Firemane", message: "one thread" },
    });
    await app.history.flush();

    const convs = await db
      .select()
      .from(conversations)
      .where(eq(conversations.identityId, identityId));
    expect(convs).toHaveLength(1);
    expect(convs[0]!.id).toBe(opened.id);

    const again = await app.history.ensurePmConversation(
      identityId,
      "NYX FIREMANE",
    );
    expect(again.id).toBe(opened.id);
  });

  it("caps client-initiated conversation creation per identity", async () => {
    const { identityId } = await startIdentity();
    const cappedSink = new HistorySink(db, undefined, {
      maxConversationsPerIdentity: 2,
    });
    await cappedSink.ensurePmConversation(identityId, "Partner One");
    await cappedSink.ensurePmConversation(identityId, "Partner Two");
    await expect(
      cappedSink.ensurePmConversation(identityId, "Partner Three"),
    ).rejects.toThrow(ConversationLimitError);
    // Existing conversations still resolve under the cap.
    await expect(
      cappedSink.ensurePmConversation(identityId, "partner one"),
    ).resolves.toMatchObject({ partnerCharacter: "Partner One" });
  });

  it("clamps read-cursor acks to the conversation's real newest message", async () => {
    const { identityId, session } = await startIdentity();
    await inject(session, {
      cmd: "PRI",
      payload: { character: "Nyx Firemane", message: "clamp me" },
    });
    await app.history.flush();
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.identityId, identityId));
    const [message] = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv!.id));

    // A bogus huge ack must not pin the cursor above future messages.
    const row = await app.history.markRead(
      identityId,
      conv!.id,
      Number.MAX_SAFE_INTEGER,
    );
    expect(row?.lastReadMessageId).toBe(message!.id);

    // Still monotonic: a stale ack never regresses the cursor.
    const stale = await app.history.markRead(identityId, conv!.id, 1);
    expect(stale?.lastReadMessageId).toBe(message!.id);
  });

  it("pins conversations and seeds connect/resume channel sets (decisions.md §9)", async () => {
    const { identityId } = await startIdentity();
    const insertChannel = async (
      key: string,
      flags: { pinned: boolean; joined: boolean },
    ) => {
      const [row] = await db
        .insert(conversations)
        .values({
          identityId,
          kind: "channel",
          channelKey: key,
          title: key,
          ...flags,
        })
        .returning();
      return row!;
    };
    const pinnedJoined = await insertChannel("Pinned Joined", {
      pinned: true,
      joined: true,
    });
    const casual = await insertChannel("Casual", {
      pinned: false,
      joined: true,
    });
    await insertChannel("Pinned Left", { pinned: true, joined: false });
    // A joined PM row must never leak into channel seeds.
    await db.insert(conversations).values({
      identityId,
      kind: "pm",
      partnerCharacter: "Nyx Firemane",
      title: "Nyx Firemane",
      joined: true,
    });

    const events: ConversationRow[] = [];
    const off = app.history.events.on("conversation", (event) => {
      if (event.identityId === identityId) {
        events.push(event.conversation);
      }
    });

    // Restart recovery: the channels the identity was in, plus every pin —
    // pinned means auto-rejoin (#169) even when the joined flag was lost.
    expect((await app.history.channelsForResume(identityId)).sort()).toEqual([
      "Casual",
      "Pinned Joined",
      "Pinned Left",
    ]);

    // Explicit return from a log-off: the pinned seed is a pure read…
    expect((await app.history.pinnedChannelKeys(identityId)).sort()).toEqual([
      "Pinned Joined",
      "Pinned Left",
    ]);
    const [casualBefore] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, casual.id));
    expect(casualBefore?.joined).toBe(true);

    // …and the destructive reconcile is a separate, queued step that flips
    // the casually joined row to joined = false (with a fan-out event).
    app.history.reconcileJoinedForConnect(identityId);
    await app.history.flush();
    const [casualAfter] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, casual.id));
    expect(casualAfter?.joined).toBe(false);
    expect(events.some((c) => c.id === casual.id && !c.joined)).toBe(true);

    // A later restart recovery no longer resurrects the reconciled channel.
    expect((await app.history.channelsForResume(identityId)).sort()).toEqual([
      "Pinned Joined",
      "Pinned Left",
    ]);

    // Explicit leave unpins (#169) — and the auto-rejoin union drops it.
    await app.history.unpinChannelForLeave(identityId, "Pinned Left");
    expect(
      events.some((c) => c.channelKey === "Pinned Left" && !c.pinned),
    ).toBe(true);
    expect(await app.history.channelsForResume(identityId)).toEqual([
      "Pinned Joined",
    ]);
    expect((await app.history.pinnedChannelKeys(identityId)).sort()).toEqual([
      "Pinned Joined",
    ]);
    // Unpinning an already-unpinned channel is a silent no-op.
    const before = events.length;
    await app.history.unpinChannelForLeave(identityId, "Pinned Left");
    expect(events.length).toBe(before);

    // Pin round trip: persists, emits, scoped to the owning identity.
    const unpinned = await app.history.setPinned(
      identityId,
      pinnedJoined.id,
      false,
    );
    expect(unpinned?.pinned).toBe(false);
    expect(events.some((c) => c.id === pinnedJoined.id && !c.pinned)).toBe(
      true,
    );
    expect(
      await app.history.setPinned(
        identityId,
        "00000000-0000-7000-8000-000000000000",
        true,
      ),
    ).toBeUndefined();
    off();
  });

  it("shards the write queue per identity — one identity's stalled write never blocks another's", async () => {
    // Two identities on the same F-List account; sink events come from fake
    // session buses so each identity's traffic can be driven independently
    // (the sink only reads `events`, `character`, and `state.channels`).
    const { identityId: identityA } = await startIdentity();
    const [accountRow] = await db
      .select({ flistAccountId: identities.flistAccountId })
      .from(identities)
      .where(eq(identities.id, identityA));
    const [identityRowB] = await db
      .insert(identities)
      .values({
        flistAccountId: accountRow!.flistAccountId,
        characterName: "Bee Wildfire",
      })
      .returning({ id: identities.id });
    const identityB = identityRowB!.id;

    const fakeSession = (character: string) =>
      ({
        character,
        events: new SessionEventBus(),
        state: { channels: new Map() },
      }) as unknown as FchatSession;
    const sessionA = fakeSession(CHARACTER);
    const sessionB = fakeSession("Bee Wildfire");
    const sink = new HistorySink(db);
    sink.attach(identityA, sessionA);
    sink.attach(identityB, sessionB);

    const messagesFor = (identityId: string) =>
      db
        .select({ bbcode: messages.bbcode })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(eq(conversations.identityId, identityId))
        .orderBy(messages.id);

    // Stall identity A's next message insert: an open FOR UPDATE on its
    // conversation row blocks the insert's FK KEY SHARE lock on that row.
    const convA = await sink.ensurePmConversation(identityA, "Nyx Firemane");
    let releaseLock!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockAcquired!: () => void;
    const locked = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const lockHolder = db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from ${conversations} where id = ${convA.id} for update`,
      );
      lockAcquired();
      await gate;
    });
    await locked;

    try {
      sessionA.events.emit("command", {
        cmd: "PRI",
        payload: { character: "Nyx Firemane", message: "stalled write" },
      });
      sessionB.events.emit("command", {
        cmd: "PRI",
        payload: { character: "Nyx Firemane", message: "independent write" },
      });

      // B's write lands while A's chain is still stuck behind the row lock.
      await vi.waitFor(async () => {
        const rows = await messagesFor(identityB);
        expect(rows.map((r) => r.bbcode)).toEqual(["independent write"]);
      });
      expect(await messagesFor(identityA)).toHaveLength(0);
    } finally {
      releaseLock();
    }

    await lockHolder;
    await sink.flush();
    expect((await messagesFor(identityA)).map((r) => r.bbcode)).toEqual([
      "stalled write",
    ]);
  });

  it("tracks the joined flag across join and leave", async () => {
    const { identityId, session } = await startIdentity();
    await joinAndSettle(session, "Frontpage");
    await app.history.flush();

    const joined = await db
      .select({ joined: conversations.joined })
      .from(conversations)
      .where(eq(conversations.identityId, identityId));
    expect(joined).toEqual([{ joined: true }]);

    session.leaveChannel("Frontpage");
    await vi.waitFor(async () => {
      await app.history.flush();
      const [row] = await db
        .select({ joined: conversations.joined })
        .from(conversations)
        .where(eq(conversations.identityId, identityId));
      expect(row?.joined).toBe(false);
    });
  });
});

describe("history pagination", () => {
  /** Seeds a conversation with n numbered messages, bypassing the sim. */
  async function seedConversation(n: number) {
    const { identityId, token } = await startIdentity();
    const [conv] = await db
      .insert(conversations)
      .values({
        identityId,
        kind: "channel",
        channelKey: "Seeded",
        title: "Seeded",
      })
      .returning({ id: conversations.id });
    for (let i = 1; i <= n; i += 1) {
      await db.insert(messages).values({
        conversationId: conv!.id,
        senderCharacter: "Nyx Firemane",
        kind: "msg",
        bbcode: `message ${String(i)}`,
      });
    }
    return { identityId, conversationId: conv!.id, token };
  }

  function getMessages(
    identityId: string,
    conversationId: string,
    query: string,
    token: string,
  ) {
    return app.inject({
      method: "GET",
      url: `/api/identities/${identityId}/conversations/${conversationId}/messages${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("walks history backwards with the before cursor, pages ascending", async () => {
    const { identityId, conversationId, token } = await seedConversation(7);

    const first = await getMessages(
      identityId,
      conversationId,
      "?limit=3",
      token,
    );
    expect(first.statusCode).toBe(200);
    const page1 = first.json<{
      messages: { id: number; bbcode: string }[];
      hasMore: boolean;
    }>();
    expect(page1.messages.map((m) => m.bbcode)).toEqual([
      "message 5",
      "message 6",
      "message 7",
    ]);
    expect(page1.hasMore).toBe(true);

    const second = await getMessages(
      identityId,
      conversationId,
      `?limit=3&before=${String(page1.messages[0]!.id)}`,
      token,
    );
    const page2 = second.json<typeof page1>();
    expect(page2.messages.map((m) => m.bbcode)).toEqual([
      "message 2",
      "message 3",
      "message 4",
    ]);
    expect(page2.hasMore).toBe(true);

    const third = await getMessages(
      identityId,
      conversationId,
      `?limit=3&before=${String(page2.messages[0]!.id)}`,
      token,
    );
    const page3 = third.json<typeof page1>();
    expect(page3.messages.map((m) => m.bbcode)).toEqual(["message 1"]);
    expect(page3.hasMore).toBe(false);
  });

  it("searches the identity's log with filters, cursor-paged (M9)", async () => {
    const { identityId, conversationId, token } = await seedConversation(3);
    // A second conversation proves scoping; a foreign sender proves from:.
    const [other] = await db
      .insert(conversations)
      .values({
        identityId,
        kind: "channel",
        channelKey: "Elsewhere",
        title: "Elsewhere",
      })
      .returning({ id: conversations.id });
    await db.insert(messages).values({
      conversationId: other!.id,
      senderCharacter: "Tally Marsh",
      kind: "msg",
      bbcode: "a message about teacups",
    });

    const search = (query: string) =>
      app.inject({
        method: "GET",
        url: `/api/identities/${identityId}/search?${query}`,
        headers: { authorization: `Bearer ${token}` },
      });

    // Free text, everywhere: hits both conversations' bodies.
    const all = await search(`q=${encodeURIComponent("message")}`);
    expect(all.statusCode).toBe(200);
    const everywhere = all.json<{
      results: { bbcode: string; conversationTitle: string }[];
    }>();
    expect(everywhere.results).toHaveLength(4);
    expect(everywhere.results[0]!.conversationTitle).toBe("Elsewhere");

    // Scoped to the seeded conversation.
    const scoped = await search(
      `q=${encodeURIComponent("message")}&convId=${conversationId}`,
    );
    expect(scoped.json<{ results: unknown[] }>().results).toHaveLength(3);

    // from: filter (case-insensitive, quoted name with a space).
    const bySender = await search(
      `q=${encodeURIComponent('message from:"tally marsh"')}`,
    );
    const senderHits = bySender.json<{ results: { bbcode: string }[] }>();
    expect(senderHits.results).toHaveLength(1);
    expect(senderHits.results[0]!.bbcode).toContain("teacups");

    // Cursor paging, newest first.
    const page1 = await search(`q=${encodeURIComponent("message")}&limit=3`);
    const body1 = page1.json<{
      results: { id: number }[];
      nextCursor?: number;
    }>();
    expect(body1.results).toHaveLength(3);
    expect(body1.nextCursor).toBeDefined();
    const page2 = await search(
      `q=${encodeURIComponent("message")}&limit=3&cursor=${String(body1.nextCursor)}`,
    );
    const body2 = page2.json<typeof body1>();
    expect(body2.results).toHaveLength(1);
    expect(body2.nextCursor).toBeUndefined();

    // ILIKE wildcards in user text match literally, never as wildcards.
    const literal = await search(`q=${encodeURIComponent("100%")}`);
    expect(literal.json<{ results: unknown[] }>().results).toHaveLength(0);

    // Filter-only queries need no free text; empty-after-parse is a 400.
    const filterOnly = await search(
      `q=${encodeURIComponent('from:"Nyx Firemane"')}`,
    );
    expect(filterOnly.json<{ results: unknown[] }>().results).toHaveLength(3);
    const dateOnly = await search(
      `q=${encodeURIComponent("before:2030-01-01")}`,
    );
    expect(dateOnly.statusCode).toBe(400);
  });

  it("lists conversations for the identity", async () => {
    const { identityId, token } = await seedConversation(1);
    const response = await app.inject({
      method: "GET",
      url: `/api/identities/${identityId}/conversations`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ conversations: { title: string }[] }>();
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]).toMatchObject({
      title: "Seeded",
      kind: "channel",
      channelKey: "Seeded",
    });
  });

  it("hides other users' identities and rejects missing tokens", async () => {
    const { identityId, conversationId, token } = await seedConversation(1);
    const otherToken = await registerUser();

    const foreign = await getMessages(
      identityId,
      conversationId,
      "",
      otherToken,
    );
    expect(foreign.statusCode).toBe(404);

    const anonymous = await app.inject({
      method: "GET",
      url: `/api/identities/${identityId}/conversations/${conversationId}/messages`,
    });
    expect(anonymous.statusCode).toBe(401);

    const wrongConversation = await getMessages(
      identityId,
      "00000000-0000-7000-8000-000000000000",
      "",
      token,
    );
    expect(wrongConversation.statusCode).toBe(404);
  });

  it("streams multi-page exports as well-formed documents (M7)", async () => {
    const at = (i: number): ExportRow => ({
      id: i,
      senderCharacter: "Nyx Firemane",
      kind: "msg",
      bbcode: `line ${String(i)}`,
      sentByUs: false,
      createdAt: new Date(1_700_000_000_000 + i),
    });
    // 5 rows through 2-row pages: 3 reads, the last one short.
    const all = [1, 2, 3, 4, 5].map(at);
    const readPage = (afterId: number) =>
      Promise.resolve(all.filter((row) => row.id > afterId).slice(0, 2));

    const collect = async (format: "txt" | "html" | "json") => {
      let out = "";
      for await (const chunk of exportChunks(format, "Paged", readPage, 2)) {
        out += chunk;
      }
      return out;
    };

    const json = JSON.parse(await collect("json")) as {
      title: string;
      messages: { id: number }[];
    };
    expect(json.title).toBe("Paged");
    expect(json.messages.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);

    const txt = await collect("txt");
    expect(txt.split("\n").filter(Boolean)).toHaveLength(5);
    expect(txt).toContain("Nyx Firemane: line 5");

    const html = await collect("html");
    expect(html).toContain("<!doctype html>");
    expect(html.trimEnd().endsWith("</body></html>")).toBe(true);
    expect(html.match(/<div>/g)).toHaveLength(5);
  });

  it("retention sweep deletes only messages older than the policy cutoff (M7)", async () => {
    const { conversationId } = await seedConversation(2); // two fresh rows
    await db.insert(messages).values({
      conversationId,
      senderCharacter: "Nyx Firemane",
      kind: "msg",
      bbcode: "ancient history",
      createdAt: new Date(Date.now() - 40 * 86_400_000),
    });
    const job = new RetentionJob({
      db,
      policy: "30d",
      sweepIntervalMs: 60_000,
    });
    const { deleted } = await job.sweepOnce();
    expect(deleted).toBeGreaterThanOrEqual(1);
    const remaining = await db
      .select({ bbcode: messages.bbcode })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(remaining.map((r) => r.bbcode)).toEqual(["message 1", "message 2"]);
  });

  it("caps a resuming cursor's replay at the budget (M7)", async () => {
    const { identityId, conversationId } = await seedConversation(3);
    const [row] = await db
      .select({ maxId: sql<number>`max(${messages.id})`.mapWith(Number) })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    const maxId = row!.maxId;
    // A cursor far beyond the budget is floored AND flagged as a gap (the
    // client must reset, not merge into the unreachable interior hole).
    const plan = await catchupPlan(
      db,
      identityId,
      { [conversationId]: maxId - CATCHUP_REPLAY_BUDGET - 500 },
      50,
    );
    expect(plan).toEqual([
      {
        convId: conversationId,
        afterId: maxId - CATCHUP_REPLAY_BUDGET,
        gap: true,
      },
    ]);
    // A near cursor is honored verbatim and carries no gap.
    const near = await catchupPlan(
      db,
      identityId,
      { [conversationId]: maxId - 1 },
      50,
    );
    expect(near).toEqual([
      { convId: conversationId, afterId: maxId - 1, gap: false },
    ]);
  });

  it("exports the whole log as txt, html and json (M5 Away & logs)", async () => {
    const { identityId, conversationId, token } = await seedConversation(2);
    // A sys line and a markup-bearing body (the html export must escape it).
    await db.insert(messages).values({
      conversationId,
      senderCharacter: "System",
      kind: "sys",
      bbcode: "Nyx Firemane joined",
    });
    await db.insert(messages).values({
      conversationId,
      senderCharacter: "Nyx Firemane",
      kind: "msg",
      bbcode: "<script>alert(1)</script>",
    });

    const get = (format: string, tok = token) =>
      app.inject({
        method: "GET",
        url: `/api/identities/${identityId}/conversations/${conversationId}/export?format=${format}`,
        headers: { authorization: `Bearer ${tok}` },
      });

    const txt = await get("txt");
    expect(txt.statusCode).toBe(200);
    expect(txt.headers["content-type"]).toContain("text/plain");
    expect(txt.headers["content-disposition"]).toContain(
      'filename="Seeded.txt"',
    );
    expect(txt.body).toContain("Nyx Firemane: message 1");
    expect(txt.body).toContain("* Nyx Firemane joined");

    const html = await get("html");
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.body).toContain("<b>Nyx Firemane</b>: message 2");
    // Message bodies are content, never markup.
    expect(html.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html.body).not.toContain("<script>");

    const json = await get("json");
    expect(json.statusCode).toBe(200);
    expect(json.headers["content-type"]).toContain("application/json");
    const parsed = JSON.parse(json.body) as {
      title: string;
      messages: { sender: string; bbcode: string; kind: string }[];
    };
    expect(parsed.title).toBe("Seeded");
    expect(parsed.messages).toHaveLength(4);
    expect(parsed.messages[0]).toMatchObject({
      sender: "Nyx Firemane",
      bbcode: "message 1",
      kind: "msg",
    });

    // Ownership and validation gates match the other history routes.
    const otherToken = await registerUser();
    expect((await get("txt", otherToken)).statusCode).toBe(404);
    expect((await get("csv")).statusCode).toBe(400);
  });
});
