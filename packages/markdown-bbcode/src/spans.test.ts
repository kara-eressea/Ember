// markdownSpans (#226): the composer's inline-highlight ranges come from the
// same walk as the wire translation, so styling and translation agree by
// construction. These tests pin the emitted ranges and the agreement itself.

import { describe, expect, it } from "vitest";
import { markdownSpans, mdToBBCode } from "./markdown.js";
import type { MdSpan } from "./markdown.js";

function types(spans: MdSpan[]): string[] {
  return spans.map((s) => `${s.type}:${String(s.from)}-${String(s.to)}`);
}

describe("markdownSpans", () => {
  it("marks **bold** with delimiters", () => {
    expect(types(markdownSpans("a **b** c"))).toEqual([
      "delim:2-4",
      "bold:4-5",
      "delim:5-7",
    ]);
  });

  it("marks *italic*, ~~strike~~ and ||spoiler||", () => {
    expect(markdownSpans("*i*").map((s) => s.type)).toEqual([
      "delim",
      "italic",
      "delim",
    ]);
    expect(markdownSpans("~~s~~")[1]?.type).toBe("strike");
    expect(markdownSpans("||sp||")[1]?.type).toBe("spoiler");
  });

  it("nests italic inside bold (overlapping marks)", () => {
    const spans = markdownSpans("**a *b* c**");
    expect(spans.some((s) => s.type === "bold")).toBe(true);
    const italic = spans.find((s) => s.type === "italic");
    expect(italic).toEqual({ from: 5, to: 6, type: "italic" });
  });

  it("leaves unterminated emphasis unstyled (matches translator)", () => {
    expect(markdownSpans("**dangling")).toEqual([]);
    expect(markdownSpans("* not emphasis")).toEqual([]);
    expect(mdToBBCode("**dangling")).toBe("**dangling");
  });

  it("respects backslash escapes", () => {
    expect(markdownSpans(String.raw`\*\*not bold\*\*`)).toEqual([]);
  });

  it("nothing matches inside a code span; the span itself is styled", () => {
    const spans = markdownSpans("`**x**`");
    expect(spans.map((s) => s.type)).toEqual(["delim", "code", "delim"]);
  });

  it("emphasis closer inside code never terminates outer emphasis", () => {
    // "**a `b**` c**" — the first ** closes at the *last* **, not inside code.
    const spans = markdownSpans("**a `b**` c**");
    const bold = spans.find((s) => s.type === "bold");
    expect(bold).toEqual({ from: 2, to: 11, type: "bold" });
  });

  it("flags [eicon]name[/eicon] as one atom", () => {
    expect(types(markdownSpans("hi [eicon]lickinglips[/eicon]"))).toEqual([
      "eicon:3-29",
    ]);
  });

  it("styles emphasis nested in a markdown link's label", () => {
    const spans = markdownSpans("[see **this**](https://example.com/)");
    const bold = spans.find((s) => s.type === "bold");
    expect(bold).toEqual({ from: 7, to: 11, type: "bold" });
  });

  it("follows the translator across newlines (one scanner, one answer)", () => {
    // The dialect's findDelimiter does not stop at a newline — the wire form
    // is [b]a\nb[/b], so the highlight must show the same thing.
    expect(mdToBBCode("**a\nb**")).toBe("[b]a\nb[/b]");
    expect(markdownSpans("**a\nb**")[1]).toEqual({
      from: 2,
      to: 5,
      type: "bold",
    });
  });

  it("agrees with the translation on whether formatting happened", () => {
    const cases = [
      "plain text with no markers",
      "**bold** tail",
      "*i* and ~~s~~ and ||sp||",
      "`code **not bold**`",
      String.raw`\*\*escaped\*\*`,
      "** not emphasis **",
      "5*3 arithmetic",
      "[eicon]grin[/eicon]",
      "[b]passthrough[/b] **and md**",
    ];
    for (const input of cases) {
      const translated = mdToBBCode(input) !== input;
      const styled = markdownSpans(input).length > 0;
      // BBCode passthrough translates to itself, so only markdown-driven
      // change implies spans; but spans must never appear when the
      // translation is the identity and no eicon atom exists.
      if (!translated && !input.includes("[eicon]")) {
        expect(styled, input).toBe(false);
      }
      if (styled && !input.includes("[eicon]") && !input.includes("[b]")) {
        expect(translated, input).toBe(true);
      }
    }
  });
});
