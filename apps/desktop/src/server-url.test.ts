import { describe, expect, it } from "vitest";
import {
  healthzUrl,
  normalizeServerUrl,
  probeServerUrl,
  type ServerUrlResult,
} from "./server-url.js";

/** Asserts the result is a refusal and hands back the sentence it carries. */
function refusal(result: ServerUrlResult): string {
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.message;
}

describe("normalizeServerUrl", () => {
  it.each([
    // [what the user typed, what gets stored]
    ["https://chat.example.com", "https://chat.example.com"],
    ["  https://chat.example.com  ", "https://chat.example.com"],
    ["https://chat.example.com/", "https://chat.example.com"],
    ["https://chat.example.com///", "https://chat.example.com"],
    // No scheme is what people actually type, and https is the assumption to
    // make on their behalf.
    ["chat.example.com", "https://chat.example.com"],
    // …including with a port, which `new URL` alone would read as a scheme.
    ["chat.example.com:8443", "https://chat.example.com:8443"],
    ["HTTPS://Chat.Example.COM", "https://chat.example.com"],
    // A path survives: reverse-proxied under a prefix is a real deployment.
    ["https://example.com/chat/", "https://example.com/chat"],
    // Query and fragment do not: they are meaningless on a base origin, and
    // pasting from an address bar is how one arrives.
    ["https://chat.example.com/?tab=1#x", "https://chat.example.com"],
    // Loopback is the one place plain http is honest — the traffic never
    // leaves the machine.
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["http://[::1]:3000", "http://[::1]:3000"],
    // …and it is what a scheme-less loopback address means, too. Assuming
    // https there would refuse the developer's own server on principle.
    ["localhost:3000", "http://localhost:3000"],
    ["127.0.0.1:8788", "http://127.0.0.1:8788"],
    ["localhost", "http://localhost"],
    // An explicit https:// on loopback is still honoured — it was typed.
    ["https://localhost:3000", "https://localhost:3000"],
  ])("accepts %j as %j", (typed, stored) => {
    expect(normalizeServerUrl(typed)).toEqual({ ok: true, url: stored });
  });

  it.each([
    ["nothing at all", ""],
    ["only whitespace", "   "],
    // The refusal that matters most: a session token and every word the user
    // says would cross the network in the clear.
    ["a plain-http remote host", "http://chat.example.com"],
    ["a host that merely looks local", "http://localhost.example.com"],
    ["a scheme that is not the web", "ftp://chat.example.com"],
    ["a file path", "file:///Users/someone/chat"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["credentials in the address", "https://user:pw@chat.example.com"],
    ["something that is not an address", "not a url at all"],
    ["a scheme with no host", "https://"],
  ])("refuses %s", (_label, typed) => {
    // Every refusal is a sentence the user reads inside the chooser window,
    // not a code and not an empty string.
    expect(refusal(normalizeServerUrl(typed)).length).toBeGreaterThan(20);
  });

  it("points the probe at the liveness endpoint", () => {
    expect(healthzUrl("https://chat.example.com")).toBe(
      "https://chat.example.com/healthz",
    );
    expect(healthzUrl("https://example.com/chat")).toBe(
      "https://example.com/chat/healthz",
    );
  });
});

describe("probeServerUrl", () => {
  const URL_UNDER_TEST = "https://chat.example.com";

  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("accepts a server that answers the /healthz contract", async () => {
    const seen: string[] = [];
    const result = await probeServerUrl(URL_UNDER_TEST, {
      fetch: (input) => {
        // A plain string, not a Request: the probe builds one URL and asks for
        // it, so there is nothing else for a caller to have to unpack.
        seen.push(typeof input === "string" ? input : "not a string");
        return Promise.resolve(respond(200, { status: "ok" }));
      },
    });
    expect(result).toEqual({ ok: true, url: URL_UNDER_TEST });
    expect(seen).toEqual(["https://chat.example.com/healthz"]);
  });

  it("refuses an address nothing answers at", async () => {
    const message = refusal(
      await probeServerUrl(URL_UNDER_TEST, {
        fetch: () => Promise.reject(new TypeError("fetch failed")),
      }),
    );
    // The address the user typed, and the things they can do something about
    // — not the underlying error's text, which is not a sentence.
    expect(message).toContain(URL_UNDER_TEST);
  });

  it("refuses a server that answers with an error", async () => {
    const message = refusal(
      await probeServerUrl(URL_UNDER_TEST, {
        fetch: () => Promise.resolve(respond(502, {})),
      }),
    );
    expect(message).toContain("502");
  });

  it.each([
    ["a page instead of the contract", new Response("<!doctype html>")],
    ["a 200 with the wrong body", respond(200, { status: "sleepy" })],
    ["a 200 with no body at all", new Response(null, { status: 204 })],
  ])("refuses %s — a 200 is not proof", async (_label, response) => {
    // A parked domain, a router's login page and a static host that serves
    // index.html for every path all answer 200. Checking the body is what
    // makes "wrong address" distinguishable from "server is down".
    const message = refusal(
      await probeServerUrl(URL_UNDER_TEST, {
        fetch: () => Promise.resolve(response),
      }),
    );
    expect(message).toContain("does not look like");
  });

  it("gives up rather than hanging on a server that never answers", async () => {
    refusal(
      await probeServerUrl(URL_UNDER_TEST, {
        timeoutMs: 20,
        fetch: (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      }),
    );
  });
});
