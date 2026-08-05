import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHOOSE_LOCAL_CHANNEL,
  CHOOSE_THIN_CLIENT_CHANNEL,
} from "./chooser-ipc.js";
import { planStartup } from "./startup.js";

describe("planStartup", () => {
  it("asks when there is nothing to honour", () => {
    // The one signal for a first run — and for a config file that got
    // mangled, which reads the same way on purpose (desktop-config.ts).
    expect(planStartup(undefined)).toEqual({ kind: "choose" });
  });

  it("boots the embedded bouncer in local mode", () => {
    expect(planStartup({ mode: "local" })).toEqual({ kind: "local" });
  });

  it("carries the server's URL through in thin-client mode", () => {
    expect(
      planStartup({
        mode: "thin-client",
        serverUrl: "https://chat.example.com",
      }),
    ).toEqual({ kind: "thin-client", serverUrl: "https://chat.example.com" });
  });
});

describe("the chooser preload", () => {
  const source = readFileSync(
    fileURLToPath(new URL("chooser-preload.cts", import.meta.url)),
    "utf8",
  );

  // A sandboxed CommonJS preload cannot import the ES module that declares
  // these, so the two names are spelled twice. This is the seam that keeps the
  // spellings equal.
  it("calls on the same two channels main answers on", () => {
    expect(source).toContain(`"${CHOOSE_LOCAL_CHANNEL}"`);
    expect(source).toContain(`"${CHOOSE_THIN_CLIENT_CHANNEL}"`);
  });

  it("exposes exactly the two calls the chooser needs", () => {
    // The bridge is the page's whole reach — validation, the /healthz probe
    // and every write live on the other side of these two names (spec §4).
    const bridge =
      /exposeInMainWorld\([^)]*\{([\s\S]*?)\}\);/.exec(source)?.[1] ?? "";
    const exposed = [...bridge.matchAll(/^\s+(\w+):/gm)].map(
      (match) => match[1],
    );
    expect(exposed).toEqual(["chooseLocal", "chooseThinClient"]);
  });
});
