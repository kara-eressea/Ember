// @vitest-environment jsdom
//
// Socket liveness (#407): a gateway socket can die without the browser ever
// firing close (sleep/resume, a NAT or proxy dropping an idle tunnel). It
// then sits readyState OPEN forever while the server's fan-out goes nowhere —
// the tab looks online and silently stops updating. The keepalive ping must
// therefore be answered: an unanswered one closes the socket so the normal
// reconnect (and its resume cursors) takes over.
//
// …but the keepalive is a timer, and a hidden or frozen tab's timers are
// throttled — around sleep/resume Firefox suspends them outright — so nothing
// runs to notice until the user interacts (#432). jsdom, not node, so the
// lifecycle events that must drive the probe instead actually exist.

import { GATEWAY_CLOSE } from "@emberchat/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./dispatch.js", () => ({ dispatchFrame: vi.fn() }));
const auth = vi.hoisted(() => ({
  refreshSession: vi.fn<() => Promise<"ok" | "rejected" | "unavailable">>(),
}));
vi.mock("../stores/auth.js", () => ({
  useAuthStore: {
    getState: () => ({ accessToken: "token", ...auth }),
  },
}));
vi.mock("../stores/messages.js", () => ({ resumeCursorsFor: () => ({}) }));
vi.mock("../stores/sessions.js", () => ({
  useSessionsStore: { getState: () => ({ sessions: {} }) },
}));
vi.mock("../stores/ui.js", () => ({
  useUiStore: { getState: () => ({ setGatewayStatus: vi.fn() }) },
}));

/** The bits of the DOM WebSocket the client touches. */
class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | undefined;
  onopen: (() => void) | undefined;
  onmessage: ((event: { data: string }) => void) | undefined;
  onclose: ((event: { code: number }) => void) | undefined;
  onerror: (() => void) | undefined;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.closed = { code, reason };
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const globals = globalThis as unknown as { WebSocket: unknown };
let realWebSocket: unknown;
/** Stopped after each test so their wake listeners leave the shared window. */
const clients: { stop(): void }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  auth.refreshSession.mockReset();
  auth.refreshSession.mockResolvedValue("ok");
  FakeSocket.instances = [];
  clients.length = 0;
  realWebSocket = globals.WebSocket;
  globals.WebSocket = FakeSocket;
});

afterEach(() => {
  for (const client of clients) {
    client.stop();
  }
  vi.useRealTimers();
  globals.WebSocket = realWebSocket;
  vi.resetModules();
});

async function connectClient() {
  const { GatewayClient } = await import("./socket.js");
  const client = new GatewayClient();
  clients.push(client);
  client.connect();
  const socket = FakeSocket.instances.at(-1)!;
  socket.onopen?.();
  return { client, socket };
}

/** One of the lifecycle events a resuming tab fires. */
function wake(type: "focus" | "online" | "pageshow" | "visibilitychange") {
  const target = type === "visibilitychange" ? document : window;
  target.dispatchEvent(new Event(type));
}

it("closes and reconnects a socket that stops answering the keepalive ping", async () => {
  const { socket } = await connectClient();

  // First ping goes out; the peer is gone, so no frame ever comes back.
  await vi.advanceTimersByTimeAsync(30_000);
  expect(socket.sent.some((frame) => frame.includes('"ping"'))).toBe(true);
  expect(socket.closed).toBeUndefined();

  await vi.advanceTimersByTimeAsync(10_000);
  expect(socket.closed).toBeDefined();

  // The reconnect backoff opens a fresh socket rather than leaving the tab
  // attached to a dead one.
  await vi.advanceTimersByTimeAsync(2_000);
  expect(FakeSocket.instances).toHaveLength(2);
});

it("keeps a socket whose pongs arrive", async () => {
  const { socket } = await connectClient();

  for (let round = 0; round < 4; round += 1) {
    await vi.advanceTimersByTimeAsync(30_000);
    socket.onmessage?.({ data: JSON.stringify({ t: "pong" }) });
  }
  await vi.advanceTimersByTimeAsync(10_000);
  expect(socket.closed).toBeUndefined();
  expect(FakeSocket.instances).toHaveLength(1);
});

// ── wake probing (#432) ──────────────────────────────────────────────────────

const pings = (socket: FakeSocket) =>
  socket.sent.filter((frame) => frame.includes('"ping"'));

it("probes a silent socket the moment the tab wakes", async () => {
  const { socket } = await connectClient();

  // The machine slept: the keepalive interval never ran, so nothing has
  // questioned this socket and nothing will until the user interacts.
  await vi.advanceTimersByTimeAsync(6_000);
  expect(pings(socket)).toHaveLength(0);

  wake("visibilitychange");
  await vi.advanceTimersByTimeAsync(300);
  expect(pings(socket)).toHaveLength(1);
  expect(socket.closed).toBeUndefined();

  // Unanswered: dead behind a readyState that still says OPEN. Closing it
  // hands over to the normal reconnect, whose hello carries resume cursors.
  await vi.advanceTimersByTimeAsync(3_000);
  expect(socket.closed).toBeDefined();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(FakeSocket.instances).toHaveLength(2);
});

it("keeps a probed socket that answers", async () => {
  const { socket } = await connectClient();

  await vi.advanceTimersByTimeAsync(6_000);
  wake("online");
  await vi.advanceTimersByTimeAsync(300);
  socket.onmessage?.({ data: JSON.stringify({ t: "pong" }) });

  await vi.advanceTimersByTimeAsync(10_000);
  expect(socket.closed).toBeUndefined();
  expect(FakeSocket.instances).toHaveLength(1);
});

it("does not probe a socket that just delivered a frame", async () => {
  const { socket } = await connectClient();

  await vi.advanceTimersByTimeAsync(2_000);
  wake("focus");
  await vi.advanceTimersByTimeAsync(300);
  expect(pings(socket)).toHaveLength(0);
});

it("collapses the burst of events a resume fires into one probe", async () => {
  const { socket } = await connectClient();

  await vi.advanceTimersByTimeAsync(6_000);
  for (const type of [
    "pageshow",
    "visibilitychange",
    "focus",
    "online",
  ] as const) {
    wake(type);
  }
  await vi.advanceTimersByTimeAsync(300);
  expect(pings(socket)).toHaveLength(1);
});

it("reconnects at once when the tab wakes inside the backoff", async () => {
  const { socket } = await connectClient();

  // Fail several reconnects so the backoff has climbed to its cap.
  socket.close(1006, "network gone");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await vi.advanceTimersByTimeAsync(60_000);
    FakeSocket.instances.at(-1)!.close(1006, "still gone");
  }
  const attempts = FakeSocket.instances.length;

  // The user is back and looking at an offline tab: waiting out a 30s
  // backoff is the wrong answer against our own bouncer.
  wake("focus");
  await vi.advanceTimersByTimeAsync(300);
  expect(FakeSocket.instances).toHaveLength(attempts + 1);
});

// ── giving up, and not giving up ─────────────────────────────────────────────
//
// A sleeping laptop wakes into a wake storm: the access token expired while
// the machine was away, so the reconnect's hello is refused (4401) — and the
// refresh that would fix it goes out while the Wi-Fi is still re-associating.
// That failure says nothing about the session, so it must not end the tab's
// reconnecting career; only the server rejecting the refresh token may.

/** Drive the socket through the close the server sends an expired hello. */
async function expire(socket: FakeSocket) {
  socket.close(GATEWAY_CLOSE.unauthorized, "invalid token");
  await vi.advanceTimersByTimeAsync(0); // let the refresh settle
}

it("keeps reconnecting when the refresh never reached a verdict", async () => {
  auth.refreshSession.mockResolvedValue("unavailable");
  const { socket } = await connectClient();

  await expire(socket);
  expect(auth.refreshSession).toHaveBeenCalledTimes(1);

  // The backoff carries on, and every attempt gets a fresh crack at the
  // refresh — the network comes back on its own schedule, not ours.
  await vi.advanceTimersByTimeAsync(2_000);
  expect(FakeSocket.instances).toHaveLength(2);
  await expire(FakeSocket.instances.at(-1)!);
  expect(auth.refreshSession).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(FakeSocket.instances).toHaveLength(3);
});

it("wakes straight into a reconnect after a refresh failure", async () => {
  auth.refreshSession.mockResolvedValue("unavailable");
  const { socket } = await connectClient();

  // Climb the backoff so a wake demonstrably beats it.
  await expire(socket);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await vi.advanceTimersByTimeAsync(60_000);
    FakeSocket.instances.at(-1)!.close(1006, "still gone");
  }
  const attempts = FakeSocket.instances.length;

  wake("focus");
  await vi.advanceTimersByTimeAsync(300);
  expect(FakeSocket.instances).toHaveLength(attempts + 1);
});

it("gives up only when the server rejected the refresh token", async () => {
  auth.refreshSession.mockResolvedValue("rejected");
  const { socket } = await connectClient();

  await expire(socket);
  // Signed out for real: the auth store has torn the session down and shown
  // the login form; hammering the gateway would achieve nothing.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(FakeSocket.instances).toHaveLength(1);
  wake("focus");
  await vi.advanceTimersByTimeAsync(300);
  expect(FakeSocket.instances).toHaveLength(1);
});

it("gives up when a refreshed token is refused all the same", async () => {
  const { socket } = await connectClient();

  await expire(socket); // refresh "ok" → straight back in
  expect(FakeSocket.instances).toHaveLength(2);
  await expire(FakeSocket.instances.at(-1)!); // …and refused again
  expect(auth.refreshSession).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(60_000);
  expect(FakeSocket.instances).toHaveLength(2);
});

it("reconnects on demand, whatever state it gave up in", async () => {
  auth.refreshSession.mockResolvedValue("rejected");
  const { client, socket } = await connectClient();
  await expire(socket);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(FakeSocket.instances).toHaveLength(1);

  // The user clicked "Reconnect now": one click beats a page reload, even
  // for a bug we haven't found yet.
  client.reconnectNow();
  expect(FakeSocket.instances).toHaveLength(2);
});

it("skips the backoff when the user asks to reconnect", async () => {
  const { client, socket } = await connectClient();
  socket.close(1006, "network gone");
  await vi.advanceTimersByTimeAsync(100);

  client.reconnectNow();
  expect(FakeSocket.instances).toHaveLength(2);
  // …and the pending timer is not left behind to open a third.
  await vi.advanceTimersByTimeAsync(2_000);
  expect(FakeSocket.instances).toHaveLength(2);
});

it("stops probing after a deliberate teardown", async () => {
  const { client, socket } = await connectClient();
  client.stop();

  await vi.advanceTimersByTimeAsync(6_000);
  wake("focus");
  await vi.advanceTimersByTimeAsync(300);
  expect(pings(socket)).toHaveLength(0);
  expect(FakeSocket.instances).toHaveLength(1);
});
