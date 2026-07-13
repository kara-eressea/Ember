// Integration tests: history sink + cursor pagination against real Postgres
// (testcontainers) and fchat-sim. Each scenario goes through the production
// path: register → add F-List account (vaults the password) → start the
// session via app.sessions, so the sink attaches exactly as in production.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FchatSim } from "@emberline/fchat-sim";
import { serializeServerCommand } from "@emberline/fchat-protocol";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createDb, type Db } from "../../db/index.js";
import { conversations, identities, messages } from "../../db/schema.js";
import { FlistApiClient } from "../flist-api/api-client.js";
import type { FchatSession } from "../session-engine/fchat-session.js";
import { ConversationLimitError, HistorySink } from "./sink.js";

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
});
