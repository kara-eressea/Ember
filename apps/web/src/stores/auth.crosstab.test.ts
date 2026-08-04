// Two tabs, one session. The store module is imported twice over a shared
// localStorage and a shared BroadcastChannel mock, which is as close to two
// tabs as a single process gets: each import has its own store state, its own
// single-flight guard and its own channel endpoint.
//
// What is being pinned is that they never rotate at the same time. Rotation is
// single-use and the server's 30 s grace (#456) does not make a collision
// harmless — the loser ends up holding a token the server has already replaced,
// and whichever tab writes localStorage last decides which of the two the other
// one inherits.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { useAuthStore as AuthStore } from "./auth.js";

const storage = new Map<string, string>();

/** One bus per channel name; a poster never receives its own message, which is
 * the behaviour the coordination leans on. */
const buses = new Map<string, Set<MockChannel>>();

class MockChannel {
  readonly #listeners = new Set<(event: MessageEvent) => void>();

  constructor(readonly name: string) {
    const peers = buses.get(name) ?? new Set<MockChannel>();
    peers.add(this);
    buses.set(name, peers);
  }

  addEventListener(_type: "message", listener: (event: MessageEvent) => void) {
    this.#listeners.add(listener);
  }

  postMessage(data: unknown): void {
    for (const peer of buses.get(this.name) ?? []) {
      if (peer !== this) {
        peer.deliver(data);
      }
    }
  }

  deliver(data: unknown): void {
    for (const listener of this.#listeners) {
      listener({ data } as MessageEvent);
    }
  }

  close(): void {
    buses.get(this.name)?.delete(this);
  }
}

const USER = { id: "u1", email: "a@example.test", username: "a" };

/** Let the announcement cross the bus: a tab claims its rotation from inside
 * the promise chain, the way it does in the app. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A freshly imported copy of the store module: a second tab. */
async function openTab(): Promise<typeof AuthStore> {
  vi.resetModules();
  const { useAuthStore } = await import("./auth.js");
  useAuthStore.setState({
    user: USER,
    accessToken: "at-old",
    refreshToken: "rt-old",
    remember: true,
    status: "authenticated",
  });
  return useAuthStore;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  });
  vi.stubGlobal("BroadcastChannel", MockChannel);
  buses.clear();
  storage.clear();
  storage.set(
    "eb.auth",
    JSON.stringify({ user: USER, refreshToken: "rt-old" }),
  );
});

describe("cross-tab refresh coordination", () => {
  it("makes the second tab wait for the first instead of racing it", async () => {
    // Tab A's rotation is held open, so B's refresh starts while A's is in
    // flight — the collision the grace window used to absorb.
    let releaseA: (response: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseA = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tabA = await openTab();
    const tabB = await openTab();

    const a = tabA.getState().refreshSession();
    await flush();
    const b = tabB.getState().refreshSession();
    await flush();
    // One request for the two tabs: B heard A's announcement and is waiting.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseA(
      jsonResponse(200, { accessToken: "at-new", refreshToken: "rt-new" }),
    );
    expect(await a).toBe("ok");
    expect(await b).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // B adopted the whole pair, access token included — the localStorage
    // mirror only ever carried the refresh half.
    expect(tabB.getState().refreshToken).toBe("rt-new");
    expect(tabB.getState().accessToken).toBe("at-new");
  });

  it("adopts a peer's completed rotation without being asked", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, { accessToken: "at-new", refreshToken: "rt-new" }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tabA = await openTab();
    const tabB = await openTab();

    expect(await tabA.getState().refreshSession()).toBe("ok");
    expect(tabB.getState().refreshToken).toBe("rt-new");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a rotation older than the one it already took", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const tab = await openTab();
    const bus = [...(buses.get("eb.auth") ?? [])];
    const peer = bus[0];

    peer?.deliver({
      type: "refresh-ok",
      at: 2000,
      userId: USER.id,
      accessToken: "at-2",
      refreshToken: "rt-2",
    });
    peer?.deliver({
      type: "refresh-ok",
      at: 1000,
      userId: USER.id,
      accessToken: "at-1",
      refreshToken: "rt-1",
    });

    // Two tabs that did collide converge on the newer token, not on whichever
    // message happened to arrive last.
    expect(tab.getState().refreshToken).toBe("rt-2");
  });

  it("ignores a rotation belonging to another account", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const tab = await openTab();
    const peer = [...(buses.get("eb.auth") ?? [])][0];

    peer?.deliver({
      type: "refresh-ok",
      at: Date.now(),
      userId: "somebody-else",
      accessToken: "at-theirs",
      refreshToken: "rt-theirs",
    });

    expect(tab.getState().refreshToken).toBe("rt-old");
  });

  it("rotates on its own where BroadcastChannel does not exist", async () => {
    // SSR, jsdom, an old engine: the coordination disappears and the store is
    // exactly what it was before it existed.
    vi.stubGlobal("BroadcastChannel", undefined);
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, { accessToken: "at-new", refreshToken: "rt-new" }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tabA = await openTab();
    const tabB = await openTab();

    expect(await tabA.getState().refreshSession()).toBe("ok");
    expect(await tabB.getState().refreshSession()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rotates anyway when a peer announces a refresh and never finishes", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, { accessToken: "at-new", refreshToken: "rt-new" }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const tab = await openTab();
      const peer = [...(buses.get("eb.auth") ?? [])][0];
      // A tab that announced a rotation and then died (closed, crashed, lost
      // its network): the wait must expire well inside the server's grace.
      peer?.deliver({
        type: "refresh-started",
        at: Date.now(),
        userId: USER.id,
      });

      const pending = tab.getState().refreshSession();
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toBe("ok");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
