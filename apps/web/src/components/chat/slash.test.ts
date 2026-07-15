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
    expect(parseSlash("/frolic about")).toEqual({
      type: "unknown",
      name: "frolic",
    });
  });
});

describe("parseSlash op commands (M6 step 6)", () => {
  it("parses the one-character moderation commands", () => {
    expect(parseSlash("/kick Nyx Firemane")).toEqual({
      type: "mod",
      action: "channel.kick",
      character: "Nyx Firemane",
    });
    expect(parseSlash("/ban Nyx Firemane")).toEqual({
      type: "mod",
      action: "channel.ban",
      character: "Nyx Firemane",
    });
    expect(parseSlash("/unban Nyx Firemane")).toEqual({
      type: "mod",
      action: "channel.unban",
      character: "Nyx Firemane",
    });
    expect(parseSlash("/op Tally Marsh")).toEqual({
      type: "mod",
      action: "channel.promote",
      character: "Tally Marsh",
    });
    expect(parseSlash("/deop Tally Marsh")).toEqual({
      type: "mod",
      action: "channel.demote",
      character: "Tally Marsh",
    });
    expect(parseSlash("/setowner Tally Marsh")).toEqual({
      type: "mod",
      action: "channel.owner",
      character: "Tally Marsh",
    });
    expect(() => parseSlash("/kick")).toThrow(SlashUsageError);
  });

  it("parses /timeout with a comma separator and bounds the minutes", () => {
    expect(parseSlash("/timeout Nyx Firemane, 30")).toEqual({
      type: "timeout",
      character: "Nyx Firemane",
      minutes: 30,
    });
    expect(() => parseSlash("/timeout Nyx Firemane")).toThrow(SlashUsageError);
    expect(() => parseSlash("/timeout Nyx, 91")).toThrow(SlashUsageError);
    expect(() => parseSlash("/timeout Nyx, five")).toThrow(SlashUsageError);
  });

  it("parses /setmode and /banlist", () => {
    expect(parseSlash("/setmode ads")).toEqual({
      type: "setmode",
      mode: "ads",
    });
    expect(() => parseSlash("/setmode loud")).toThrow(SlashUsageError);
    expect(parseSlash("/banlist")).toEqual({ type: "banlist" });
  });
});
