import { describe, expect, it } from "vitest";
import {
  decodeWireEntities,
  parseEmote,
  spoilerSegments,
  textTokens,
} from "./rich-text.js";

describe("decodeWireEntities (#335 follow-up)", () => {
  it("decodes the three entities the F-Chat server injects", () => {
    expect(decodeWireEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeWireEntities("a &lt;b&gt; c")).toBe("a <b> c");
  });

  it("restores a signed twimg URL's query so the CDN sees real params", () => {
    expect(
      decodeWireEntities(
        "https://pbs.twimg.com/media/HNz2CfYaMAAcV8N?format=jpg&amp;name=4096x4096",
      ),
    ).toBe(
      "https://pbs.twimg.com/media/HNz2CfYaMAAcV8N?format=jpg&name=4096x4096",
    );
  });

  it("decodes exactly once — &amp;amp; collapses to &amp;, not &", () => {
    // A user who literally typed "&amp;" is server-escaped to "&amp;amp;";
    // one decode must land on the literal they meant, never cascade to "&".
    expect(decodeWireEntities("&amp;amp;")).toBe("&amp;");
    // Likewise a literal "&lt;" the user typed round-trips to "&lt;".
    expect(decodeWireEntities("&amp;lt;")).toBe("&lt;");
  });

  it("leaves entities the server never emits untouched (ecosystem parity)", () => {
    // The reference client decodes only & < > — not quotes, apostrophes, or
    // numeric refs; decoding them would diverge from every other client.
    expect(decodeWireEntities("say &quot;hi&quot;")).toBe("say &quot;hi&quot;");
    expect(decodeWireEntities("it&#39;s &apos;fine&apos;")).toBe(
      "it&#39;s &apos;fine&apos;",
    );
    expect(decodeWireEntities("&#8212;")).toBe("&#8212;");
  });

  it("is a no-op on entity-free text", () => {
    expect(decodeWireEntities("plain https://static.f-list.net/a.png")).toBe(
      "plain https://static.f-list.net/a.png",
    );
  });
});

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
