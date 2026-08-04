// Failed DM sends end to end on the server (#491): a DM to someone who is not
// online draws an ERR the session correlates, the sink stamps the cause on the
// row it belongs to, the hub fans it out as `message.updated`, and `msg.retry`
// puts the same row back on the wire once the partner returns.
//
// Real Postgres (testcontainers) + fchat-sim + a listening HTTP server, like
// gateway.test.ts — nothing here is simulated on our side of the wire.

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
import { FchatSim, rawDataToString } from "@emberchat/fchat-sim";
import {
  serializeClientCommand,
  type ClientCommand,
} from "@emberchat/fchat-protocol";
import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type MessageDto,
  type ServerFrame,
} from "@emberchat/protocol";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createDb, type Db } from "../../db/index.js";
import { identities, messages } from "../../db/schema.js";
import {
  CONTAINER_BOOT_MS,
  FRAME_WAIT_MS,
  INTEGRATION_MS,
} from "../../test-support/budgets.js";
import { FlistApiClient } from "../flist-api/api-client.js";
import type { FchatSession } from "../session-engine/fchat-session.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const ACCOUNT = "amber@example.test";
const CHARACTER = "Amber Vale";
/** The DM partner: a real socket on its own account, so it can go offline
 * and come back without disturbing our ticket (world.ts isolation rules). */
const PARTNER_ACCOUNT = "birch@example.test";
const PARTNER = "Birch Rowan";

vi.setConfig({ testTimeout: INTEGRATION_MS });

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
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  gatewayUrl = `${address.replace(/^http/, "ws")}/gateway`;
}, CONTAINER_BOOT_MS);

afterAll(async () => {
  await app.close();
  await pool.end();
  await container.stop();
  await sim.stop();
});

// ── Harness (mirrors gateway.test.ts) ────────────────────────────────────────

class TestClient {
  readonly #socket: WebSocket;
  readonly #frames: ServerFrame[] = [];
  #wake: (() => void) | undefined;
  #cmdId = 0;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data: WebSocket.RawData) => {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- RawData decode
      this.#frames.push(JSON.parse(data.toString()) as ServerFrame);
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

  async next<T extends ServerFrame>(
    predicate: (frame: ServerFrame) => frame is T,
    timeoutMs = FRAME_WAIT_MS,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.#frames.findIndex(predicate);
      if (index !== -1) {
        return this.#frames.splice(index, 1)[0] as T;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("timed out waiting for a gateway frame");
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        setTimeout(resolve, remaining);
      });
    }
  }

  nextOfType<T extends ServerFrame["t"]>(t: T, timeoutMs = FRAME_WAIT_MS) {
    return this.next(
      (frame): frame is Extract<ServerFrame, { t: T }> => frame.t === t,
      timeoutMs,
    );
  }

  /** The next message.new / message.updated payload for a conversation. */
  async nextMessageEvent(
    kind: "message.new" | "message.updated",
    convId: string,
  ): Promise<MessageDto> {
    const frame = await this.next(
      (f): f is Extract<ServerFrame, { t: "event" }> =>
        f.t === "event" &&
        (f.d as { kind: string }).kind === kind &&
        (f.d as { d: { convId: string } }).d.convId === convId,
    );
    return (frame.d as { d: { message: MessageDto } }).d.message;
  }

  async hello(token: string) {
    this.send({ t: "hello", d: { token, protocolVersion: PROTOCOL_VERSION } });
    return this.nextOfType("ready");
  }

  async subscribe(identityId: string) {
    this.send({ t: "sub", d: { identityId } });
    return this.nextOfType("snapshot");
  }

  /** Sends a command and resolves with its ack. */
  async cmd(identityId: string, action: string, d: unknown) {
    this.#cmdId += 1;
    const id = this.#cmdId;
    this.send({ t: "cmd", id, d: { identityId, action, d } as never });
    return this.next(
      (frame): frame is Extract<ServerFrame, { t: "ack" }> =>
        frame.t === "ack" && frame.id === id,
    );
  }

  close(): void {
    this.#socket.close();
  }
}

const openClients: TestClient[] = [];
async function connectClient(): Promise<TestClient> {
  const client = await TestClient.connect();
  openClients.push(client);
  return client;
}

/** The partner's raw socket — connects, receives, and can walk away. */
class PartnerClient {
  readonly #socket: WebSocket;
  readonly #queue: string[] = [];
  readonly #waiters: Array<(raw: string) => void> = [];

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data) => {
      const raw = rawDataToString(data);
      const waiter = this.#waiters.shift();
      if (waiter) {
        waiter(raw);
      } else {
        this.#queue.push(raw);
      }
    });
  }

  static async connect(): Promise<PartnerClient> {
    const socket = new WebSocket(sim.wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const client = new PartnerClient(socket);
    client.#send({
      cmd: "IDN",
      payload: {
        method: "ticket",
        account: PARTNER_ACCOUNT,
        ticket: sim.issueTicketFor(PARTNER_ACCOUNT),
        character: PARTNER,
        cname: "EmberChat-test-partner",
        cversion: "0.0.0",
      },
    });
    await client.waitFor("IDN");
    return client;
  }

  #send(command: ClientCommand): void {
    this.#socket.send(serializeClientCommand(command));
  }

  async next(timeoutMs = FRAME_WAIT_MS): Promise<string> {
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      return queued;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for a sim frame"));
      }, timeoutMs);
      this.#waiters.push((raw) => {
        clearTimeout(timer);
        resolve(raw);
      });
    });
  }

  async waitFor(cmd: string): Promise<string> {
    for (;;) {
      const raw = await this.next();
      if (raw === cmd || raw.startsWith(`${cmd} `)) {
        return raw;
      }
    }
  }

  close(): void {
    this.#socket.terminate();
  }
}

const openPartners: PartnerClient[] = [];

afterEach(() => {
  for (const client of openClients.splice(0)) {
    client.close();
  }
  for (const partner of openPartners.splice(0)) {
    partner.close();
  }
});

let userCounter = 0;
async function registerUser(): Promise<string> {
  userCounter += 1;
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `failed-dm-${String(userCounter)}@example.test`,
      username: `faileddm${String(userCounter)}`,
      password: "hunter2hunter2",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ accessToken: string }>().accessToken;
}

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
  if (session.status !== "online") {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for online (${session.status})`));
      }, FRAME_WAIT_MS);
      session.events.on("status", (event) => {
        if (event.status === "online") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }
  return session;
}

/** Opens the DM with the partner and returns its conversation id. */
async function openPm(client: TestClient, identityId: string): Promise<string> {
  const ack = await client.cmd(identityId, "pm.open", { character: PARTNER });
  expect(ack.d.ok).toBe(true);
  return (ack.d as unknown as { conversation: { id: string } }).conversation.id;
}

describe("failed DM sends", () => {
  it("marks the message with its cause and clears it on a retry", async () => {
    const { identityId, token } = await createIdentity();
    await startSession(identityId);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);
    const convId = await openPm(client, identityId);

    // The partner is not connected: F-Chat answers the PRI with ERR 6.
    const sent = await client.cmd(identityId, "msg.send", {
      convId,
      bbcode: "are you still around?",
    });
    expect(sent.d.ok).toBe(true);

    const created = await client.nextMessageEvent("message.new", convId);
    expect(created.sentByUs).toBe(true);
    expect(created.failureReason).toBeUndefined();

    const failed = await client.nextMessageEvent("message.updated", convId);
    expect(failed.id).toBe(created.id);
    expect(failed.failureReason).toBe(`${PARTNER} is offline`);
    // Durable, not a live-only flag: a reload must not resurrect the message
    // as delivered.
    const [row] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, created.id));
    expect(row!.failureReason).toBe(`${PARTNER} is offline`);
    expect(row!.bbcode).toBe("are you still around?");

    // The partner comes back; the retry puts the SAME row on the wire.
    const partner = await PartnerClient.connect();
    openPartners.push(partner);
    const retried = await client.cmd(identityId, "msg.retry", {
      convId,
      messageId: created.id,
    });
    expect(retried.d.ok).toBe(true);

    const delivered = await partner.waitFor("PRI");
    expect(delivered).toContain("are you still around?");
    const cleared = await client.nextMessageEvent("message.updated", convId);
    expect(cleared.id).toBe(created.id);
    expect(cleared.failureReason).toBeUndefined();
    const [after] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, created.id));
    expect(after!.failureReason).toBeNull();

    // One line, not two: retrying is another attempt at the message the user
    // wrote, never a second message.
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convId));
    expect(rows).toHaveLength(1);
  });

  it("refuses to retry anything that is not a failed send", async () => {
    const { identityId, token } = await createIdentity();
    await startSession(identityId);
    const partner = await PartnerClient.connect();
    openPartners.push(partner);
    const client = await connectClient();
    await client.hello(token);
    await client.subscribe(identityId);
    const convId = await openPm(client, identityId);

    // A DM that was actually delivered — retrying it would re-send a message
    // its reader already has.
    expect(
      (
        await client.cmd(identityId, "msg.send", {
          convId,
          bbcode: "this one lands",
        })
      ).d.ok,
    ).toBe(true);
    await partner.waitFor("PRI");
    const delivered = await client.nextMessageEvent("message.new", convId);

    const refused = await client.cmd(identityId, "msg.retry", {
      convId,
      messageId: delivered.id,
    });
    expect(refused.d.ok).toBe(false);
    expect(refused.d.error).toBe("message is not a failed send");

    const missing = await client.cmd(identityId, "msg.retry", {
      convId,
      messageId: delivered.id + 10_000,
    });
    expect(missing.d.ok).toBe(false);
    expect(missing.d.error).toBe("message not found");
  });
});
