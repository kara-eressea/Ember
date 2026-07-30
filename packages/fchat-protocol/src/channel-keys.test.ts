import { describe, expect, it } from "vitest";
import { canonicalChannelKey } from "./channel-keys.js";

describe("canonicalChannelKey", () => {
  it("uppercases a lowercased private-room prefix", () => {
    expect(canonicalChannelKey("adh-e5253abc")).toBe("ADH-e5253abc");
  });

  it("leaves an already-canonical id untouched", () => {
    expect(canonicalChannelKey("ADH-e5253abc")).toBe("ADH-e5253abc");
  });

  it("preserves the hex body's case so the id round-trips to the server", () => {
    expect(canonicalChannelKey("adh-AbCdEf")).toBe("ADH-AbCdEf");
  });

  it("leaves official channel names alone", () => {
    expect(canonicalChannelKey("Frontpage")).toBe("Frontpage");
    expect(canonicalChannelKey("Adhesives")).toBe("Adhesives");
  });
});
