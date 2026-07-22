// The mini profile card renders a character's STA status message through the
// shared chat BBCode renderer (RichText) rather than as plain text, so tags
// like [url]/[eicon]/[color] never show up raw (#210). RichText is a React
// component and the web suite runs without a DOM, so these tests pin the two
// pure pipelines the card feeds it: parseBBCode (what RichText renders) turns
// tags into structured nodes instead of literal text, and bbcodeToText (the
// hover tooltip fallback) flattens them to readable prose.

import { describe, expect, it } from "vitest";
import { bbcodeToText, parseBBCode } from "@emberchat/markdown-bbcode";

describe("mini profile status rendering (#210)", () => {
  it("parses a [url] status into a link node, not literal tag text", () => {
    // The related report: [url] in a mini-profile status didn't resolve.
    // Shared root cause with #210 — plain-text rendering never parsed it.
    const nodes = parseBBCode("Read [url=https://f-list.net]my ad[/url]!");
    const url = nodes.find((node) => node.type === "url");
    expect(url).toMatchObject({ type: "url", href: "https://f-list.net" });
    // No node retains the raw "[url=" text.
    const flat = JSON.stringify(nodes);
    expect(flat).not.toContain("[url");
  });

  it("parses [eicon] and [color] tags into structured nodes", () => {
    const nodes = parseBBCode("[color=red]mood[/color] [eicon]sparkle[/eicon]");
    expect(nodes.some((node) => node.type === "color")).toBe(true);
    expect(
      nodes.some((node) => node.type === "name" && node.tag === "eicon"),
    ).toBe(true);
  });

  it("flattens a status to plain text for the hover tooltip", () => {
    expect(
      bbcodeToText("[b]Looking[/b] for [url=https://x.example]fun[/url]"),
    ).toBe("Looking for fun");
  });
});
