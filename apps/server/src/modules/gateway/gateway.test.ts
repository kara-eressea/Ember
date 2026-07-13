// Gateway integration tests against real Postgres (testcontainers), fchat-sim
// and a listening HTTP server — app.inject cannot carry a WebSocket upgrade,
// so the suite talks to /gateway over real sockets like a browser would.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
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
import { authSessions, identities } from "../../db/schema.js";
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

describe("gateway handshake", () => {
  it("answers hello with ready and lists the user's identities", async () => {
    const { identityId, token } = await createIdentity();
    await startSession(identityId);

    const client = await connectClient();
    const ready = await client.hello(token);
    expect(ready.d.identities).toEqual([
      { id: identityId, name: CHARACTER, sessionStatus: "online" },
    ]);

    client.send({ t: "ping" });
    await client.nextOfType("pong");
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

  it("snapshots live channel state with unread counts", async () => {
    const { identityId, token } = await createIdentity();
    const session = await startSession(identityId);
    await joinAndSettle(session, "Development");
    await inject(session, {
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: "unread me",
        channel: "Development",
      },
    });
    await app.history.flush();

    const client = await connectClient();
    await client.hello(token);
    const snapshot = await client.subscribe(identityId);
    expect(snapshot.d.self).toEqual({
      character: CHARACTER,
      sessionStatus: "online",
    });
    expect(snapshot.d.channels).toHaveLength(1);
    const channel = snapshot.d.channels[0]!;
    expect(channel).toMatchObject({
      key: "Development",
      joined: true,
      unread: 1,
    });
    expect(channel.members.map((m) => m.character)).toContain(CHARACTER);
    expect(channel.description).not.toBe("");
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
