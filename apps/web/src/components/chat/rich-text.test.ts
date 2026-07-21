import { describe, expect, it } from "vitest";
import { parseEmote, spoilerSegments, textTokens } from "./rich-text.js";

describe("textTokens", () => {
  it("finds links, mentions, and channel refs in prose", () => {
    expect(textTokens("see https://f-list.net and ask @Nyx in #dev!")).toEqual([
      { kind: "plain", text: "see " },
      { kind: "link", href: "https://f-list.net" },
      { kind: "plain", text: " and ask " },
      { kind: "mention", name: "Nyx" },
      { kind: "plain", text: " in " },
      { kind: "channel", name: "dev" },
      { kind: "plain", text: "!" },
    ]);
  });

  it("requires word starts — emails and mid-word # stay plain", () => {
    expect(textTokens("mail me@example.test c#4")).toEqual([
      { kind: "plain", text: "mail me@example.test c#4" },
    ]);
  });

  it("passes plain text through as one token", () => {
    expect(textTokens("nothing here")).toEqual([
      { kind: "plain", text: "nothing here" },
    ]);
    expect(textTokens("")).toEqual([]);
  });
});

describe("parseEmote", () => {
  it("recognizes /me lines", () => {
    expect(parseEmote("/me pours tea")).toEqual({
      action: "pours tea",
      possessive: false,
    });
    expect(parseEmote("/me's teacup steams")).toEqual({
      action: "'s teacup steams",
      possessive: true,
    });
  });

  it("leaves non-emotes alone", () => {
    expect(parseEmote("hello /me there")).toBeUndefined();
    expect(parseEmote("/melon harvest")).toBeUndefined();
  });
});

describe("spoilerSegments", () => {
  it("splits ||…|| runs out of plain text", () => {
    expect(spoilerSegments("a ||secret|| b")).toEqual([
      { spoiler: false, text: "a " },
      { spoiler: true, text: "secret" },
      { spoiler: false, text: " b" },
    ]);
  });

  it("leaves unpaired or empty pipes literal", () => {
    expect(spoilerSegments("a || b")).toEqual([
      { spoiler: false, text: "a || b" },
    ]);
    expect(spoilerSegments("||||")).toEqual([{ spoiler: false, text: "||||" }]);
  });

  it("handles several spoilers in one run", () => {
    expect(spoilerSegments("||a|| x ||b||")).toEqual([
      { spoiler: true, text: "a" },
      { spoiler: false, text: " x " },
      { spoiler: true, text: "b" },
    ]);
  });
});
