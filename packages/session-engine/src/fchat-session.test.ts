// Integration tests: FchatSession against a real fchat-sim over loopback
// WebSockets, scripting the scenarios from milestone 1 step 6 — handshake,
// roster capture, rate-gated outbound, PIN discipline, watchdog, and the
// jittered reconnect backoff (including the 10-second policy floor).

import { createServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  FchatErrorCode,
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
import { FlistApiClient } from "./api-client.js";
import { FlistAuthError, TicketManager } from "./ticket-manager.js";
import {
  FRAME_WAIT_MS,
  INTEGRATION_MS,
  INTEGRATION_SLOW_MS,
} from "./test-support/budgets.js";
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
vi.setConfig({ testTimeout: INTEGRATION_MS });

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
    }, options.timeoutMs ?? FRAME_WAIT_MS);
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
  timeoutMs = FRAME_WAIT_MS,
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

  async next(timeoutMs = FRAME_WAIT_MS): Promise<string> {
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

  it("paces LRP on lfrp_flood, separately from MSG, and emits sent ads", async () => {
    // A fast msg_flood next to a slow lfrp_flood: if LRP rode the MSG pace
    // (or vice versa) the timings below would not hold.
    const sim = await startSim({
      serverVars: { msg_flood: 0.05, lfrp_flood: 0.5 },
    });
    const session = makeSession(sim);
    session.start();
    await waitForStatus(session, "online");
    const joined = waitForCommand(
      session,
      (c) => c.cmd === "CDS" && c.payload.channel === "Development",
    );
    session.joinChannel("Development");
    await joined;

    const sentAds: unknown[] = [];
    session.events.on("sent", (sent) => {
      if (sent.kind === "ad") {
        sentAds.push(sent);
      }
    });
    const observer = await SimClient.connect(
      sim,
      "birch@example.test",
      "Birch Rowan",
    );
    observer.send({ cmd: "JCH", payload: { channel: "Development" } });
    await observer.waitFor("CDS");

    const sent: { label: string; at: number }[] = [];
    const mark = (label: string) => () => {
      sent.push({ label, at: Date.now() });
    };
    await Promise.all([
      session.sendChannelAd("Development", "ad one").then(mark("ad-1")),
      session.sendChannelAd("Development", "ad two").then(mark("ad-2")),
      session.sendChannelMessage("Development", "chatter").then(mark("msg")),
    ]);
    // MSG is on its own timeline — it went out before the gated second ad.
    expect(sent.map((s) => s.label)).toEqual(["ad-1", "msg", "ad-2"]);
    expect(sent[2]!.at - sent[0]!.at).toBeGreaterThanOrEqual(500);
    expect(sentAds).toEqual([
      { kind: "ad", channel: "Development", message: "ad one" },
      { kind: "ad", channel: "Development", message: "ad two" },
    ]);
    expect(await observer.waitFor("LRP")).toContain('"ad one"');

    // The ad length limit is lfrp_max, not chat_max.
    await expect(
      session.sendChannelAd("Development", "a".repeat(60_000)),
    ).rejects.toThrow(MessageTooLongError);
  });

  it("refuses a second immediate ad inside the window, per channel (M6 audit)", async () => {
    // A gate this long outlives any ack window — the old behavior parked
    // the frame and ghost-posted it minutes after the client showed an
    // error; now the send fails fast with the remaining cooldown.
    const sim = await startSim({ serverVars: { lfrp_flood: 3600 } });
    const session = makeSession(sim);
    session.start();
    await waitForStatus(session, "online");
    for (const channel of ["Development", "Terrarium"]) {
      const joined = waitForCommand(
        session,
        (c) => c.cmd === "CDS" && c.payload.channel === channel,
      );
      session.joinChannel(channel);
      await joined;
    }

    await session.sendChannelAd("Development", "first ad");
    await expect(
      session.sendChannelAd("Development", "second ad"),
    ).rejects.toThrow(/next available in (59|60)m/);
    // The pace is per channel: another room's ad is unaffected.
    await session.sendChannelAd("Terrarium", "other room");
  });

  it("sends RLL and receives the computed roll back", async () => {
    const sim = await startSim();
    const session = makeSession(sim);
    session.start();
    await waitForStatus(session, "online");
    const joined = waitForCommand(
      session,
      (c) => c.cmd === "CDS" && c.payload.channel === "Development",
    );
    session.joinChannel("Development");
    await joined;

    const roll = waitForCommand(session, (c) => c.cmd === "RLL");
    await session.rollDice("Development", "2d6");
    expect(await roll).toMatchObject({
      cmd: "RLL",
      payload: { channel: "Development", type: "dice", character: CHARACTER },
    });
  });

  it("folds RMO into channel state", async () => {
    const sim = await startSim();
    const session = makeSession(sim);
    session.start();
    await waitForStatus(session, "online");
    const joined = waitForCommand(
      session,
      (c) => c.cmd === "CDS" && c.payload.channel === "Development",
    );
    session.joinChannel("Development");
    await joined;
    expect(session.state.channels.get("Development")?.mode).toBe("both");

    const mode = waitForCommand(session, (c) => c.cmd === "RMO");
    sim.sendRawTo(
      CHARACTER,
      serializeServerCommand({
        cmd: "RMO",
        payload: { channel: "Development", mode: "chat" },
      }),
    );
    await mode;
    expect(session.state.channels.get("Development")?.mode).toBe("chat");
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

  it("staggers rejoin JCHs at the msg_flood pace after a reconnect (#169)", async () => {
    const sim = await startSim({ serverVars: { msg_flood: 0.3 } });
    const session = makeSession(sim, {
      backoffFloorMs: 200,
      backoffCapMs: 400,
    });
    session.start();
    await waitForStatus(session, "online");

    for (const channel of ["Frontpage", "Development"]) {
      const joined = waitForCommand(
        session,
        (c) => c.cmd === "CDS" && c.payload.channel === channel,
      );
      session.joinChannel(channel);
      await joined;
    }

    // The rejoin burst must not be a single JCH volley: our own join echoes
    // arrive spaced by at least the runtime msg_flood window.
    const echoTimes: number[] = [];
    session.events.on("command", (command) => {
      if (
        command.cmd === "JCH" &&
        command.payload.character.identity === CHARACTER
      ) {
        echoTimes.push(Date.now());
      }
    });
    const rejoined = waitForCommand(
      session,
      (c) => c.cmd === "CDS" && c.payload.channel === "Development",
    );
    sim.disconnect(CHARACTER);
    await waitForStatus(session, "online", { next: true });
    await rejoined;
    await vi.waitFor(() => {
      expect(echoTimes.length).toBe(2);
    });
    // Generous tolerance for event-loop jitter; the point is "staggered,
    // not simultaneous".
    expect(echoTimes[1]! - echoTimes[0]!).toBeGreaterThanOrEqual(250);
    expect(session.state.channels.has("Frontpage")).toBe(true);
    expect(session.state.channels.has("Development")).toBe(true);
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
    // Always naming the ticket the rejection was about, never bare: a bare
    // drop evicts whatever ticket the cache holds, including a fresh one a
    // sibling session on this account minted while this one was reconnecting
    // — which mints another, kills that one account-wide, and cascades.
    expect(invalidate).toHaveBeenCalledWith("fct_bogus");
    expect(
      invalidate.mock.calls.every(([ticket]) => ticket !== undefined),
    ).toBe(true);
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

  it("gives up on a rejected join after two unconfirmed attempts, not on the first blip", async () => {
    const sim = await startSim();
    sim.rejectJoins("Frontpage"); // ERR 48: banned from the channel
    const session = makeSession(sim);
    const commands = recordCommands(session);
    const err48Count = () =>
      commands.filter((c) => c.cmd === "ERR" && c.payload.number === 48).length;
    session.start();
    await waitForStatus(session, "online");

    // Attempt 1: the failed join surfaces as ERR on the bus (the gateway
    // fans it out); a healthy join lands normally.
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
    expect(err48Count()).toBe(1);

    // First reconnect: one more polite attempt (a single missing echo could
    // just be a connection that died with the answer in flight).
    let rejoined = waitForCommand(
      session,
      (c) => c.cmd === "CDS" && c.payload.channel === "Development",
    );
    sim.disconnect(CHARACTER);
    await waitForStatus(session, "online", { next: true });
    await rejoined;
    await vi.waitFor(() => {
      expect(err48Count()).toBe(2);
    });

    // Second reconnect: two attempts never confirmed — given up, no more
    // JCH, no more ERR 48.
    rejoined = waitForCommand(
      session,
      (c) => c.cmd === "CDS" && c.payload.channel === "Development",
    );
    sim.disconnect(CHARACTER);
    await waitForStatus(session, "online", { next: true });
    await rejoined;

    expect(session.state.channels.has("Development")).toBe(true);
    expect(session.state.channels.has("Frontpage")).toBe(false);
    expect(err48Count()).toBe(2);
  });

  it("a quick leave→rejoin survives our own leave echo (kicks still stick)", async () => {
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

    // Leave and immediately rejoin: our own LCH echo must not clobber the
    // re-added desired entry (it is not a kick).
    const rejoined = waitForCommand(
      session,
      (c) => c.cmd === "CDS" && c.payload.channel === "Frontpage",
    );
    session.leaveChannel("Frontpage");
    session.joinChannel("Frontpage");
    await rejoined;

    // The channel survives a reconnect — it stayed in the desired set.
    const restored = waitForCommand(
      session,
      (c) => c.cmd === "CDS" && c.payload.channel === "Frontpage",
    );
    sim.disconnect(CHARACTER);
    await waitForStatus(session, "online", { next: true });
    await restored;
    expect(session.state.channels.has("Frontpage")).toBe(true);
  });

  it(
    "sets own status (STA) and restores it after a reconnect",
    { timeout: INTEGRATION_SLOW_MS },
    async () => {
      const sim = await startSim();
      const session = makeSession(sim, {
        backoffFloorMs: 200,
        backoffCapMs: 400,
      });
      // "online" fires at IDN — wait for our own NLN so the roster holds us
      // before the synthetic STA tries to fold into it. The listener attaches
      // BEFORE start(): on a fast loopback the whole greeting burst (IDN
      // through NLN) is emitted synchronously, so an attach-after-online
      // listener misses the NLN every time.
      const selfListed = waitForCommand(
        session,
        (c) => c.cmd === "NLN" && c.payload.identity === CHARACTER,
      );
      session.start();
      await waitForStatus(session, "online");
      await selfListed;

      // setStatus emits a synthetic self-STA so clients converge even if the
      // server never echoes; the sim's broadcast is the idempotent duplicate.
      const echo = waitForCommand(
        session,
        (c) => c.cmd === "STA" && c.payload.character === CHARACTER,
      );
      await session.setStatus("away", "brb tea");
      await echo;
      // The synthetic echo also folds into the roster — member lists show the
      // new status without waiting for the server's own broadcast.
      expect(session.state.characters.get(CHARACTER)).toMatchObject({
        status: "away",
        statusmsg: "brb tea",
      });
      expect(session.ownStatus).toEqual({
        status: "away",
        statusmsg: "brb tea",
      });

      // A fresh connection resets F-Chat to plain "online" — the session
      // re-sends its chosen status right after identifying, and the sim's
      // broadcast of that STA is the proof it went out. The listener attaches
      // BEFORE waiting for online: the restore fires immediately after IDN,
      // and on a starved runner its broadcast can land before an
      // attach-after-online listener exists (CI flake, M9 step 4). Gated on
      // the new connection's own NLN so a still-queued duplicate of the
      // pre-disconnect STA can never satisfy it.
      sim.disconnect(CHARACTER);
      let reconnected = false;
      const restoredEcho = waitForCommand(
        session,
        (c) => {
          if (c.cmd === "NLN" && c.payload.identity === CHARACTER) {
            reconnected = true;
            return false;
          }
          return (
            reconnected &&
            c.cmd === "STA" &&
            c.payload.character === CHARACTER &&
            c.payload.status === "away"
          );
        },
        FRAME_WAIT_MS,
      );
      await waitForStatus(session, "online", { next: true });
      const restored = await restoredEcho;
      expect(restored.cmd === "STA" && restored.payload.statusmsg).toBe(
        "brb tea",
      );
    },
  );

  it("acks a duplicate status change without putting an STA on the wire", async () => {
    // The sim's status gate is off here: a forwarded no-op would reach the
    // observer as a second STA instead of being refused, so the assertion
    // catches the redundant send itself rather than its rejection.
    const sim = await startSim({ staFloodSeconds: 0 });
    const session = makeSession(sim, { statusGateMs: 200 });
    session.start();
    await waitForStatus(session, "online");
    const observer = makeSession(sim, { character: "Cindral" });
    observer.start();
    await waitForStatus(observer, "online");

    const onWire: string[] = [];
    observer.events.on("command", (command) => {
      if (command.cmd === "STA" && command.payload.character === CHARACTER) {
        onWire.push(command.payload.statusmsg);
      }
    });
    const busy = waitForCommand(
      observer,
      (c) => c.cmd === "STA" && c.payload.character === CHARACTER,
    );
    await session.setStatus("busy", "plotting");
    await busy;

    // The second browser's redundant restore: acked, and re-asserted to the
    // subscribers (that stale view is exactly what needs healing) — but
    // nothing new goes to F-Chat.
    const echoed = waitForCommand(
      session,
      (c) => c.cmd === "STA" && c.payload.character === CHARACTER,
    );
    await session.setStatus("busy", "plotting");
    expect((await echoed).payload).toMatchObject({
      status: "busy",
      statusmsg: "plotting",
    });
    // Long enough that a deferred send would have fired by now.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(onWire).toEqual(["plotting"]);
    expect(session.ownStatus).toEqual({
      status: "busy",
      statusmsg: "plotting",
    });
  });

  it("paces status changes past the five-second gate, newest desire wins", async () => {
    // Both gates are scaled down together: the sim refuses a second STA
    // inside its window (ERR 14) exactly like F-Chat, and the session's
    // window sits above it.
    const sim = await startSim({ staFloodSeconds: 0.5 });
    const session = makeSession(sim, { statusGateMs: 700 });
    session.start();
    await waitForStatus(session, "online");
    const observer = makeSession(sim, { character: "Cindral" });
    observer.start();
    await waitForStatus(observer, "online");

    const onWire: string[] = [];
    observer.events.on("command", (command) => {
      if (command.cmd === "STA" && command.payload.character === CHARACTER) {
        onWire.push(command.payload.statusmsg);
      }
    });
    const errors: number[] = [];
    session.events.on("command", (command) => {
      if (command.cmd === "ERR") {
        errors.push(command.payload.number);
      }
    });

    const first = waitForCommand(
      observer,
      (c) => c.cmd === "STA" && c.payload.character === CHARACTER,
    );
    await session.setStatus("busy", "one");
    await first;

    // Three changes inside the window: only the last one is worth sending.
    const last = waitForCommand(
      observer,
      (c) =>
        c.cmd === "STA" &&
        c.payload.character === CHARACTER &&
        c.payload.statusmsg === "three",
    );
    await session.setStatus("looking", "two");
    await session.setStatus("away", "two and a half");
    await session.setStatus("dnd", "three");
    // Acked means accepted: the session already reads as the newest desire.
    expect(session.ownStatus).toEqual({ status: "dnd", statusmsg: "three" });
    expect(onWire).toEqual(["one"]); // still waiting out the gate

    await last;
    expect(onWire).toEqual(["one", "three"]);
    // Nothing was rejected — the point of the exercise.
    expect(errors).toEqual([]);
  });

  it("reproduces F-Chat's status gate: an unpaced second STA earns ERR 14", async () => {
    // Guards the sim's fidelity — without this gate the bug it models is
    // invisible in tests. statusGateMs: 0 opts the session out of pacing.
    const sim = await startSim();
    const session = makeSession(sim, { statusGateMs: 0 });
    session.start();
    await waitForStatus(session, "online");

    const refused = waitForCommand(session, (c) => c.cmd === "ERR");
    await session.setStatus("busy", "one");
    await session.setStatus("looking", "two");
    const err = await refused;
    expect(err.cmd === "ERR" && err.payload.number).toBe(
      FchatErrorCode.StatusFlood,
    );
  });

  it("auto-notifies the server about an ignored PRI, which still reaches the bus", async () => {
    const sim = await startSim();
    const session = makeSession(sim);
    session.start();
    await waitForStatus(session, "online");

    const acked = waitForCommand(
      session,
      (c) => c.cmd === "IGN" && c.payload.action === "add",
    );
    await session.ignore("Cindral");
    await acked;
    expect(session.state.isIgnored("cindral")).toBe(true); // case-insensitive

    // Cindral logs in on a raw socket (same sim account) and PMs us.
    const frames: string[] = [];
    const waiters: (() => void)[] = [];
    const socket = new WebSocket(sim.wsUrl);
    socket.on("message", (data) => {
      frames.push(rawDataToString(data));
      for (const wake of waiters.splice(0)) {
        wake();
      }
    });
    cleanups.push(() => {
      socket.close();
    });
    async function rawWaitFor(cmd: string): Promise<string> {
      for (;;) {
        const index = frames.findIndex(
          (raw) => raw === cmd || raw.startsWith(`${cmd} `),
        );
        if (index !== -1) {
          return frames.splice(index, 1)[0]!;
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`timed out waiting for ${cmd}`));
          }, 5000);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
    await new Promise<void>((resolve) => socket.once("open", resolve));
    socket.send(
      serializeClientCommand({
        cmd: "IDN",
        payload: {
          method: "ticket",
          account: ACCOUNT,
          ticket: sim.issueTicketFor(ACCOUNT),
          character: "Cindral",
          cname: "raw-test",
          cversion: "0",
        },
      }),
    );
    await rawWaitFor("IDN");

    const received = waitForCommand(session, (c) => c.cmd === "PRI");
    socket.send(
      serializeClientCommand({
        cmd: "PRI",
        payload: { recipient: CHARACTER, message: "can you hear me?" },
      }),
    );
    // The message still reaches the event bus — history keeps it, clients
    // hide it from render...
    const pri = await received;
    expect(pri.cmd === "PRI" && pri.payload.character).toBe("Cindral");
    // ...and the session auto-sent IGN notify, so the sim relayed ERR 20
    // (IgnoredByRecipient) to Cindral.
    const err = await rawWaitFor("ERR");
    expect(JSON.parse(err.slice(4))).toMatchObject({ number: 20 });

    // A second PM from the same sender still reaches the bus but triggers no
    // second notify: one courtesy frame per sender per connection, so an
    // ignored sender cannot pace our outbound traffic with their PMs.
    const again = waitForCommand(session, (c) => c.cmd === "PRI");
    socket.send(
      serializeClientCommand({
        cmd: "PRI",
        payload: { recipient: CHARACTER, message: "hello??" },
      }),
    );
    await again;
    // A repeat notify would ride the IGN gate class (msg_flood 0.5s + the
    // 100ms margin) — wait out the window before asserting silence.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(frames.filter((raw) => raw.startsWith("ERR"))).toEqual([]);
  });

  it("TPN dedupes per recipient: only status changes hit the wire", async () => {
    const sim = await startSim();
    const session = makeSession(sim);
    session.start();
    await waitForStatus(session, "online");
    const recipient = makeSession(sim, { character: "Cindral" });
    recipient.start();
    await waitForStatus(recipient, "online");

    const seen: string[] = [];
    recipient.events.on("command", (command) => {
      if (command.cmd === "TPN") {
        seen.push(command.payload.status);
      }
    });

    const paused = waitForCommand(
      recipient,
      (c) => c.cmd === "TPN" && c.payload.status === "paused",
    );
    session.sendTyping("Cindral", "typing");
    session.sendTyping("Cindral", "typing"); // repeats never reach the wire
    session.sendTyping("cindral", "typing"); // …case-insensitively
    session.sendTyping("Cindral", "paused");
    const frame = await paused;
    expect(frame.cmd === "TPN" && frame.payload.character).toBe(CHARACTER);
    // Exactly two frames made it out: the change to typing, then to paused.
    expect(seen).toEqual(["typing", "paused"]);
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

  // ── Self-removal: kick / ban / timeout (#561) ──────────────────────────────
  //
  // CKU/CBU/CTU naming our OWN character is the leave signal — no LCH
  // follows. The channel must leave the desired set or the next reconnect
  // walks straight back into the room, and on a ban that is ERR 48 on every
  // reconnect, forever, against the live server.

  it.each([
    {
      what: "kicked",
      frame: {
        cmd: "CKU",
        payload: {
          operator: "Birch Rowan",
          channel: "Frontpage",
          character: CHARACTER,
        },
      },
    },
    {
      what: "banned",
      frame: {
        cmd: "CBU",
        payload: {
          operator: "Birch Rowan",
          channel: "Frontpage",
          character: CHARACTER,
        },
      },
    },
    {
      what: "timed out",
      frame: {
        cmd: "CTU",
        payload: {
          operator: "Birch Rowan",
          channel: "Frontpage",
          character: CHARACTER,
          length: 30,
        },
      },
    },
  ] as const)(
    "does not rejoin a channel it was $what from, and puts no JCH on the wire",
    async ({ frame }) => {
      const clientFrames: string[] = [];
      const sim = await startSim({
        log: (line) => {
          if (line.startsWith("<< ")) {
            clientFrames.push(line.slice(3));
          }
        },
      });
      const session = makeSession(sim);
      session.start();
      await waitForStatus(session, "online");

      const joined = waitForCommand(
        session,
        (c) => c.cmd === "CDS" && c.payload.channel === "Frontpage",
      );
      session.joinChannel("Frontpage");
      await joined;

      // The removal frame arrives instead of an LCH.
      const removal = waitForCommand(session, (c) => c.cmd === frame.cmd);
      sim.sendRawTo(CHARACTER, serializeServerCommand(frame));
      await removal;

      // Reconnect. Rejoin JCHs go out on IDN, before the Development join
      // below, so once Development's CDS lands any Frontpage rejoin would
      // already be on the wire.
      clientFrames.length = 0;
      sim.disconnect(CHARACTER);
      await waitForStatus(session, "online", { next: true });
      const fence = waitForCommand(
        session,
        (c) => c.cmd === "CDS" && c.payload.channel === "Development",
      );
      session.joinChannel("Development");
      await fence;

      expect(session.state.channels.has("Frontpage")).toBe(false);
      const joins = clientFrames
        .filter((raw) => raw.startsWith("JCH "))
        .map((raw) => JSON.parse(raw.slice(4)) as { channel: string });
      expect(joins.map((j) => j.channel)).toEqual(["Development"]);
    },
  );
});

// ── Op / room command surface (#561) ─────────────────────────────────────────
//
// The web client's moderation and room tooling is covered end-to-end by
// apps/web/e2e/ops.spec.ts, but the engine's own contract — which frame goes
// out for which method, in the shape design/client-commands.md documents, on
// which rate class — had no test at this layer.

interface SentFrame {
  cmd: string;
  payload?: unknown;
  at: number;
}

/** Sim options that decode every client frame the sim saw, in wire order. */
function clientFrameSink(): { options: FchatSimOptions; frames: SentFrame[] } {
  const frames: SentFrame[] = [];
  return {
    frames,
    options: {
      log: (line) => {
        if (!line.startsWith("<< ")) {
          return;
        }
        const raw = line.slice(3);
        const space = raw.indexOf(" ");
        frames.push({
          cmd: space === -1 ? raw : raw.slice(0, space),
          ...(space === -1
            ? {}
            : { payload: JSON.parse(raw.slice(space + 1)) as unknown }),
          at: Date.now(),
        });
      },
    },
  };
}

describe("op and room commands against fchat-sim", () => {
  it("puts every op and room command on the wire in its documented shape", async () => {
    const sink = clientFrameSink();
    // msg_flood 0 keeps the shared ROOM timeline to the flood margin — the
    // pacing itself is asserted separately below.
    const sim = await startSim({
      ...sink.options,
      serverVars: { msg_flood: 0 },
    });
    const session = makeSession(sim);
    session.start();
    await waitForStatus(session, "online");

    const room = "Frontpage";
    const target = "Birch Rowan";
    // Every call resolves once its frame passed the gate onto the wire, so
    // awaiting them in order makes the expected sequence exact. Refusals
    // (we are nobody's op here) come back as ERR and are beside the point:
    // the contract under test is what the engine SENDS.
    sink.frames.length = 0;
    await session.requestChannelLists();
    await session.createRoom("Moss Parlour");
    await session.inviteToChannel(room, target);
    await session.setRoomStatus(room, "public");
    await session.kickFromChannel(room, target);
    await session.banFromChannel(room, target);
    await session.unbanFromChannel(room, target);
    await session.timeoutFromChannel(room, target, 30);
    await session.promoteOp(room, target);
    await session.demoteOp(room, target);
    await session.setRoomOwner(room, target);
    await session.setRoomDescription(room, "moss, mostly");
    await session.setRoomMode(room, "ads");
    await session.requestBanlist(room);
    await session.unignore(target);
    await session.reportToStaff(target, "\tBirch Rowan\nspam");

    // CCR makes the sim mint a room and walk us into it; drop the resulting
    // join traffic and the keepalives, which are not this test's subject.
    // The calls resolve at OUR socket write, so poll until the sim has read
    // the tail of the burst rather than racing loopback transit.
    const sent = () =>
      sink.frames
        .filter((frame) => frame.cmd !== "PIN" && frame.cmd !== "JCH")
        .map(({ cmd, payload }) => ({ cmd, payload }));
    await vi.waitFor(() => {
      expect(sent()).toHaveLength(17);
    }, FRAME_WAIT_MS);
    expect(sent()).toEqual([
      // requestChannelLists fires both directory queries together: CHA and
      // ORS are separate rate classes precisely so one refresh is one beat.
      { cmd: "CHA", payload: undefined },
      { cmd: "ORS", payload: undefined },
      { cmd: "CCR", payload: { channel: "Moss Parlour" } },
      { cmd: "CIU", payload: { channel: room, character: target } },
      { cmd: "RST", payload: { channel: room, status: "public" } },
      { cmd: "CKU", payload: { channel: room, character: target } },
      { cmd: "CBU", payload: { channel: room, character: target } },
      { cmd: "CUB", payload: { channel: room, character: target } },
      { cmd: "CTU", payload: { channel: room, character: target, length: 30 } },
      { cmd: "COA", payload: { channel: room, character: target } },
      { cmd: "COR", payload: { channel: room, character: target } },
      { cmd: "CSO", payload: { channel: room, character: target } },
      { cmd: "CDS", payload: { channel: room, description: "moss, mostly" } },
      { cmd: "RMO", payload: { channel: room, mode: "ads" } },
      { cmd: "CBL", payload: { channel: room } },
      { cmd: "IGN", payload: { action: "delete", character: target } },
      {
        cmd: "SFC",
        payload: {
          action: "report",
          report: "\tBirch Rowan\nspam",
          character: target,
        },
      },
    ]);
  });

  it("shares one ROOM timeline across room management, independent of other classes", async () => {
    const sink = clientFrameSink();
    const sim = await startSim({
      ...sink.options,
      serverVars: { msg_flood: 0.3 },
    });
    const session = makeSession(sim);
    session.start();
    await waitForStatus(session, "online");
    sink.frames.length = 0;

    // Two ROOM commands with an IGN between them: the IGN rides its own
    // class, so it reaches the wire while the second ROOM frame is still
    // waiting out the shared room window.
    await Promise.all([
      session.kickFromChannel("Frontpage", "Birch Rowan"),
      session.requestBanlist("Frontpage"),
      session.unignore("Birch Rowan"),
    ]);

    await vi.waitFor(() => {
      expect(sink.frames).toHaveLength(3);
    }, FRAME_WAIT_MS);
    const order = sink.frames.map((frame) => frame.cmd);
    expect(order).toEqual(["CKU", "IGN", "CBL"]);
    const cku = sink.frames.find((f) => f.cmd === "CKU")!;
    const cbl = sink.frames.find((f) => f.cmd === "CBL")!;
    // msg_flood 0.3s plus the gate's 100ms transit margin, minus slack for
    // event-loop jitter; the point is "paced, not back-to-back".
    expect(cbl.at - cku.at).toBeGreaterThanOrEqual(350);
  });

  it("refuses every op and room command while offline", async () => {
    const sim = await startSim();
    const idle = makeSession(sim);
    const calls: [string, () => Promise<unknown>][] = [
      ["requestChannelLists", () => idle.requestChannelLists()],
      ["createRoom", () => idle.createRoom("Moss Parlour")],
      ["inviteToChannel", () => idle.inviteToChannel("Frontpage", "Birch")],
      ["setRoomStatus", () => idle.setRoomStatus("Frontpage", "public")],
      ["kickFromChannel", () => idle.kickFromChannel("Frontpage", "Birch")],
      ["banFromChannel", () => idle.banFromChannel("Frontpage", "Birch")],
      ["unbanFromChannel", () => idle.unbanFromChannel("Frontpage", "Birch")],
      ["timeoutFromChannel", () => idle.timeoutFromChannel("F", "Birch", 5)],
      ["promoteOp", () => idle.promoteOp("Frontpage", "Birch")],
      ["demoteOp", () => idle.demoteOp("Frontpage", "Birch")],
      ["setRoomOwner", () => idle.setRoomOwner("Frontpage", "Birch")],
      ["setRoomDescription", () => idle.setRoomDescription("Frontpage", "x")],
      ["setRoomMode", () => idle.setRoomMode("Frontpage", "chat")],
      ["requestBanlist", () => idle.requestBanlist("Frontpage")],
      ["unignore", () => idle.unignore("Birch")],
      ["reportToStaff", () => idle.reportToStaff("Birch", "spam")],
      ["searchCharacters", () => idle.searchCharacters({ kinks: ["1"] })],
      ["rollDice", () => idle.rollDice("Frontpage", "1d10")],
    ];
    for (const [name, call] of calls) {
      await expect(call(), name).rejects.toThrow(SessionNotOnlineError);
    }
  });

  it("reports the per-channel ad cooldown from the live LRP timeline", async () => {
    const sim = await startSim({ serverVars: { lfrp_flood: 30 } });
    const session = makeSession(sim);
    session.start();
    await waitForStatus(session, "online");
    const joined = waitForCommand(
      session,
      (c) => c.cmd === "CDS" && c.payload.channel === "Frontpage",
    );
    session.joinChannel("Frontpage");
    await joined;

    // An untouched channel is clear to post: the class only exists once used.
    expect(session.adWaitMs("Frontpage")).toBe(0);
    await session.sendChannelAd("Frontpage", "looking for tea");
    // The wait is the live lfrp_flood VAR plus the gate's transit margin —
    // read from the server, never hardcoded (developer policy).
    expect(session.adWaitMs("Frontpage")).toBeGreaterThan(29_000);
    expect(session.adWaitMs("Frontpage")).toBeLessThanOrEqual(30_100);
    // Per channel: another room is untouched by this one's window.
    expect(session.adWaitMs("Development")).toBe(0);
  });
});

// ── Character search (FKS) correlation (#561) ────────────────────────────────

describe("searchCharacters against fchat-sim", () => {
  it("puts the filters on the wire and resolves the FKS reply", async () => {
    const sink = clientFrameSink();
    const sim = await startSim(sink.options);
    const session = makeSession(sim);
    session.start();
    await waitForStatus(session, "online");
    // Someone to find: the sim matches on gender and on a fave/yes kink.
    const other = makeSession(sim, { character: "Cindral" });
    other.start();
    await waitForStatus(other, "online");
    sink.frames.length = 0;

    const outcome = await session.searchCharacters({
      kinks: [],
      genders: ["Female"],
    });
    expect(
      sink.frames
        .filter((f) => f.cmd === "FKS")
        .map(({ cmd, payload }) => ({ cmd, payload })),
    ).toEqual([{ cmd: "FKS", payload: { kinks: [], genders: ["Female"] } }]);
    expect(outcome.ok).toBe(true);
  });

  it("adopts a search-outcome ERR as a plain refusal", async () => {
    // Nobody else is online, so the sim answers ERR 18 (no results) — one of
    // the four codes that count as this search's own outcome.
    const sim = await startSim();
    const session = makeSession(sim);
    session.start();
    await waitForStatus(session, "online");

    const outcome = await session.searchCharacters({ kinks: ["523"] });
    expect(outcome).toMatchObject({ ok: false, code: 18 });
  });

  it("refuses a second search while one is still in flight", async () => {
    const sim = await startSim();
    const session = makeSession(sim);
    session.start();
    await waitForStatus(session, "online");

    // FKS carries no request id, so the engine is single-flight per session:
    // the overlapping caller is told to wait rather than being handed the
    // other search's answer.
    const first = session.searchCharacters({ kinks: ["523"] });
    const second = await session.searchCharacters({ kinks: ["523"] });
    expect(second).toMatchObject({ ok: false, code: 50 });
    expect((await first).ok).toBe(false); // ERR 18: nobody else online
  });
});

/**
 * A minimal F-Chat endpoint that answers IDN and nothing else. The sim always
 * replies to FKS, so it cannot produce the one thing the stale-reply window
 * exists for: a search whose answer never comes, followed by that answer
 * arriving late, during the NEXT search.
 */
class SilentChatServer {
  #client: WebSocket | undefined;
  readonly url: string;

  private constructor(server: WebSocketServer, port: number) {
    this.url = `ws://127.0.0.1:${String(port)}/chat2`;
    server.on("connection", (socket: WebSocket) => {
      this.#client = socket;
      socket.on("message", (data) => {
        if (rawDataToString(data).startsWith("IDN ")) {
          socket.send(
            serializeServerCommand({
              cmd: "IDN",
              payload: { character: CHARACTER },
            }),
          );
        }
        // Everything else — FKS included — is swallowed.
      });
    });
  }

  static async start(): Promise<SilentChatServer> {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const instance = new SilentChatServer(server, port);
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    );
    return instance;
  }

  /** Pushes a raw server frame at the connected session. */
  send(command: Parameters<typeof serializeServerCommand>[0]): void {
    this.#client?.send(serializeServerCommand(command));
  }
}

describe("searchCharacters stale-reply window", () => {
  it(
    "swallows the late reply of a timed-out search instead of adopting it",
    // The wait IS the behaviour under test (the engine's 10s response
    // deadline), not a sleep before an assertion.
    { timeout: 30_000 },
    async () => {
      const chat = await SilentChatServer.start();
      const session = new FchatSession({
        character: CHARACTER,
        accountName: ACCOUNT,
        tickets: { getTicket: () => Promise.resolve("fct_x"), invalidate() {} },
        wsUrl: chat.url,
        clientName: "EmberChat-test",
        clientVersion: "0.0.0",
        backoffFloorMs: 50,
        backoffCapMs: 100,
        random: () => 0,
      });
      cleanups.push(() => {
        session.stop();
      });
      session.start();
      await waitForStatus(session, "online");

      // Nothing ever answers: the search resolves as a timeout refusal and
      // arms the window in which one late reply is discarded.
      const first = await session.searchCharacters({ kinks: ["523"] });
      expect(first).toMatchObject({ ok: false, code: 0 });

      const second = session.searchCharacters({ kinks: ["777"] });
      // The FIRST search's answer, arriving far too late. Adopting it would
      // hand the user results for a query they already abandoned.
      chat.send({
        cmd: "FKS",
        payload: { characters: ["Ghost Of Search Past"], kinks: ["523"] },
      });
      chat.send({
        cmd: "FKS",
        payload: { characters: ["Cindral"], kinks: ["777"] },
      });
      expect(await second).toEqual({
        ok: true,
        characters: ["Cindral"],
        kinks: ["777"],
      });
    },
  );
});
