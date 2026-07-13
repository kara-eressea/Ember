// Gateway integration tests against real Postgres (testcontainers), fchat-sim
// and a listening HTTP server — app.inject cannot carry a WebSocket upgrade,
// so the suite talks to /gateway over real sockets like a browser would.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { FchatSim } from "@emberchat/fchat-sim";
import { serializeServerCommand } from "@emberchat/fchat-protocol";
import {
  GATEWAY_CLOSE,
  PROTOCOL_VERSION,
  type ClientFrame,
  type ResumeCursors,
  type ServerFrame,
} from "@emberchat/protocol";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createDb, type Db } from "../../db/index.js";
import {
  authSessions,
  conversations,
  identities,
  messages,
} from "../../db/schema.js";
import { FlistApiClient } from "../flist-api/api-client.js";
import type { FchatSession } from "../session-engine/fchat-session.js";
import { MAX_FRAMES_PER_MINUTE } from "./connection.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const ACCOUNT = "amber@example.test";
const CHARACTER = "Amber Vale";

// Sim-backed round trips (connect → IDN → join → relay) outgrow the 5s default.
vi.setConfig({ testTimeout: 15_000 });

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: { end: () => Promise<void> };
let sim: FchatSim;
let app: FastifyInstance;
let gatewayUrl: string;

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
    // The reconnect scenario can't wait out the 10s policy floor.
    sessionTuning: { backoffFloorMs: 200, backoffCapMs: 400 },
  });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  gatewayUrl = `${address.replace(/^http/, "ws")}/gateway`;
}, 180_000);

afterAll(async () => {
  await app.close(); // onClose stops all sessions
  await pool.end();
  await container.stop();
  await sim.stop();
});

// ── Test gateway client ───────────────────────────────────────────────────────

class TestClient {
  readonly #socket: WebSocket;
  readonly #frames: ServerFrame[] = [];
  #wake: (() => void) | undefined;
  #closed: { code: number; reason: string } | undefined;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data: WebSocket.RawData) => {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- RawData decode
      this.#frames.push(JSON.parse(data.toString()) as ServerFrame);
      this.#wake?.();
    });
    socket.on("close", (code, reason) => {
      this.#closed = { code, reason: reason.toString() };
      this.#wake?.();
    });
  }

  static connect(): Promise<TestClient> {
    const socket = new WebSocket(gatewayUrl);
    const client = new TestClient(socket);
    return new Promise((resolve, reject) => {
      socket.once("open", () => {
        resolve(client);
      });
      socket.once("error", reject);
    });
  }

  send(frame: ClientFrame): void {
    this.#socket.send(JSON.stringify(frame));
  }

  /** Removes and returns the first frame matching the predicate, in arrival
   * order; waits for it if it has not arrived yet. */
  async next<T extends ServerFrame>(
    predicate: (frame: ServerFrame) => frame is T,
    timeoutMs = 5000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.#frames.findIndex(predicate);
      if (index !== -1) {
        return this.#frames.splice(index, 1)[0] as T;
      }
      if (this.#closed) {
        throw new Error(
          `socket closed (${String(this.#closed.code)}) while waiting`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `timed out; buffered: ${JSON.stringify(this.#frames.map((f) => f.t))}`,
        );
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        setTimeout(resolve, remaining);
      });
    }
  }

  nextOfType<T extends ServerFrame["t"]>(t: T, timeoutMs = 5000) {
    return this.next(
      (frame): frame is Extract<ServerFrame, { t: T }> => frame.t === t,
      timeoutMs,
    );
  }

  nextEvent<K extends string>(kind: K, timeoutMs = 5000) {
    return this.next(
      (
        frame,
      ): frame is Extract<ServerFrame, { t: "event" }> & {
        d: { kind: K };
      } => frame.t === "event" && frame.d.kind === kind,
      timeoutMs,
    );
  }

  async hello(token: string, resume?: ResumeCursors) {
    this.send({
      t: "hello",
      d: {
        token,
        protocolVersion: PROTOCOL_VERSION,
        ...(resume ? { resume } : {}),
      },
    });
    return this.nextOfType("ready");
  }

  async subscribe(identityId: string) {
    this.send({ t: "sub", d: { identityId } });
    return this.nextOfType("snapshot");
  }

  waitForClose(timeoutMs = 5000): Promise<{ code: number; reason: string }> {
    if (this.#closed) {
      return Promise.resolve(this.#closed);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for close"));
      }, timeoutMs);
      this.#socket.on("close", (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
    });
  }

  close(): void {
    this.#socket.close();
  }

  get bufferedFrames(): readonly ServerFrame[] {
    return this.#frames;
  }
}

const openClients: TestClient[] = [];
async function connectClient(): Promise<TestClient> {
  const client = await TestClient.connect();
  openClients.push(client);
  return client;
}
afterEach(() => {
  for (const client of openClients.splice(0)) {
    client.close();
  }
});

// ── Production-path setup helpers (mirrors history.test.ts) ─────────────────

let userCounter = 0;
async function registerUser(): Promise<string> {
  userCounter += 1;
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `gateway-${String(userCounter)}@example.test`,
      username: `gateway${String(userCounter)}`,
      password: "hunter2hunter2",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ accessToken: string }>().accessToken;
}

/**
 * Fresh user + vaulted account + identity row. Every scenario logs in the
 * same character, so the previous scenario's session is stopped first —
 * otherwise the sim displaces it and it reconnects mid-test.
 */
let lastIdentityId: string | undefined;
async function createIdentity(): Promise<{
  identityId: string;
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
  lastIdentityId = identity!.id;
  return { identityId: identity!.id, token };
}

function waitForOnline(session: FchatSession): Promise<void> {
  if (session.status === "online") {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for online (${session.status})`));
    }, 10_000);
    session.events.on("status", (event) => {
      if (event.status === "online") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

/** Starts the session directly (as cmd session.connect would). */
async function startSession(identityId: string): Promise<FchatSession> {
  const [row] = await db
    .select()
    .from(identities)
    .where(eq(identities.id, identityId));
  const session = app.sessions.start({
    identityId,
    character: CHARACTER,
    accountId: row!.flistAccountId,
    accountName: ACCOUNT,
  });
  await waitForOnline(session);
  return session;
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

/** The nested event payload: event frames are `{ t, d: { identityId, kind, d } }`. */
function eventPayload<T>(frame: { d: unknown }): T {
  return (frame.d as { d: T }).d;
}

/** Consumes conversation.updated events until one matches the predicate —
 * conversation creation emits an update too, so tests skip ahead to the
 * state they care about. */
async function nextConversationUpdate<
  T extends { id: string; lastReadMessageId: number | null },
>(client: TestClient, predicate: (conversation: T) => boolean): Promise<T> {
  for (;;) {
    const frame = await client.nextEvent("conversation.updated");
    const { conversation } = eventPayload<{ conversation: T }>(frame);
    if (predicate(conversation)) {
      return conversation;
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("channel rejoin semantics (decisions.md §9)", () => {
  it("pins over the gateway; an explicit reconnect rejoins pinned channels only", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Frontpage");
    await joinAndSettle(session, "Development");
    await app.history.flush();

    const client = await connectClient();
    await client.hello(token);
    const snapshot = await client.subscribe(identityId);
    const frontpage = snapshot.d.channels.find((c) => c.key === "Frontpage");
    expect(frontpage).toBeDefined();

    // conv.pin: ack carries the updated conversation, and the update fans out.
    client.send({
      t: "cmd",
      id: 1,
      d: {
        identityId,
        action: "conv.pin",
        d: { convId: frontpage!.convId, pinned: true },
      },
    });
    const pinAck = await client.nextOfType("ack");
    expect(pinAck.d).toMatchObject({
      ok: true,
      conversation: { id: frontpage!.convId, pinned: true },
    });
    await nextConversationUpdate<{
      id: string;
      lastReadMessageId: number | null;
      pinned: boolean;
    }>(client, (c) => c.id === frontpage!.convId && c.pinned);

    // Explicit disconnect, then connect: the user chose to log off, so only
    // the pinned channel comes back and the casual one reconciles to
    // joined = false.
    client.send({
      t: "cmd",
      id: 2,
      d: { identityId, action: "session.disconnect" },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    client.send({
      t: "cmd",
      id: 3,
      d: { identityId, action: "session.connect" },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);

    const fresh = app.sessions.get(identityId);
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(session);
    await waitForOnline(fresh!);
    await vi.waitFor(() => {
      expect(fresh!.state.channels.has("Frontpage")).toBe(true);
    });
    expect(fresh!.state.channels.has("Development")).toBe(false);

    // The reconcile runs once the session is online, through the sink queue.
    await app.history.flush();
    const [devRow] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.identityId, identityId),
          eq(conversations.channelKey, "Development"),
        ),
      );
    expect(devRow?.joined).toBe(false);

    // A second connect while the session is live must not reseed anything —
    // leave Frontpage, reconnect from another tab, still left.
    fresh!.leaveChannel("Frontpage");
    await vi.waitFor(() => {
      expect(fresh!.state.channels.has("Frontpage")).toBe(false);
    });
    client.send({
      t: "cmd",
      id: 4,
      d: { identityId, action: "session.connect" },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    expect(app.sessions.get(identityId)).toBe(fresh);
    expect(fresh!.state.channels.has("Frontpage")).toBe(false);
  });

  it("recovers an F-Chat drop with no user interaction: re-tickets from the vault, rejoins channels (M2 verification)", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Frontpage");

    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    // Invalidate the server's cached ticket account-wide (a newer ticket
    // always does), then drop the connection: the reconnect must survive the
    // stale-ticket rejection by re-fetching through the vaulted password —
    // the full "re-ticket from the vault" path, not the ticket cache.
    sim.issueTicketFor(ACCOUNT);
    sim.disconnect(CHARACTER);

    // Subscribed browsers watch the outage and recovery as status events.
    for (;;) {
      const frame = await client.nextEvent("session.status", 15_000);
      if (eventPayload<{ status: string }>(frame).status === "online") {
        break;
      }
    }
    await vi.waitFor(() => {
      expect(
        session.state.channels.get("Frontpage")?.members.has(CHARACTER),
      ).toBe(true);
    });
  });

  it("session.connect and session.disconnect maintain the autoConnect intent flag and fan it out", async () => {
    const { identityId, token } = await createIdentity();
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId); // identity.updated arrives via fan-out

    const flag = async () => {
      const [row] = await db
        .select({ autoConnect: identities.autoConnect })
        .from(identities)
        .where(eq(identities.id, identityId));
      return row?.autoConnect;
    };
    expect(await flag()).toBe(false); // direct insert bypasses the API default

    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "session.connect" },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    expect(await flag()).toBe(true);
    expect(
      eventPayload<{ autoConnect: boolean }>(
        await client.nextEvent("identity.updated"),
      ).autoConnect,
    ).toBe(true);

    client.send({
      t: "cmd",
      id: 2,
      d: { identityId, action: "session.disconnect" },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    expect(await flag()).toBe(false);
    expect(
      eventPayload<{ autoConnect: boolean }>(
        await client.nextEvent("identity.updated"),
      ).autoConnect,
    ).toBe(false);
  });

  it("a connect while autoConnect is set is a recovery: exact channels, no reconcile", async () => {
    const { identityId, token } = await createIdentity();
    // Persisted state from "before the outage": flagged for auto-connect,
    // one casually joined channel, one pinned-but-left channel.
    await db
      .update(identities)
      .set({ autoConnect: true })
      .where(eq(identities.id, identityId));
    await db.insert(conversations).values([
      {
        identityId,
        kind: "channel",
        channelKey: "Frontpage",
        title: "Frontpage",
        joined: true,
        pinned: false,
      },
      {
        identityId,
        kind: "channel",
        channelKey: "Development",
        title: "Development",
        joined: false,
        pinned: true,
      },
    ]);

    const client = await connectClient();
    await client.hello(token);
    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "session.connect" },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);

    const session = app.sessions.get(identityId);
    expect(session).toBeDefined();
    await waitForOnline(session!);
    await vi.waitFor(() => {
      expect(session!.state.channels.has("Frontpage")).toBe(true);
    });
    // Recovery restores the joined set, not the pinned set.
    expect(session!.state.channels.has("Development")).toBe(false);

    // And it never reconciles: the casual row keeps its joined flag.
    await app.history.flush();
    const [row] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.identityId, identityId),
          eq(conversations.channelKey, "Frontpage"),
        ),
      );
    expect(row?.joined).toBe(true);
  });

  it("an explicit connect that never reaches online leaves the recovery set intact", async () => {
    const { identityId, token } = await createIdentity(); // autoConnect false
    // A character no longer on the account: identify is rejected until the
    // session gives up — it never reaches online.
    await db
      .update(identities)
      .set({ characterName: "Nobody Real" })
      .where(eq(identities.id, identityId));
    await db.insert(conversations).values({
      identityId,
      kind: "channel",
      channelKey: "Frontpage",
      title: "Frontpage",
      joined: true,
      pinned: false,
    });

    const client = await connectClient();
    await client.hello(token);
    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "session.connect" },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);

    const session = app.sessions.get(identityId);
    expect(session).toBeDefined();
    await vi.waitFor(
      () => {
        expect(session!.status).toBe("stopped");
      },
      { timeout: 10_000 },
    );

    // The destructive scenario-3 reconcile never ran — after re-auth, a
    // recovery still finds the channel set intact.
    await app.history.flush();
    const [row] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.identityId, identityId),
          eq(conversations.channelKey, "Frontpage"),
        ),
      );
    expect(row?.joined).toBe(true);
  });
});

describe("gateway handshake", () => {
  it("answers hello with ready and lists the user's identities", async () => {
    const { identityId, token } = await createIdentity();
    await startSession(identityId);

    const client = await connectClient();
    const ready = await client.hello(token);
    expect(ready.d.identities).toEqual([
      {
        id: identityId,
        name: CHARACTER,
        sessionStatus: "online",
        // Inserted directly by the test helper, so the API default (true)
        // does not apply.
        autoConnect: false,
        unread: 0,
        mentions: 0,
      },
    ]);

    client.send({ t: "ping" });
    await client.nextOfType("pong");
  });

  it("ready carries per-identity badge totals without a session or a sub", async () => {
    const { identityId, token } = await createIdentity();
    // No session started — the rail must paint badges for offline identities
    // (their history persists regardless).
    const [dev, lounge] = await db
      .insert(conversations)
      .values([
        { identityId, kind: "channel", channelKey: "Dev", title: "Dev" },
        { identityId, kind: "channel", channelKey: "Lounge", title: "Lounge" },
      ])
      .returning();
    await db.insert(messages).values([
      {
        conversationId: dev!.id,
        senderCharacter: "Nyx Firemane",
        kind: "msg" as const,
        bbcode: "unread one",
      },
      {
        conversationId: dev!.id,
        senderCharacter: "Nyx Firemane",
        kind: "msg" as const,
        bbcode: `oi ${CHARACTER}!`, // mention
      },
      {
        conversationId: lounge!.id,
        senderCharacter: "Tally Marsh",
        kind: "msg" as const,
        bbcode: "unread two",
      },
      {
        conversationId: lounge!.id,
        senderCharacter: CHARACTER,
        kind: "msg" as const,
        bbcode: `I, ${CHARACTER}, sent this myself`,
        sentByUs: true, // own sends count as neither
      },
    ]);

    const client = await connectClient();
    const ready = await client.hello(token);
    // Totals aggregate across both conversations: 3 inbound unread, 1 mention.
    expect(ready.d.identities[0]).toMatchObject({
      id: identityId,
      sessionStatus: "offline",
      unread: 3,
      mentions: 1,
    });
  });

  it("rejects a bad token and a wrong protocol version", async () => {
    const bad = await connectClient();
    bad.send({
      t: "hello",
      d: { token: "not-a-jwt", protocolVersion: PROTOCOL_VERSION },
    });
    expect((await bad.waitForClose()).code).toBe(GATEWAY_CLOSE.unauthorized);

    const token = await registerUser();
    const wrongVersion = await connectClient();
    wrongVersion.send({
      t: "hello",
      d: { token, protocolVersion: PROTOCOL_VERSION + 1 },
    });
    expect((await wrongVersion.waitForClose()).code).toBe(
      GATEWAY_CLOSE.versionMismatch,
    );
  });

  it("closes pre-hello connections that send garbage", async () => {
    const client = await connectClient();
    client.send({ t: "sub", d: { identityId: "not-even-a-uuid" } } as never);
    expect((await client.waitForClose()).code).toBe(GATEWAY_CLOSE.badRequest);
  });
});

describe("gateway fan-out", () => {
  it("delivers identical event streams to two clients on the same identity", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Frontpage");

    const a = await connectClient();
    const b = await connectClient();
    await a.hello(token);
    await b.hello(token);
    await a.subscribe(identityId);
    await b.subscribe(identityId);

    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: "first",
        channel: "Frontpage",
      },
    });
    await inject(session, {
      cmd: "PRI",
      payload: { character: "Tally Marsh", message: "psst" },
    });
    await inject(session, {
      cmd: "JCH",
      payload: {
        channel: "Frontpage",
        character: { identity: "Nyx Firemane" },
        title: "Frontpage",
      },
    });

    const collect = async (client: TestClient) => [
      await client.nextEvent("message.new"),
      await client.nextEvent("message.new"),
      await client.nextEvent("member.join"),
    ];
    const [fromA, fromB] = await Promise.all([collect(a), collect(b)]);
    expect(fromA).toEqual(fromB);

    const [channelMsg, pm] = fromA as [
      (typeof fromA)[number],
      (typeof fromA)[number],
    ];
    expect(eventPayload<{ message: object }>(channelMsg).message).toMatchObject(
      {
        kind: "msg",
        senderCharacter: "Nyx Firemane",
        bbcode: "first",
        sentByUs: false,
      },
    );
    expect(eventPayload<{ message: object }>(pm).message).toMatchObject({
      kind: "pm",
      bbcode: "psst",
    });
  });

  it("snapshots live channel state with unread and mention counts", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Development");
    const say = (message: string) =>
      inject(session, {
        cmd: "MSG",
        payload: { character: "Nyx Firemane", message, channel: "Development" },
      });
    await say("unread me");
    await say(`hey ${CHARACTER}, look at this`); // mention
    await say("Amber Valery is someone else"); // word boundary: no match
    await inject(session, {
      cmd: "SYS",
      payload: { message: `${CHARACTER} joined`, channel: "Development" },
    }); // sys rows never count as mentions
    // Our own send counts as neither unread nor mention — matching the
    // client's live behavior.
    await session.sendChannelMessage(
      "Development",
      `I, ${CHARACTER}, speak of myself`,
    );
    await app.history.flush();

    // A conversation with more unread than the cap: counting stops at 99.
    const [flooded] = await db
      .insert(conversations)
      .values({
        identityId,
        kind: "channel",
        channelKey: "Flooded",
        title: "Flooded",
      })
      .returning();
    await db.insert(messages).values(
      Array.from({ length: 120 }, (_, i) => ({
        conversationId: flooded!.id,
        senderCharacter: "Nyx Firemane",
        kind: "msg" as const,
        bbcode: `spam ${String(i + 1)}`,
      })),
    );

    const client = await connectClient();
    await client.hello(token);
    const snapshot = await client.subscribe(identityId);
    expect(snapshot.d.self).toEqual({
      character: CHARACTER,
      sessionStatus: "online",
      status: "online",
      statusmsg: "",
      ignores: [],
      // The sim serves the documented default VARs.
      limits: { chatMax: 4096, privMax: 50000 },
    });
    expect(snapshot.d.channels).toHaveLength(2);
    const channel = snapshot.d.channels.find((c) => c.key === "Development")!;
    expect(channel).toMatchObject({
      key: "Development",
      joined: true,
      unread: 4,
      mentions: 1,
    });
    expect(channel.members.map((m) => m.character)).toContain(CHARACTER);
    expect(channel.description).not.toBe("");

    const capped = snapshot.d.channels.find((c) => c.key === "Flooded")!;
    expect(capped).toMatchObject({ unread: 99, mentions: 0 });
  });

  it("ignore.add/remove drive IGN, fan out the list, persist the mirror, and keep messages", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "ignore.add", d: { character: "Nyx Firemane" } },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    // The server's IGN ack fans the whole list out.
    const updated = await client.nextEvent("ignore.updated");
    expect(eventPayload<{ characters: string[] }>(updated).characters).toEqual([
      "Nyx Firemane",
    ]);

    // An inbound PRI from the ignored character is still persisted and
    // fanned out — hiding is the render's job, history keeps everything.
    await inject(session, {
      cmd: "PRI",
      payload: { character: "Nyx Firemane", message: "you can't hear me" },
    });
    const msg = await client.nextEvent("message.new");
    expect(
      eventPayload<{ message: { bbcode: string } }>(msg).message.bbcode,
    ).toBe("you can't hear me");

    // A live, IGN-seeded session serves its own state to snapshots — no
    // sink-queue race.
    const live = await connectClient();
    await live.hello(token);
    const liveSnapshot = await live.subscribe(identityId);
    expect(liveSnapshot.d.self.ignores).toEqual(["Nyx Firemane"]);

    // The persisted mirror serves snapshots without a live session (the add
    // ack must have reached the DB, not just session state).
    await app.history.flush();
    app.sessions.stop(identityId, "test: mirror path");
    const late = await connectClient();
    await late.hello(token);
    const snapshot = await late.subscribe(identityId);
    expect(snapshot.d.self.ignores).toEqual(["Nyx Firemane"]);

    // Reconnect: the sim replays IGN init (full replacement) and the remove
    // ack must also persist through to the mirror. The init fans out its own
    // ignore.updated — consume it so the remove assertion sees the right one.
    const restarted = await startSession(identityId);
    const reseeded = await client.nextEvent("ignore.updated");
    expect(eventPayload<{ characters: string[] }>(reseeded).characters).toEqual(
      ["Nyx Firemane"],
    );
    expect(restarted.state.isIgnored("Nyx Firemane")).toBe(true);
    client.send({
      t: "cmd",
      id: 2,
      d: {
        identityId,
        action: "ignore.remove",
        d: { character: "Nyx Firemane" },
      },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    const removed = await client.nextEvent("ignore.updated");
    expect(eventPayload<{ characters: string[] }>(removed).characters).toEqual(
      [],
    );
    await app.history.flush();
    app.sessions.stop(identityId, "test: mirror path");
    const after = await connectClient();
    await after.hello(token);
    const cleared = await after.subscribe(identityId);
    expect(cleared.d.self.ignores).toEqual([]);
  });

  it("a rail reorder fans out as identities.reordered", async () => {
    const { identityId, token } = await createIdentity();
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    const response = await app.inject({
      method: "PUT",
      url: "/api/identities/order",
      headers: { authorization: `Bearer ${token}` },
      payload: { ids: [identityId] },
    });
    expect(response.statusCode).toBe(204);
    const evt = await client.nextEvent("identities.reordered");
    expect(eventPayload<{ order: string[] }>(evt).order).toEqual([identityId]);
  });

  it("status.set fans out as presence and lands in the next snapshot's self", async () => {
    const { identityId, token } = await createIdentity();
    await startSession(identityId);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);

    client.send({
      t: "cmd",
      id: 1,
      d: {
        identityId,
        action: "status.set",
        d: { status: "busy", statusmsg: "plotting" },
      },
    });
    expect((await client.nextOfType("ack")).d.ok).toBe(true);
    // Our own STA converges every subscribed tab via the presence fan-out.
    await client.next(
      (frame): frame is Extract<ServerFrame, { t: "event" }> =>
        frame.t === "event" &&
        frame.d.kind === "presence" &&
        frame.d.d.character === CHARACTER &&
        frame.d.d.status === "busy",
    );

    // A fresh sub reads the status straight from the session (self block).
    const late = await connectClient();
    await late.hello(token);
    const snapshot = await late.subscribe(identityId);
    expect(snapshot.d.self).toMatchObject({
      status: "busy",
      statusmsg: "plotting",
    });

    // Short of online there is nothing to set: the ack must say so.
    app.sessions.stop(identityId);
    client.send({
      t: "cmd",
      id: 2,
      d: {
        identityId,
        action: "status.set",
        d: { status: "away", statusmsg: "" },
      },
    });
    const refused = await client.nextOfType("ack");
    expect(refused.d.ok).toBe(false);
  });

  it("resolves DM presence case-insensitively and fans the LIS roster out as presence.bulk", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    // A DM opened with a lowercase name must still find its partner's
    // presence at snapshot time (rows keep the creator's casing).
    await app.history.ensurePmConversation(identityId, "nyx firemane");

    const client = await connectClient();
    await client.hello(token);
    const snapshot = await client.subscribe(identityId);
    const dm = snapshot.d.dms.find((d) => d.partner === "nyx firemane");
    expect(dm).toMatchObject({ online: true, status: "online" });

    // The already-online roster (LIS) streams after identify; subscribed
    // clients that raced it get the batches as presence.bulk events.
    await inject(session, {
      cmd: "LIS",
      payload: { characters: [["Late Arrival", "None", "busy", "brb"]] },
    });
    const bulk = await client.nextEvent("presence.bulk");
    expect(eventPayload<{ characters: unknown[] }>(bulk).characters).toEqual([
      ["Late Arrival", "None", "busy", "brb"],
    ]);
  });

  it("replays missed messages via catchup, then streams live without duplicates", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Frontpage");

    // First client sees one message and remembers its cursor.
    const first = await connectClient();
    await first.hello(token);
    await first.subscribe(identityId);
    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: "m1",
        channel: "Frontpage",
      },
    });
    const seen = await first.nextEvent("message.new");
    const seenEvent = eventPayload<{
      convId: string;
      message: { id: number };
    }>(seen);
    first.close();

    // Two messages land while nobody is attached.
    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: "m2",
        channel: "Frontpage",
      },
    });
    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: "m3",
        channel: "Frontpage",
      },
    });
    await app.history.flush();

    // Resume from the cursor: catchup must contain exactly m2 and m3.
    const second = await connectClient();
    await second.hello(token, {
      [identityId]: {
        convCursors: { [seenEvent.convId]: seenEvent.message.id },
      },
    });
    await second.subscribe(identityId);
    const catchup = await second.nextOfType("catchup");
    expect(catchup.d.convId).toBe(seenEvent.convId);
    expect(catchup.d.done).toBe(true);
    expect(catchup.d.messages.map((m) => m.bbcode)).toEqual(["m2", "m3"]);

    // Live flow continues after catchup — and m2/m3 never arrive twice.
    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: "m4",
        channel: "Frontpage",
      },
    });
    const live = await second.nextEvent("message.new");
    expect(
      eventPayload<{ message: { bbcode: string } }>(live).message.bbcode,
    ).toBe("m4");
    expect(second.bufferedFrames.filter((f) => f.t === "event")).toHaveLength(
      0,
    );
  });

  it("replays the unread tail of conversations the client has no cursor for", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Frontpage");

    // A client sees one Frontpage message and detaches with its cursor.
    const first = await connectClient();
    await first.hello(token);
    await first.subscribe(identityId);
    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: "before detach",
        channel: "Frontpage",
      },
    });
    const seen = eventPayload<{ convId: string; message: { id: number } }>(
      await first.nextEvent("message.new"),
    );
    first.close();

    // While detached: a brand-new PM thread arrives (no client cursor)…
    await inject(session, {
      cmd: "PRI",
      payload: { character: "Nyx Firemane", message: "new thread" },
    });
    await app.history.flush();
    // …a large conversation appears with more unread than one batch…
    const [seeded] = await db
      .insert(conversations)
      .values({
        identityId,
        kind: "channel",
        channelKey: "Seeded",
        title: "Seeded",
      })
      .returning();
    await db.insert(messages).values(
      Array.from({ length: 210 }, (_, i) => ({
        conversationId: seeded!.id,
        senderCharacter: "Nyx Firemane",
        kind: "msg" as const,
        bbcode: `bulk ${String(i + 1)}`,
      })),
    );
    // …and a fully-read conversation exists that must not be replayed.
    const [readConv] = await db
      .insert(conversations)
      .values({
        identityId,
        kind: "pm",
        partnerCharacter: "Tally Marsh",
        title: "Tally Marsh",
      })
      .returning();
    const [readMsg] = await db
      .insert(messages)
      .values({
        conversationId: readConv!.id,
        senderCharacter: "Tally Marsh",
        kind: "pm",
        bbcode: "already read",
      })
      .returning();
    await db
      .update(conversations)
      .set({ lastReadMessageId: readMsg!.id })
      .where(eq(conversations.id, readConv!.id));

    // Resume with only the Frontpage cursor.
    const second = await connectClient();
    await second.hello(token, {
      [identityId]: {
        convCursors: { [seen.convId]: seen.message.id },
      },
    });
    await second.subscribe(identityId);

    // Frontpage (cursor'd, nothing new): 1 empty done frame. PM tail: 1
    // frame. Seeded tail: a full batch (200) then the empty done frame.
    const frames = [];
    for (let i = 0; i < 4; i += 1) {
      frames.push(await second.nextOfType("catchup"));
    }
    const byConv = new Map<string, { bbcode: string }[]>();
    for (const frame of frames) {
      const list = byConv.get(frame.d.convId) ?? [];
      list.push(...frame.d.messages);
      byConv.set(frame.d.convId, list);
    }
    expect(byConv.get(seen.convId)).toEqual([]);
    expect(byConv.has(readConv!.id)).toBe(false);

    const [pmConv] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.identityId, identityId),
          eq(conversations.partnerCharacter, "Nyx Firemane"),
        ),
      );
    expect(byConv.get(pmConv!.id)?.map((m) => m.bbcode)).toEqual([
      "new thread",
    ]);

    // The tail is capped at one batch: bulk 11..210, never bulk 1.
    const tail = byConv.get(seeded!.id) ?? [];
    expect(tail).toHaveLength(200);
    expect(tail[0]?.bbcode).toBe("bulk 11");
    expect(tail.at(-1)?.bbcode).toBe("bulk 210");

    // Live still flows and no further catchup frames are pending.
    await inject(session, {
      cmd: "PRI",
      payload: { character: "Nyx Firemane", message: "live again" },
    });
    const live = await second.nextEvent("message.new");
    expect(
      eventPayload<{ message: { bbcode: string } }>(live).message.bbcode,
    ).toBe("live again");
    expect(second.bufferedFrames.filter((f) => f.t === "catchup")).toHaveLength(
      0,
    );
  });
});

describe("gateway commands", () => {
  it("connects a session, joins a channel, and sends a message end to end", async () => {
    const { identityId, token } = await createIdentity();

    const client = await connectClient();
    const observer = await connectClient();
    await client.hello(token);
    await observer.hello(token);
    const snapshot = await client.subscribe(identityId);
    expect(snapshot.d.self.sessionStatus).toBe("offline");
    await observer.subscribe(identityId);

    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "session.connect" },
    });
    const connectAck = await client.nextOfType("ack");
    expect(connectAck).toMatchObject({ id: 1, d: { ok: true } });
    // Status events fan out to every subscriber while the session comes up.
    for (;;) {
      const status = await client.nextEvent("session.status");
      if (eventPayload<{ status: string }>(status).status === "online") {
        break;
      }
    }

    client.send({
      t: "cmd",
      id: 2,
      d: { identityId, action: "channel.join", d: { key: "Development" } },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 2,
      d: { ok: true },
    });
    const conversation = await nextConversationUpdate<{
      id: string;
      channelKey: string | null;
      joined: boolean;
      lastReadMessageId: number | null;
    }>(client, (c) => c.joined);
    expect(conversation).toMatchObject({
      channelKey: "Development",
      joined: true,
    });

    client.send({
      t: "cmd",
      id: 3,
      d: {
        identityId,
        action: "msg.send",
        d: { convId: conversation.id, bbcode: "hello from the gateway" },
      },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 3,
      d: { ok: true },
    });
    // Both subscribers see our own send, flagged sentByUs.
    for (const c of [client, observer]) {
      const event = await c.nextEvent("message.new");
      expect(eventPayload<{ message: object }>(event).message).toMatchObject({
        senderCharacter: CHARACTER,
        bbcode: "hello from the gateway",
        sentByUs: true,
      });
    }
  });

  it("opens a PM conversation and advances the read cursor across clients", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);

    const client = await connectClient();
    const other = await connectClient();
    await client.hello(token);
    await other.hello(token);
    await client.subscribe(identityId);
    await other.subscribe(identityId);

    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "pm.open", d: { character: "Nyx Firemane" } },
    });
    const ack = await client.nextOfType("ack");
    expect(ack.d.ok).toBe(true);
    const conversation = ack.d.conversation!;
    expect(conversation).toMatchObject({
      kind: "pm",
      partnerCharacter: "Nyx Firemane",
    });

    await inject(session, {
      cmd: "PRI",
      payload: { character: "Nyx Firemane", message: "read me" },
    });
    const event = await client.nextEvent("message.new");
    const message = eventPayload<{ message: { id: number } }>(event).message;

    client.send({
      t: "ack",
      d: { identityId, convId: conversation.id, messageId: message.id },
    });
    // The other tab's unread counter converges via conversation.updated.
    const converged = await nextConversationUpdate(
      other,
      (c) => c.id === conversation.id && c.lastReadMessageId !== null,
    );
    expect(converged.lastReadMessageId).toBe(message.id);
  });

  it("cuts a live connection when its auth session is revoked", async () => {
    const { identityId, token } = await createIdentity();
    await startSession(identityId);

    const client = await connectClient();
    const ready = await client.hello(token);
    await client.subscribe(identityId);

    // Logout/expiry: the auth session rows disappear. The next frame's
    // re-verification must cut the socket — REST 401s immediately and the
    // gateway must not be the survivor.
    await db
      .delete(authSessions)
      .where(eq(authSessions.userId, ready.d.userId));
    client.send({ t: "sub", d: { identityId } });
    expect((await client.waitForClose()).code).toBe(GATEWAY_CLOSE.unauthorized);
  });

  it("does not resurrect a deleted identity from the ownership cache", async () => {
    const { identityId, token } = await createIdentity();

    const client = await connectClient();
    await client.hello(token); // ready caches ownership of the identity

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/identities/${identityId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleted.statusCode).toBe(204);

    // A stale cache hit here would log the character into F-Chat as an
    // orphaned session no client could ever see or stop.
    client.send({
      t: "cmd",
      id: 1,
      d: { identityId, action: "session.connect" },
    });
    expect(await client.nextOfType("ack")).toMatchObject({
      id: 1,
      d: { ok: false, error: "identity not found" },
    });
    expect(app.sessions.get(identityId)).toBeUndefined();
  });

  it("disconnects a connection that floods frames", async () => {
    const token = await registerUser();
    const client = await connectClient();
    await client.hello(token);
    for (let i = 0; i <= MAX_FRAMES_PER_MINUTE; i += 1) {
      client.send({ t: "ping" });
    }
    expect((await client.waitForClose()).code).toBe(GATEWAY_CLOSE.rateLimited);
  });

  it("denies access to another user's identity", async () => {
    const { identityId } = await createIdentity();
    await startSession(identityId);
    const strangerToken = await registerUser();

    const stranger = await connectClient();
    await stranger.hello(strangerToken);
    stranger.send({ t: "sub", d: { identityId } });
    const error = await stranger.nextOfType("error");
    expect(error.d.message).toBe("identity not found");

    stranger.send({
      t: "cmd",
      id: 9,
      d: { identityId, action: "channel.join", d: { key: "Development" } },
    });
    expect(await stranger.nextOfType("ack")).toMatchObject({
      id: 9,
      d: { ok: false, error: "identity not found" },
    });
  });
});
