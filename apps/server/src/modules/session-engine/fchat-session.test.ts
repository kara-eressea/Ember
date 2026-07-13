// Integration tests: FchatSession against a real fchat-sim over loopback
// WebSockets, scripting the scenarios from milestone 1 step 6 — handshake,
// roster capture, rate-gated outbound, PIN discipline, watchdog, and the
// jittered reconnect backoff (including the 10-second policy floor).

import { createServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  serializeClientCommand,
  serializeServerCommand,
  type ClientCommand,
  type ServerCommand,
} from "@emberchat/fchat-protocol";
import {
  FchatSim,
  rawDataToString,
  type FchatSimOptions,
} from "@emberchat/fchat-sim";
import { FlistApiClient } from "../flist-api/api-client.js";
import { FlistAuthError, TicketManager } from "../flist-api/ticket-manager.js";
import {
  backoffDelayMs,
  FchatSession,
  MessageTooLongError,
  PIN_MIN_INTERVAL_MS,
  RECONNECT_CAP_MS,
  RECONNECT_FLOOR_MS,
  SessionNotOnlineError,
  type FchatSessionOptions,
  type SessionTickets,
} from "./fchat-session.js";
import type { SessionStatus } from "./session-state.js";

const ACCOUNT = "amber@example.test";
const CHARACTER = "Amber Vale";
const PASSWORD = "hunter2";

// CI runners share the box with testcontainers-heavy suites; give the
// loopback round trips generous room.
vi.setConfig({ testTimeout: 15_000 });

// ── Harness ──────────────────────────────────────────────────────────────────

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  // Reverse order: sessions and clients before their sim.
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function startSim(options: FchatSimOptions = {}): Promise<FchatSim> {
  const sim = new FchatSim(options);
  await sim.start();
  cleanups.push(() => sim.stop());
  return sim;
}

/** Tickets straight from the sim's backdoor, bypassing HTTP. */
function stubTickets(sim: FchatSim, account = ACCOUNT): SessionTickets {
  return {
    getTicket: () => Promise.resolve(sim.issueTicketFor(account)),
    invalidate: () => {},
  };
}

function makeSession(
  sim: FchatSim,
  overrides: Partial<FchatSessionOptions> = {},
): FchatSession {
  const session = new FchatSession({
    character: CHARACTER,
    accountName: ACCOUNT,
    tickets: stubTickets(sim),
    wsUrl: sim.wsUrl,
    clientName: "EmberChat-test",
    clientVersion: "0.0.0",
    backoffFloorMs: 50,
    backoffCapMs: 100,
    random: () => 0,
    ...overrides,
  });
  cleanups.push(() => {
    session.stop();
  });
  return session;
}

function waitForStatus(
  session: FchatSession,
  status: SessionStatus,
  options: { next?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  if (!options.next && session.status === status) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(
        new Error(
          `timed out waiting for status ${status} (currently ${session.status})`,
        ),
      );
    }, options.timeoutMs ?? 5000);
    const off = session.events.on("status", (event) => {
      if (event.status === status) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

function waitForCommand(
  session: FchatSession,
  match: (command: ServerCommand) => boolean,
  timeoutMs = 5000,
): Promise<ServerCommand> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("timed out waiting for a matching command"));
    }, timeoutMs);
    const off = session.events.on("command", (command) => {
      if (match(command)) {
        clearTimeout(timer);
        off();
        resolve(command);
      }
    });
  });
}

function recordStatuses(
  session: FchatSession,
): { status: SessionStatus; at: number }[] {
  const seen: { status: SessionStatus; at: number }[] = [];
  session.events.on("status", (event) => {
    seen.push({ status: event.status, at: Date.now() });
  });
  return seen;
}

function recordCommands(session: FchatSession): ServerCommand[] {
  const seen: ServerCommand[] = [];
  session.events.on("command", (command) => {
    seen.push(command);
  });
  return seen;
}

/** A bare second participant (identified raw ws client) to observe delivery. */
class SimClient {
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

  static async connect(
    sim: FchatSim,
    account: string,
    character: string,
  ): Promise<SimClient> {
    const socket = new WebSocket(sim.wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const client = new SimClient(socket);
    cleanups.push(() => {
      socket.terminate();
    });
    client.send({
      cmd: "IDN",
      payload: {
        method: "ticket",
        account,
        ticket: sim.issueTicketFor(account),
        character,
        cname: "EmberChat-test-observer",
        cversion: "0.0.0",
      },
    });
    await client.waitFor("IDN");
    return client;
  }

  send(command: ClientCommand): void {
    this.#socket.send(serializeClientCommand(command));
  }

  async next(timeoutMs = 5000): Promise<string> {
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      return queued;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for a frame"));
      }, timeoutMs);
      this.#waiters.push((raw) => {
        clearTimeout(timer);
        resolve(raw);
      });
    });
  }

  /** Skips frames until one starts with the given command name. */
  async waitFor(cmd: string): Promise<string> {
    for (;;) {
      const raw = await this.next();
      if (raw === cmd || raw.startsWith(`${cmd} `)) {
        return raw;
      }
    }
  }
}

// ── Backoff policy (unit) ────────────────────────────────────────────────────

describe("reconnect backoff", () => {
  it("defaults honor the developer policy: floor ≥ 10s, cap 5 min", () => {
    expect(RECONNECT_FLOOR_MS).toBeGreaterThanOrEqual(10_000);
    expect(RECONNECT_CAP_MS).toBe(5 * 60 * 1000);
    expect(PIN_MIN_INTERVAL_MS).toBe(10_000);
  });

  it("never leaves [floor, cap] for any attempt or jitter", () => {
    const options = {
      floorMs: RECONNECT_FLOOR_MS,
      capMs: RECONNECT_CAP_MS,
      random: () => 0,
    };
    for (const random of [() => 0, () => 0.5, () => 1]) {
      for (let attempt = 0; attempt <= 20; attempt += 1) {
        const delay = backoffDelayMs(attempt, { ...options, random });
        expect(delay).toBeGreaterThanOrEqual(RECONNECT_FLOOR_MS);
        expect(delay).toBeLessThanOrEqual(RECONNECT_CAP_MS);
      }
    }
  });

  it("jitters every attempt (including the first) and grows exponentially", () => {
    const options = { floorMs: 10_000, capMs: 300_000, random: () => 1 };
    // Ceiling doubles per attempt starting at 2× the floor, so even the
    // first retry after a mass disconnect is spread out, not synchronized.
    expect(backoffDelayMs(0, options)).toBe(20_000);
    expect(backoffDelayMs(1, options)).toBe(40_000);
    expect(backoffDelayMs(2, options)).toBe(80_000);
    expect(backoffDelayMs(10, options)).toBe(300_000);
    // Zero jitter is always the floor.
    const min = { ...options, random: () => 0 };
    expect(backoffDelayMs(0, min)).toBe(10_000);
    expect(backoffDelayMs(10, min)).toBe(10_000);
  });
});

// ── Sim scenarios (integration) ──────────────────────────────────────────────

describe("FchatSession against fchat-sim", () => {
  it("identifies first, captures VARs, and builds the roster", async () => {
    const logs: string[] = [];
    const sim = await startSim({
      serverVars: { msg_flood: 1.25 },
      log: (line) => logs.push(line),
    });
    // Full stack: real TicketManager + FlistApiClient against the sim's
    // fake getApiTicket.php.
    const tickets = new TicketManager({
      accountName: ACCOUNT,
      getPassword: () => PASSWORD,
      apiClient: new FlistApiClient({ baseUrl: sim.httpUrl }),
    });
    const session = makeSession(sim, { tickets });
    const statuses = recordStatuses(session);
    // "online" fires on IDN; the roster (LIS batches, then our own NLN
    // broadcast) streams in right after — wait for the tail end of it.
    const rosterDone = waitForCommand(
      session,
      (c) => c.cmd === "NLN" && c.payload.identity === CHARACTER,
    );
    session.start();
    await waitForStatus(session, "online");
    await rosterDone;

    expect(statuses.map((s) => s.status)).toEqual([
      "acquiring_ticket",
      "connecting",
      "identifying",
      "online",
    ]);
    // IDN must be the first frame on the wire.
    const clientFrames = logs.filter((line) => line.startsWith("<< "));
    expect(clientFrames[0]).toMatch(/^<< IDN /);
    expect(session.state.ownCharacter).toBe(CHARACTER);
    // Runtime VAR capture, not the hardcoded default.
    expect(session.state.vars.msg_flood).toBe(1.25);
    expect(session.state.characters.has("Nyx Firemane")).toBe(true);
    expect(session.state.connectedCount).toBeGreaterThanOrEqual(1);
  });

  it("joins channels and folds ICH/COL/CDS into channel state", async () => {
    const sim = await startSim();
    const session = makeSession(sim);
    session.start();
    await waitForStatus(session, "online");

    const description = waitForCommand(
      session,
      (c) => c.cmd === "CDS" && c.payload.channel === "Frontpage",
    );
    session.joinChannel("Frontpage");
    await description;

    const channel = session.state.channels.get("Frontpage");
    expect(channel?.mode).toBe("chat");
    expect(channel?.description).toContain("default hangout");
    expect(channel?.oplist).toEqual(["", "Nyx Firemane"]);
    expect(channel?.members.has(CHARACTER)).toBe(true);
    expect(channel?.members.has("Nyx Firemane")).toBe(true);

    // Leaving forgets the channel.
    session.leaveChannel("Frontpage");
    await vi.waitFor(() => {
      expect(session.state.channels.has("Frontpage")).toBe(false);
    });
  });

  it("emits inbound MSG and PRI on the event bus", async () => {
    const sim = await startSim();
    const session = makeSession(sim);
    session.start();
    await waitForStatus(session, "online");

    const message = waitForCommand(session, (c) => c.cmd === "MSG");
    sim.sendRawTo(
      CHARACTER,
      serializeServerCommand({
        cmd: "MSG",
        payload: {
          character: "Nyx Firemane",
          message: "Welcome to the Frontpage!",
          channel: "Frontpage",
        },
      }),
    );
    expect(await message).toEqual({
      cmd: "MSG",
      payload: {
        character: "Nyx Firemane",
        message: "Welcome to the Frontpage!",
        channel: "Frontpage",
      },
    });

    const privateMessage = waitForCommand(session, (c) => c.cmd === "PRI");
    sim.sendRawTo(
      CHARACTER,
      serializeServerCommand({
        cmd: "PRI",
        payload: { character: "Nyx Firemane", message: "psst" },
      }),
    );
    expect(await privateMessage).toEqual({
      cmd: "PRI",
      payload: { character: "Nyx Firemane", message: "psst" },
    });
  });

  it("rate-gates outbound MSG to msg_flood and keeps PRI independent", async () => {
    const sim = await startSim({ serverVars: { msg_flood: 0.3 } });
    const session = makeSession(sim);
    const commands = recordCommands(session);
    session.start();
    await waitForStatus(session, "online");

    const joined = waitForCommand(
      session,
      (c) => c.cmd === "CDS" && c.payload.channel === "Frontpage",
    );
    session.joinChannel("Frontpage");
    await joined;

    const observer = await SimClient.connect(
      sim,
      "birch@example.test",
      "Birch Rowan",
    );
    observer.send({ cmd: "JCH", payload: { channel: "Frontpage" } });
    await observer.waitFor("CDS");

    // Two rapid channel messages plus a PM. Without the gate the second MSG
    // would violate msg_flood and the sim would reject it with ERR 5. The
    // gate resolves each promise at send time, so completion order and
    // spacing describe the wire schedule.
    const sent: { label: string; at: number }[] = [];
    const mark = (label: string) => () => {
      sent.push({ label, at: Date.now() });
    };
    await Promise.all([
      session.sendChannelMessage("Frontpage", "one").then(mark("msg-1")),
      session.sendChannelMessage("Frontpage", "two").then(mark("msg-2")),
      session.sendPrivateMessage("Birch Rowan", "psst").then(mark("pri")),
    ]);

    // PRI is on its own timeline: it went out before the gated second MSG.
    expect(sent.map((s) => s.label)).toEqual(["msg-1", "pri", "msg-2"]);
    const msg1 = sent[0]!;
    const msg2 = sent[2]!;
    // At least the mandated 300ms window (the gate pads it further).
    expect(msg2.at - msg1.at).toBeGreaterThanOrEqual(300);

    // Everything was delivered, in wire order (waitFor discards skipped
    // frames, so consume them in the order the observer received them).
    expect(await observer.waitFor("MSG")).toContain('"one"');
    await observer.waitFor("PRI");
    expect(await observer.waitFor("MSG")).toContain('"two"');

    // The sim never rejected anything.
    expect(commands.filter((c) => c.cmd === "ERR")).toEqual([]);
    expect(session.status).toBe("online");
  });

  it("answers PIN but never sends more than one per 10s", async () => {
    const logs: string[] = [];
    const sim = await startSim({ log: (line) => logs.push(line) });
    const session = makeSession(sim);
    session.start();
    await waitForStatus(session, "online");

    // Three server PINs in quick succession; a SYS fence guarantees the
    // session has processed all of them.
    const fence = waitForCommand(session, (c) => c.cmd === "SYS");
    sim.sendRawTo(CHARACTER, "PIN");
    sim.sendRawTo(CHARACTER, "PIN");
    sim.sendRawTo(CHARACTER, "PIN");
    sim.sendRawTo(
      CHARACTER,
      serializeServerCommand({ cmd: "SYS", payload: { message: "fence" } }),
    );
    await fence;

    // A join round-trip fences the client→server direction: the sim has
    // processed every frame the session sent before the JCH.
    const joined = waitForCommand(
      session,
      (c) => c.cmd === "CDS" && c.payload.channel === "Development",
    );
    session.joinChannel("Development");
    await joined;

    expect(logs.filter((line) => line === "<< PIN")).toHaveLength(1);
    expect(session.status).toBe("online");
  });

  it("swallows unknown and malformed inbound frames without crashing", async () => {
    const sim = await startSim();
    const session = makeSession(sim);
    const commands = recordCommands(session);
    session.start();
    await waitForStatus(session, "online");

    const fence = waitForCommand(session, (c) => c.cmd === "SYS");
    sim.sendRawTo(CHARACTER, 'ZZZ {"totally":"new"}');
    sim.sendRawTo(CHARACTER, "MSG {broken json");
    sim.sendRawTo(CHARACTER, "BLA");
    sim.sendRawTo(
      CHARACTER,
      serializeServerCommand({ cmd: "SYS", payload: { message: "fence" } }),
    );
    await fence;

    expect(session.status).toBe("online");
    expect(commands.map((c) => c.cmd)).not.toContain("ZZZ");
  });

  it("watchdog treats a silent connection as dead and reconnects", async () => {
    // The sim never pings (huge interval); the session hears nothing after
    // the handshake and must conclude the connection is dead on its own.
    const sim = await startSim({ pingIntervalMs: 600_000 });
    const session = makeSession(sim, { watchdogMs: 250 });
    const statuses = recordStatuses(session);
    session.start();
    await waitForStatus(session, "online");
    await waitForStatus(session, "online", { next: true });

    const sequence = statuses.map((s) => s.status);
    expect(sequence).toContain("backoff");
    expect(sequence.filter((s) => s === "online")).toHaveLength(2);
    expect(session.state.ownCharacter).toBe(CHARACTER);
  });

  it("reconnects after an abrupt drop, honoring the backoff floor, and rejoins channels", async () => {
    const sim = await startSim();
    const session = makeSession(sim, {
      backoffFloorMs: 200,
      backoffCapMs: 400,
    });
    const statuses = recordStatuses(session);
    session.start();
    await waitForStatus(session, "online");

    const joined = waitForCommand(
      session,
      (c) => c.cmd === "CDS" && c.payload.channel === "Frontpage",
    );
    session.joinChannel("Frontpage");
    await joined;

    const rejoined = waitForCommand(
      session,
      (c) => c.cmd === "CDS" && c.payload.channel === "Frontpage",
    );
    sim.disconnect(CHARACTER);
    await waitForStatus(session, "online", { next: true });
    await rejoined;

    expect(
      session.state.channels.get("Frontpage")?.members.has(CHARACTER),
    ).toBe(true);
    // The gap between entering backoff and retrying is at least the floor.
    const backoffAt = statuses.find((s) => s.status === "backoff");
    const retryAt = statuses.find(
      (s) => s.status === "acquiring_ticket" && s.at > (backoffAt?.at ?? 0),
    );
    expect(backoffAt).toBeDefined();
    expect(retryAt).toBeDefined();
    expect(retryAt!.at - backoffAt!.at).toBeGreaterThanOrEqual(195);
  });

  it("gives up on a connection whose handshake never completes", async () => {
    // A TCP server that accepts the socket and then says nothing: no ws
    // event ever fires without a handshake timeout, so the session would
    // hang in `connecting` forever.
    const sockets = new Set<import("node:net").Socket>();
    const blackhole = createServer((socket) => {
      sockets.add(socket);
    });
    await new Promise<void>((resolve) => {
      blackhole.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) {
            socket.destroy();
          }
          blackhole.close(() => {
            resolve();
          });
        }),
    );
    const port = (blackhole.address() as AddressInfo).port;

    const session = new FchatSession({
      character: CHARACTER,
      accountName: ACCOUNT,
      tickets: { getTicket: () => Promise.resolve("fct_x"), invalidate() {} },
      wsUrl: `ws://127.0.0.1:${String(port)}/chat2`,
      clientName: "EmberChat-test",
      clientVersion: "0.0.0",
      watchdogMs: 150,
      backoffFloorMs: 50,
      backoffCapMs: 100,
      random: () => 0,
    });
    cleanups.push(() => {
      session.stop();
    });
    session.start();
    await waitForStatus(session, "backoff");
  });

  it("stops after repeated identify rejections instead of looping", async () => {
    const sim = await startSim();
    const getTicket = vi.fn(() => Promise.resolve("fct_bogus"));
    const invalidate = vi.fn();
    const session = makeSession(sim, { tickets: { getTicket, invalidate } });
    session.start();
    await waitForStatus(session, "stopped");

    // One rejection per fetched ticket, then it gives up — fresh tickets
    // invalidate account-wide, so looping would degrade sibling sessions.
    expect(getTicket).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenCalledTimes(3);
  });

  it("does not rejoin a channel it was kicked from", async () => {
    const sim = await startSim();
    const session = makeSession(sim);
    session.start();
    await waitForStatus(session, "online");

    const joined = waitForCommand(
      session,
      (c) => c.cmd === "CDS" && c.payload.channel === "Frontpage",
    );
    session.joinChannel("Frontpage");
    await joined;

    // Server-initiated LCH for our own character = kick.
    sim.sendRawTo(
      CHARACTER,
      serializeServerCommand({
        cmd: "LCH",
        payload: { channel: "Frontpage", character: CHARACTER },
      }),
    );
    await vi.waitFor(() => {
      expect(session.state.channels.has("Frontpage")).toBe(false);
    });

    // Reconnect. Rejoin JCHs go out on IDN, before our Development join, so
    // once Development's CDS arrives any Frontpage rejoin would be visible.
    sim.disconnect(CHARACTER);
    await waitForStatus(session, "online", { next: true });
    const fence = waitForCommand(
      session,
      (c) => c.cmd === "CDS" && c.payload.channel === "Development",
    );
    session.joinChannel("Development");
    await fence;
    expect(session.state.channels.has("Frontpage")).toBe(false);
  });

  it("gives a rejected join one attempt per connect instead of retrying every reconnect", async () => {
    const sim = await startSim();
    sim.rejectJoins("Frontpage"); // ERR 48: banned from the channel
    const session = makeSession(sim);
    const commands = recordCommands(session);
    session.start();
    await waitForStatus(session, "online");

    // The failed join surfaces as ERR on the bus (the gateway fans it out);
    // a healthy join lands normally.
    const rejected = waitForCommand(
      session,
      (c) => c.cmd === "ERR" && c.payload.number === 48,
    );
    session.joinChannel("Frontpage");
    await rejected;
    const joined = waitForCommand(
      session,
      (c) => c.cmd === "CDS" && c.payload.channel === "Development",
    );
    session.joinChannel("Development");
    await joined;

    // Reconnect: the confirmed channel is rejoined, the never-confirmed one
    // is dropped — no second JCH, so no second ERR 48.
    const before = commands.length;
    const rejoined = waitForCommand(
      session,
      (c) => c.cmd === "CDS" && c.payload.channel === "Development",
    );
    sim.disconnect(CHARACTER);
    await waitForStatus(session, "online", { next: true });
    await rejoined;

    expect(session.state.channels.has("Development")).toBe(true);
    expect(session.state.channels.has("Frontpage")).toBe(false);
    const errsAfterReconnect = commands
      .slice(before)
      .filter((c) => c.cmd === "ERR" && c.payload.number === 48);
    expect(errsAfterReconnect).toHaveLength(0);
  });

  it("drops a rejected ticket and identifies with a fresh one", async () => {
    const sim = await startSim();
    let fetches = 0;
    const invalidate = vi.fn();
    const session = makeSession(sim, {
      tickets: {
        getTicket: () => {
          fetches += 1;
          return Promise.resolve(
            fetches === 1 ? "fct_bogus" : sim.issueTicketFor(ACCOUNT),
          );
        },
        invalidate,
      },
    });
    session.start();
    await waitForStatus(session, "online");

    expect(fetches).toBe(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("stops (does not retry) when the credentials themselves are rejected", async () => {
    const sim = await startSim();
    const getTicket = vi.fn(() =>
      Promise.reject(new FlistAuthError("Invalid username or password.")),
    );
    const session = makeSession(sim, {
      tickets: { getTicket, invalidate: () => {} },
    });
    const statuses = recordStatuses(session);
    session.start();
    await waitForStatus(session, "stopped");

    expect(getTicket).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toMatchObject({ status: "stopped" });
  });

  it("rejects sends while offline and messages over the byte limit", async () => {
    const sim = await startSim();
    const idle = makeSession(sim);
    await expect(idle.sendChannelMessage("Frontpage", "hi")).rejects.toThrow(
      SessionNotOnlineError,
    );

    const session = makeSession(sim);
    session.start();
    await waitForStatus(session, "online");
    // Default chat_max is 4096 bytes.
    await expect(
      session.sendChannelMessage("Frontpage", "a".repeat(5000)),
    ).rejects.toThrow(MessageTooLongError);
  });
});
