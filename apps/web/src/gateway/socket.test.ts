// Socket liveness (#407): a gateway socket can die without the browser ever
// firing close (sleep/resume, a NAT or proxy dropping an idle tunnel). It
// then sits readyState OPEN forever while the server's fan-out goes nowhere —
// the tab looks online and silently stops updating. The keepalive ping must
// therefore be answered: an unanswered one closes the socket so the normal
// reconnect (and its resume cursors) takes over.

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

const globals = globalThis as unknown as {
  WebSocket: unknown;
  location: unknown;
};
let realWebSocket: unknown;
let realLocation: unknown;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  realWebSocket = globals.WebSocket;
  realLocation = globals.location;
  globals.WebSocket = FakeSocket;
  globals.location = { protocol: "http:", host: "localhost:3000" };
});

afterEach(() => {
  vi.useRealTimers();
  globals.WebSocket = realWebSocket;
  globals.location = realLocation;
  vi.resetModules();
});

async function connectClient() {
  const { GatewayClient } = await import("./socket.js");
  const client = new GatewayClient();
  client.connect();
  const socket = FakeSocket.instances.at(-1)!;
  socket.onopen?.();
  return { client, socket };
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
