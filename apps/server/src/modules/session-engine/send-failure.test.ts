// The DM send-failure correlation window (#491): F-Chat never acknowledges a
// PRI and its ERRs name no frame, so the session attributes a refusal to the
// send it most plausibly answers. These tests pin the attribution rules AND
// the documented limits — the cases where correlation deliberately gives up
// matter as much as the ones where it fires.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FchatErrorCode,
  serializeServerCommand,
} from "@emberchat/fchat-protocol";
import { FchatSim } from "@emberchat/fchat-sim";
import { FRAME_WAIT_MS, INTEGRATION_MS } from "../../test-support/budgets.js";
import type { SendFailure } from "./event-bus.js";
import {
  FchatSession,
  PM_REFUSAL_WINDOW_MS,
  type FchatSessionOptions,
  type SessionTickets,
} from "./fchat-session.js";

const ACCOUNT = "amber@example.test";
const CHARACTER = "Amber Vale";
/** On the sim's roster without a socket behind it: online, never answers. */
const NPC = "Nyx Firemane";
const OTHER_NPC = "Tally Marsh";
/** Nobody by this name is online — a PRI to it draws ERR 6. */
const ABSENT = "Ghostly Absentee";

vi.setConfig({ testTimeout: INTEGRATION_MS });

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  vi.useRealTimers();
});

async function startSim(): Promise<FchatSim> {
  const sim = new FchatSim();
  await sim.start();
  cleanups.push(() => sim.stop());
  return sim;
}

function stubTickets(sim: FchatSim): SessionTickets {
  return {
    getTicket: () => Promise.resolve(sim.issueTicketFor(ACCOUNT)),
    invalidate: () => {},
  };
}

async function onlineSession(
  sim: FchatSim,
  overrides: Partial<FchatSessionOptions> = {},
): Promise<FchatSession> {
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
  const online = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out connecting (${session.status})`));
    }, FRAME_WAIT_MS);
    const off = session.events.on("status", (event) => {
      if (event.status === "online") {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
  session.start();
  await online;
  return session;
}

/** Collects every correlated refusal the session announces. */
function recordFailures(session: FchatSession): SendFailure[] {
  const seen: SendFailure[] = [];
  session.events.on("sendFailed", (failure) => {
    seen.push(failure);
  });
  return seen;
}

/** Resolves on the next `sendFailed`, or rejects on the deadline. */
function nextFailure(session: FchatSession): Promise<SendFailure> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("timed out waiting for a send failure"));
    }, FRAME_WAIT_MS);
    const off = session.events.on("sendFailed", (failure) => {
      clearTimeout(timer);
      off();
      resolve(failure);
    });
  });
}

/** Waits for a command to come back off the wire (an ERR, an IGN echo…). */
function waitForCommand(
  session: FchatSession,
  match: (cmd: string) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("timed out waiting for a command"));
    }, FRAME_WAIT_MS);
    const off = session.events.on("command", (command) => {
      if (match(command.cmd)) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

/** The sendId the session minted for the next PM it puts on the wire. */
function nextSendId(session: FchatSession): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("timed out waiting for a send"));
    }, FRAME_WAIT_MS);
    const off = session.events.on("sent", (sent) => {
      if (sent.kind === "pm") {
        clearTimeout(timer);
        off();
        resolve(sent.sendId);
      }
    });
  });
}

describe("private-message refusal correlation", () => {
  it("attributes ERR 6 to the send that drew it", async () => {
    const sim = await startSim();
    const session = await onlineSession(sim);

    const sendId = nextSendId(session);
    const failed = nextFailure(session);
    await session.sendPrivateMessage(ABSENT, "are you there?");

    const failure = await failed;
    expect(failure.sendId).toBe(await sendId);
    expect(failure.code).toBe(FchatErrorCode.CharacterNotFound);
    expect(failure.recipient).toBe(ABSENT);
    expect(failure.reason).toBe(`${ABSENT} is offline`);
  });

  it("prefers the offline recipient when two sends are in flight", async () => {
    const sim = await startSim();
    const session = await onlineSession(sim);

    // The NPC is on the roster, so the server takes that PRI silently; the
    // absent one draws the ERR. FIFO alone would blame the NPC send.
    const failures = recordFailures(session);
    await session.sendPrivateMessage(NPC, "delivered");
    const absentSendId = nextSendId(session);
    const failed = nextFailure(session);
    await session.sendPrivateMessage(ABSENT, "refused");

    await failed;
    expect(failures).toHaveLength(1);
    expect(failures[0]!.sendId).toBe(await absentSendId);
    expect(failures[0]!.recipient).toBe(ABSENT);
  });

  it("matches ERR 20 by the name the server rendered into it", async () => {
    const sim = await startSim();
    const session = await onlineSession(sim);

    // Both recipients are on the roster, so neither the offline preference
    // nor FIFO would pick the second — only the name in the ERR does.
    await session.sendPrivateMessage(NPC, "first");
    const secondSendId = nextSendId(session);
    await session.sendPrivateMessage(OTHER_NPC, "second");
    const failed = nextFailure(session);
    sim.sendRawTo(
      CHARACTER,
      serializeServerCommand({
        cmd: "ERR",
        payload: {
          number: FchatErrorCode.IgnoredByRecipient,
          message: `${OTHER_NPC} does not wish to receive messages from you.`,
        },
      }),
    );

    const failure = await failed;
    expect(failure.sendId).toBe(await secondSendId);
    expect(failure.recipient).toBe(OTHER_NPC);
    expect(failure.reason).toBe(
      `${OTHER_NPC} is not accepting messages from you`,
    );
  });

  it("gives the correlation up when an ERR-6-capable command follows", async () => {
    const sim = await startSim();
    const session = await onlineSession(sim);
    const failures = recordFailures(session);

    // A PRI the server takes silently, then an IGN — which can raise ERR 6
    // on its own account. The ERR that follows is no longer attributable.
    await session.sendPrivateMessage(NPC, "delivered");
    const ignEcho = waitForCommand(session, (cmd) => cmd === "IGN");
    await session.ignore("Some Bore");
    await ignEcho;
    const errSeen = waitForCommand(session, (cmd) => cmd === "ERR");
    sim.sendRawTo(
      CHARACTER,
      serializeServerCommand({
        cmd: "ERR",
        payload: {
          number: FchatErrorCode.CharacterNotFound,
          message: "The character requested was not found.",
        },
      }),
    );
    await errSeen;

    expect(failures).toEqual([]);
  });

  it("drops a refusal that arrives after the window closed", async () => {
    const sim = await startSim();
    const session = await onlineSession(sim);
    const failures = recordFailures(session);

    await session.sendPrivateMessage(NPC, "delivered");
    // Only the clock moves — the sim, the sockets and every timer keep
    // running, so this is the shape of a very late ERR, not a frozen world.
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(Date.now() + PM_REFUSAL_WINDOW_MS + 1_000);
    const errSeen = waitForCommand(session, (cmd) => cmd === "ERR");
    sim.sendRawTo(
      CHARACTER,
      serializeServerCommand({
        cmd: "ERR",
        payload: {
          number: FchatErrorCode.CharacterNotFound,
          message: "The character requested was not found.",
        },
      }),
    );
    await errSeen;

    expect(failures).toEqual([]);
  });

  it("clears in-flight sends when the connection goes away", async () => {
    const sim = await startSim();
    const session = await onlineSession(sim);
    const failures = recordFailures(session);

    await session.sendPrivateMessage(NPC, "delivered");
    // The socket drops and the session reconnects. A refusal the NEW
    // connection is told cannot belong to a frame the old one carried.
    const backOnline = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out reconnecting"));
      }, FRAME_WAIT_MS);
      const off = session.events.on("status", (event) => {
        if (event.status === "online") {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });
    sim.disconnect(CHARACTER);
    await backOnline;
    const errSeen = waitForCommand(session, (cmd) => cmd === "ERR");
    sim.sendRawTo(
      CHARACTER,
      serializeServerCommand({
        cmd: "ERR",
        payload: {
          number: FchatErrorCode.CharacterNotFound,
          message: "The character requested was not found.",
        },
      }),
    );
    await errSeen;

    expect(failures).toEqual([]);
  });
});
