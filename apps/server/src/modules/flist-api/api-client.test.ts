import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlistApiClient } from "./api-client.js";

function stubFetch(onCall?: () => void) {
  const calls: { url: string; body: URLSearchParams; at: number }[] = [];
  const fetchImpl = vi.fn(
    (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      calls.push({
        url:
          input instanceof URL
            ? input.href
            : typeof input === "string"
              ? input
              : input.url,
        body: init?.body as URLSearchParams,
        at: Date.now(),
      });
      onCall?.();
      return Promise.resolve(Response.json({ error: "", ticket: "fct_stub" }));
    },
  );
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FlistApiClient", () => {
  it("posts form-encoded credentials with the requested no_* flags", async () => {
    const { fetchImpl, calls } = stubFetch();
    const client = new FlistApiClient({
      baseUrl: "http://sim.test",
      fetchImpl,
      minRequestIntervalMs: 0,
    });
    const response = await client.getApiTicket({
      account: "amber@example.test",
      password: "hunter2",
      noCharacters: true,
      noFriends: true,
      noBookmarks: true,
    });
    expect(response).toEqual({ error: "", ticket: "fct_stub" });
    expect(calls[0]?.url).toBe("http://sim.test/json/getApiTicket.php");
    expect(calls[0]?.body.get("account")).toBe("amber@example.test");
    expect(calls[0]?.body.get("password")).toBe("hunter2");
    expect(calls[0]?.body.get("no_characters")).toBe("true");
    expect(calls[0]?.body.get("no_friends")).toBe("true");
    expect(calls[0]?.body.get("no_bookmarks")).toBe("true");
  });

  it("spaces request starts by at least the configured interval (1 req/s budget)", async () => {
    const { fetchImpl, calls } = stubFetch();
    const client = new FlistApiClient({
      baseUrl: "http://sim.test",
      fetchImpl,
    });
    const params = { account: "a@example.test", password: "p" };
    const both = Promise.all([
      client.getApiTicket(params),
      client.getApiTicket(params),
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    await both;
    expect(calls).toHaveLength(2);
    const [first, second] = calls;
    expect(second!.at - first!.at).toBeGreaterThanOrEqual(1000);
  });

  it("throws on non-2xx responses", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response("nope", { status: 500 })),
    ) as unknown as typeof fetch;
    const client = new FlistApiClient({
      baseUrl: "http://sim.test",
      fetchImpl,
      minRequestIntervalMs: 0,
    });
    await expect(
      client.getApiTicket({ account: "a@example.test", password: "p" }),
    ).rejects.toThrow("HTTP 500");
  });
});
