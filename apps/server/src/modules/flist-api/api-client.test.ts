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

describe("FlistApiClient character endpoints", () => {
  function characterStub() {
    const calls: { url: string; body: URLSearchParams }[] = [];
    const fetchImpl = vi.fn(
      (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url =
          input instanceof URL
            ? input.href
            : typeof input === "string"
              ? input
              : input.url;
        calls.push({ url, body: init?.body as URLSearchParams });
        if (url.endsWith("character-data.php")) {
          return Promise.resolve(
            Response.json({
              error: "",
              id: 42,
              name: "Amber Vale",
              settings: { guestbook: true },
              images: [{ image_id: "7", extension: "png", height: "10" }],
            }),
          );
        }
        if (url.endsWith("character-guestbook.php")) {
          return Promise.resolve(
            Response.json({ error: "", posts: [], page: 0, nextPage: false }),
          );
        }
        if (url.endsWith("character-memo-get2.php")) {
          return Promise.resolve(
            Response.json({ error: "", note: null, id: 42 }),
          );
        }
        return Promise.resolve(
          Response.json({ error: "", kinks: [], listitems: [] }),
        );
      },
    );
    return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
  }

  const auth = { account: "a@example.test", ticket: "fct_stub" };

  it("characterData posts name with auth and coerces the payload", async () => {
    const { fetchImpl, calls } = characterStub();
    const client = new FlistApiClient({
      baseUrl: "http://sim.test",
      fetchImpl,
      minRequestIntervalMs: 0,
    });
    const data = await client.characterData(auth, "Amber Vale");
    expect(calls[0]?.url).toBe("http://sim.test/json/api/character-data.php");
    expect(calls[0]?.body.get("account")).toBe("a@example.test");
    expect(calls[0]?.body.get("ticket")).toBe("fct_stub");
    expect(calls[0]?.body.get("name")).toBe("Amber Vale");
    expect(data.images?.[0]?.image_id).toBe(7);
  });

  it("guestbook posts numeric id and 0-based page as strings", async () => {
    const { fetchImpl, calls } = characterStub();
    const client = new FlistApiClient({
      baseUrl: "http://sim.test",
      fetchImpl,
      minRequestIntervalMs: 0,
    });
    await client.guestbook(auth, 42, 0);
    expect(calls[0]?.body.get("id")).toBe("42");
    expect(calls[0]?.body.get("page")).toBe("0");
  });

  it("memoGet posts target as the character NAME", async () => {
    const { fetchImpl, calls } = characterStub();
    const client = new FlistApiClient({
      baseUrl: "http://sim.test",
      fetchImpl,
      minRequestIntervalMs: 0,
    });
    const memo = await client.memoGet(auth, "Amber Vale");
    expect(calls[0]?.body.get("target")).toBe("Amber Vale");
    expect(calls[0]?.body.get("id")).toBeNull();
    expect(memo.note).toBeNull();
  });

  it("mappingList posts ticketless (no account/ticket fields)", async () => {
    const { fetchImpl, calls } = characterStub();
    const client = new FlistApiClient({
      baseUrl: "http://sim.test",
      fetchImpl,
      minRequestIntervalMs: 0,
    });
    await client.mappingList();
    expect(calls[0]?.url).toBe("http://sim.test/json/api/mapping-list.php");
    expect(calls[0]?.body.get("account")).toBeNull();
    expect(calls[0]?.body.get("ticket")).toBeNull();
  });
});
