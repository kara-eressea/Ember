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

  it("sets own status (STA) and restores it after a reconnect", async () => {
    const sim = await startSim();
    const session = makeSession(sim, {
      backoffFloorMs: 200,
      backoffCapMs: 400,
    });
    session.start();
    await waitForStatus(session, "online");
    // "online" fires at IDN — wait for our own NLN so the roster holds us
    // before the synthetic STA tries to fold into it.
    await waitForCommand(
      session,
      (c) => c.cmd === "NLN" && c.payload.identity === CHARACTER,
    );

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
    expect(session.ownStatus).toEqual({ status: "away", statusmsg: "brb tea" });

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
      15_000,
    );
    await waitForStatus(session, "online", { next: true });
    const restored = await restoredEcho;
    expect(restored.cmd === "STA" && restored.payload.statusmsg).toBe(
      "brb tea",
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
});
