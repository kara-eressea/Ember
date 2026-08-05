import { describe, expect, it } from "vitest";
import {
  describeProbeRefusal,
  describeWindowFailure,
  errorPageQuery,
  isIgnorableLoadFailure,
  type RemoteFailure,
} from "./error-page.js";
import { probeServerUrl } from "./server-url.js";

const SERVER = "https://chat.example.com";

const load = (errorDescription: string, errorCode = -1) =>
  ({ kind: "load", errorCode, errorDescription }) as const;

describe("describeWindowFailure", () => {
  it("names the address in every case", () => {
    for (const failure of [
      load("ERR_CONNECTION_REFUSED", -102),
      load("ERR_NAME_NOT_RESOLVED", -105),
      load("ERR_CONNECTION_TIMED_OUT", -118),
      load("ERR_INTERNET_DISCONNECTED", -106),
      load("ERR_CONNECTION_RESET", -101),
      load("ERR_SOMETHING_NOBODY_HAS_SEEN", -999),
      { kind: "render-process-gone", reason: "crashed" } as const,
    ]) {
      const described = describeWindowFailure(SERVER, failure);
      expect(described.detail).toContain(SERVER);
      // A headline is a sentence a person reads, not a code.
      expect(described.headline.length).toBeGreaterThan(10);
      expect(described.headline).not.toContain("ERR_");
    }
  });

  it("keeps the code, including for failures it has no words for", () => {
    expect(
      describeWindowFailure(SERVER, load("ERR_CONNECTION_REFUSED", -102)).code,
    ).toBe("ERR_CONNECTION_REFUSED");
    // Chromium does not always fill the description in; the number is then the
    // only thing a bug report can carry.
    expect(describeWindowFailure(SERVER, load("", -337)).code).toBe(
      "net error -337",
    );
  });

  it.each([
    "ERR_CERT_AUTHORITY_INVALID",
    "ERR_CERT_DATE_INVALID",
    "ERR_CERT_COMMON_NAME_INVALID",
    "ERR_SSL_PROTOCOL_ERROR",
  ])("says %s is the server's to fix, and offers no way past it", (code) => {
    const described = describeWindowFailure(SERVER, load(code, -200));
    expect(described.headline.toLowerCase()).toContain("certificate");
    expect(described.detail).toContain("will not connect");
    // The page has a Retry and a Switch mode, and this must never grow a third
    // button. Nothing in the words may suggest one exists.
    expect(described.detail.toLowerCase()).not.toContain("anyway");
    expect(described.detail.toLowerCase()).not.toContain("continue");
    expect(described.detail.toLowerCase()).not.toContain("proceed");
  });

  it("distinguishes a renderer killed for memory from one that crashed", () => {
    const oom = describeWindowFailure(SERVER, {
      kind: "render-process-gone",
      reason: "oom",
    });
    expect(oom.headline).toContain("memory");
    expect(oom.code).toBe("oom");
    expect(
      describeWindowFailure(SERVER, {
        kind: "render-process-gone",
        reason: "crashed",
      }).headline,
    ).not.toContain("memory");
  });

  it("ignores a navigation that was merely replaced", () => {
    // ERR_ABORTED is what a redirect, a second loadURL or a closing window
    // produces. An error page for it would flash during ordinary navigation.
    expect(isIgnorableLoadFailure(load("ERR_ABORTED", -3))).toBe(true);
    expect(isIgnorableLoadFailure(load("ERR_CONNECTION_REFUSED", -102))).toBe(
      false,
    );
    expect(
      isIgnorableLoadFailure({
        kind: "render-process-gone",
        reason: "crashed",
      }),
    ).toBe(false);
  });
});

describe("describeProbeRefusal", () => {
  const refuse = async (rejection: Error) => {
    const result = await probeServerUrl(SERVER, {
      fetch: () => Promise.reject(rejection),
    });
    if (result.ok) {
      throw new Error("expected a refusal");
    }
    return describeProbeRefusal(result);
  };

  it("keeps the probe's sentence and adds the headline", async () => {
    const described = await refuse(new TypeError("fetch failed"));
    expect(described.headline).toBe("Can't reach your server");
    expect(described.detail).toContain(SERVER);
  });

  it("headlines a certificate refusal as one", async () => {
    // What Node's fetch reports…
    const undici = await refuse(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("self-signed certificate"), {
          code: "DEPTH_ZERO_SELF_SIGNED_CERT",
        }),
      }),
    );
    expect(undici.headline.toLowerCase()).toContain("certificate");
    expect(undici.detail).toContain("DEPTH_ZERO_SELF_SIGNED_CERT");

    // …and what Electron's does, which is what the shell actually uses.
    const chromium = await refuse(new Error("net::ERR_CERT_AUTHORITY_INVALID"));
    expect(chromium.headline.toLowerCase()).toContain("certificate");
    expect(chromium.detail).toContain("ERR_CERT_AUTHORITY_INVALID");
    expect(chromium.detail.toLowerCase()).not.toContain("anyway");
    // …and on its own row, which is the bit somebody copies into a bug report.
    expect(chromium.code).toBe("ERR_CERT_AUTHORITY_INVALID");
    expect(undici.code).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
  });

  it("separates a server that is down from one that is not ours", async () => {
    const notOurs = await probeServerUrl(SERVER, {
      fetch: () => Promise.resolve(new Response("<!doctype html>")),
    });
    if (notOurs.ok) {
      throw new Error("expected a refusal");
    }
    expect(describeProbeRefusal(notOurs).headline).not.toBe(
      "Can't reach your server",
    );
  });
});

describe("errorPageQuery", () => {
  const failure: RemoteFailure = {
    headline: "Your server didn't answer",
    detail: "Nothing is listening at https://chat.example.com.",
    code: "ERR_CONNECTION_REFUSED",
  };

  it("carries everything the page builds itself from", () => {
    expect(
      errorPageQuery({ productName: "EmberChat", serverUrl: SERVER, failure }),
    ).toEqual({
      product: "EmberChat",
      url: SERVER,
      headline: failure.headline,
      detail: failure.detail,
      code: "ERR_CONNECTION_REFUSED",
    });
  });

  it("leaves the code out when there is none, rather than showing an empty row", () => {
    const query = errorPageQuery({
      productName: "EmberChat",
      serverUrl: SERVER,
      failure: { headline: failure.headline, detail: failure.detail },
    });
    expect(query.code).toBeUndefined();
    expect(
      errorPageQuery({
        productName: "EmberChat",
        serverUrl: SERVER,
        failure: { ...failure, code: "" },
      }).code,
    ).toBeUndefined();
  });

  it("survives the round trip through a file:// URL", () => {
    // The page reads these back with `URLSearchParams` (error.js), and the
    // strings contain spaces, an apostrophe and a colon-slash-slash.
    const query = errorPageQuery({
      productName: "EmberChat",
      serverUrl: SERVER,
      failure,
    });
    const url = new URL("file:///opt/EmberChat/error/index.html");
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    const read = new URLSearchParams(url.search);
    expect(read.get("detail")).toBe(failure.detail);
    expect(read.get("url")).toBe(SERVER);
  });
});
