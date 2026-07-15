import { describe, expect, it } from "vitest";
import { parseSlash, SlashUsageError } from "./slash.js";

describe("parseSlash", () => {
  it("passes plain text and /me emotes through", () => {
    expect(parseSlash("hello")).toBeUndefined();
    expect(parseSlash("/me waves")).toBeUndefined();
    expect(parseSlash("/me's teacup rattles")).toBeUndefined();
  });

  it("parses /roll with a dice expression and defaults to 1d20", () => {
    expect(parseSlash("/roll 2d6+1d20+5")).toEqual({
      type: "roll",
      dice: "2d6+1d20+5",
    });
    expect(parseSlash("/roll")).toEqual({ type: "roll", dice: "1d20" });
    expect(parseSlash("/ROLL 1d6")).toEqual({ type: "roll", dice: "1d6" });
  });

  it("rejects malformed dice with a usage error", () => {
    expect(() => parseSlash("/roll banana")).toThrow(SlashUsageError);
    expect(() => parseSlash("/roll 0d6")).toThrow(SlashUsageError);
  });

  it("parses /bottle and flags unknown commands", () => {
    expect(parseSlash("/bottle")).toEqual({ type: "bottle" });
    expect(parseSlash("/kick Nyx")).toEqual({ type: "unknown", name: "kick" });
  });
});
