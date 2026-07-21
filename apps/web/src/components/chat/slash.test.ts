import { describe, expect, it } from "vitest";
import { parseSlash, suggestCommands, SlashUsageError } from "./slash.js";

const OP = { inChannel: true, canModerate: true };
const MEMBER = { inChannel: true, canModerate: false };
const DM = { inChannel: false, canModerate: false };

const names = (text: string, ctx: typeof OP) =>
  suggestCommands(text, ctx).map((c) => c.name);

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

describe("suggestCommands (#235)", () => {
  it("offers nothing until the text starts with a slash", () => {
    expect(suggestCommands("", OP)).toEqual([]);
    expect(suggestCommands("hello", OP)).toEqual([]);
  });

  it("lists every available command for a bare slash", () => {
    expect(names("/", OP)).toContain("roll");
    expect(names("/", OP)).toContain("kick");
    expect(names("/", OP)).toContain("me");
  });

  it("filters by the command word as it is typed", () => {
    expect(names("/ba", OP)).toEqual(["banlist", "ban"]);
    expect(names("/rol", OP)).toEqual(["roll"]);
    expect(names("/zzz", OP)).toEqual([]);
  });

  it("is case-insensitive on the command word", () => {
    expect(names("/RO", OP)).toEqual(["roll"]);
  });

  it("hides moderator commands from a plain member", () => {
    const listed = names("/", MEMBER);
    expect(listed).toContain("roll");
    expect(listed).toContain("bottle");
    expect(listed).not.toContain("kick");
    expect(listed).not.toContain("timeout");
    expect(listed).not.toContain("setmode");
    expect(names("/ban", MEMBER)).toEqual([]);
  });

  it("offers moderator commands once the role is present", () => {
    expect(names("/ban", OP)).toEqual(["banlist", "ban"]);
    expect(names("/kick", OP)).toEqual(["kick"]);
    expect(names("/timeout", OP)).toEqual(["timeout"]);
  });

  it("drops channel-only commands in a direct message", () => {
    const listed = names("/", DM);
    expect(listed).toEqual(["me", "help"]);
    expect(names("/roll", DM)).toEqual([]);
  });

  it("keeps showing the matched signature while args are typed", () => {
    expect(names("/timeout Nyx, 30", OP)).toEqual(["timeout"]);
    expect(names("/ban Kestrel", OP)).toEqual(["ban"]);
  });

  it("stops hinting once /me has an argument (it is an emote)", () => {
    expect(names("/me", MEMBER)).toEqual(["me"]);
    expect(names("/me waves", MEMBER)).toEqual([]);
  });

  it("drops the popover when the typed command has no match", () => {
    expect(names("/frolic about", OP)).toEqual([]);
  });
});
