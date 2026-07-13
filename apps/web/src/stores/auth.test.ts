// Refresh tokens are single-use server-side, so the store must never race
// two rotations (concurrent 401s) and must never destroy a persisted session
// over a mere network failure.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { useAuthStore as AuthStore } from "./auth.js";

let useAuthStore: typeof AuthStore;

const storage = new Map<string, string>();

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  ({ useAuthStore } = await import("./auth.js"));
});

const USER = { id: "u1", email: "a@example.test", username: "a" };

function seedSession(): void {
  storage.set(
    "eb.auth",
    JSON.stringify({ user: USER, refreshToken: "rt-old" }),
  );
  useAuthStore.setState({
    user: USER,
    accessToken: "at-old",
    refreshToken: "rt-old",
    remember: true,
    status: "authenticated",
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  storage.clear();
  seedSession();
});

describe("refreshSession", () => {
  it("single-flights concurrent refreshes — one rotation for N callers", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, { accessToken: "at-new", refreshToken: "rt-new" }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const store = useAuthStore.getState();
    const [a, b, c] = await Promise.all([
      store.refreshSession(),
      store.refreshSession(),
      store.refreshSession(),
    ]);
    expect([a, b, c]).toEqual([true, true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().refreshToken).toBe("rt-new");
    expect(storage.get("eb.auth")).toContain("rt-new");
  });

  it("clears the session only when the server rejected the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(jsonResponse(401, { error: "Invalid refresh token" })),
      ),
    );
    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(false);
    expect(useAuthStore.getState().status).toBe("anonymous");
    expect(useAuthStore.getState().refreshToken).toBeUndefined();
    expect(storage.has("eb.auth")).toBe(false);
  });

  it("keeps the persisted session across a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
    );
    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(false);
    // Nothing destroyed: a later retry can still rotate this token.
    expect(useAuthStore.getState().refreshToken).toBe("rt-old");
    expect(storage.has("eb.auth")).toBe(true);
  });

  it("adopts a token rotated by another tab instead of burning the stale one", async () => {
    // Another tab already rotated: localStorage holds a newer token than
    // this tab's in-memory copy.
    storage.set(
      "eb.auth",
      JSON.stringify({ user: USER, refreshToken: "rt-other-tab" }),
    );
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, { accessToken: "at-new", refreshToken: "rt-new" }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(useAuthStore.getState().refreshSession()).resolves.toBe(true);
    const [, options] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(options.body).toContain("rt-other-tab");
  });
});
