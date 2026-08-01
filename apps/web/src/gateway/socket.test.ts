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

import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./dispatch.js", () => ({ dispatchFrame: vi.fn() }));
vi.mock("../stores/auth.js", () => ({
  useAuthStore: { getState: () => ({ accessToken: "token" }) },
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

it("stops probing after a deliberate teardown", async () => {
  const { client, socket } = await connectClient();
  client.stop();

  await vi.advanceTimersByTimeAsync(6_000);
  wake("focus");
  await vi.advanceTimersByTimeAsync(300);
  expect(pings(socket)).toHaveLength(0);
  expect(FakeSocket.instances).toHaveLength(1);
});
