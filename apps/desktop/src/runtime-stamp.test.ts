import { describe, expect, it } from "vitest";
import { parseStamp, runtimeBuildDecision } from "../scripts/runtime-stamp.mjs";

const stamp = {
  serverBuiltAtMs: 1_770_000_000_000,
  electronVersion: "43.3.0",
  pgliteSpec: "^0.5.4",
};

describe("parseStamp", () => {
  it("accepts a stamp it wrote itself", () => {
    expect(parseStamp(JSON.parse(JSON.stringify(stamp)))).toEqual(stamp);
  });

  it("rejects anything else — an unknown stamp means rebuild", () => {
    expect(parseStamp(undefined)).toBeUndefined();
    expect(parseStamp(null)).toBeUndefined();
    expect(parseStamp("43.3.0")).toBeUndefined();
    expect(parseStamp({ ...stamp, electronVersion: 43 })).toBeUndefined();
    // An older shape (no pglite spec) is not a stamp we can trust.
    expect(
      parseStamp({ serverBuiltAtMs: 1, electronVersion: "43.3.0" }),
    ).toBeUndefined();
  });
});

describe("runtimeBuildDecision", () => {
  it("builds when there is no tree, whatever the stamp says", () => {
    expect(
      runtimeBuildDecision({
        runtimePresent: false,
        previous: stamp,
        next: stamp,
      }),
    ).toEqual({ stale: true, reason: "no server-runtime tree yet" });
  });

  it("builds when a tree exists but its provenance does not", () => {
    const decision = runtimeBuildDecision({
      runtimePresent: true,
      previous: undefined,
      next: stamp,
    });
    expect(decision.stale).toBe(true);
    expect(decision.reason).toContain("stamp");
  });

  it("skips when every input matches", () => {
    expect(
      runtimeBuildDecision({
        runtimePresent: true,
        previous: { ...stamp },
        next: { ...stamp },
      }),
    ).toEqual({ stale: false, reason: "up to date" });
  });

  it("names what moved", () => {
    expect(
      runtimeBuildDecision({
        runtimePresent: true,
        previous: stamp,
        next: { ...stamp, serverBuiltAtMs: stamp.serverBuiltAtMs + 1 },
      }),
    ).toEqual({ stale: true, reason: "the server build changed" });

    // The ABI one is the dangerous one: a tree built for another Electron
    // fails at load time with a bare "invalid ELF header".
    expect(
      runtimeBuildDecision({
        runtimePresent: true,
        previous: stamp,
        next: { ...stamp, electronVersion: "44.0.0" },
      }),
    ).toEqual({ stale: true, reason: "the Electron version changed" });

    expect(
      runtimeBuildDecision({
        runtimePresent: true,
        previous: stamp,
        next: { ...stamp, pgliteSpec: "^0.6.0" },
      }),
    ).toEqual({ stale: true, reason: "the pglite version changed" });
  });

  it("reports every changed input at once", () => {
    const decision = runtimeBuildDecision({
      runtimePresent: true,
      previous: stamp,
      next: { serverBuiltAtMs: 1, electronVersion: "44.0.0", pgliteSpec: "*" },
    });
    expect(decision.stale).toBe(true);
    expect(decision.reason).toBe(
      "the server build changed, the Electron version changed, the pglite version changed",
    );
  });
});
