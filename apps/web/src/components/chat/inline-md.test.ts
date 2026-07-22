// SPIKE (#226): the inline-decoration tokenizer must agree with the
// mdToBBCode dialect on what *is* formatting — these pin the shared rules.

import { describe, expect, it } from "vitest";
import { inlineSpans, type MdSpan } from "./inline-md.js";

function types(spans: MdSpan[]): string[] {
  return spans.map((s) => `${s.type}:${String(s.from)}-${String(s.to)}`);
}

describe("inlineSpans", () => {
  it("marks **bold** with delimiters", () => {
    expect(types(inlineSpans("a **b** c"))).toEqual([
      "delim:2-4",
      "bold:4-5",
      "delim:5-7",
    ]);
  });

  it("marks *italic*, ~~strike~~ and ||spoiler||", () => {
    expect(inlineSpans("*i*").map((s) => s.type)).toEqual([
      "delim",
      "italic",
      "delim",
    ]);
    expect(inlineSpans("~~s~~")[1]?.type).toBe("strike");
    expect(inlineSpans("||sp||")[1]?.type).toBe("spoiler");
  });

  it("nests italic inside bold (overlapping marks)", () => {
    const spans = inlineSpans("**a *b* c**");
    expect(spans.some((s) => s.type === "bold")).toBe(true);
    expect(spans.some((s) => s.type === "italic")).toBe(true);
  });

  it("leaves unterminated emphasis unstyled (matches translator)", () => {
    expect(inlineSpans("**dangling")).toEqual([]);
    expect(inlineSpans("* not emphasis")).toEqual([]);
  });

  it("respects backslash escapes", () => {
    expect(inlineSpans(String.raw`\*\*not bold\*\*`)).toEqual([]);
  });

  it("nothing matches inside a code span; the span itself is styled", () => {
    const spans = inlineSpans("`**x**`");
    expect(spans.map((s) => s.type)).toEqual(["delim", "code", "delim"]);
  });

  it("emphasis closer inside code never terminates outer emphasis", () => {
    // "**a `b**` c**" — the first ** closes at the *last* **, not inside code.
    const spans = inlineSpans("**a `b**` c**");
    const bold = spans.find((s) => s.type === "bold");
    expect(bold).toEqual({ from: 2, to: 11, type: "bold" });
  });

  it("flags [eicon]name[/eicon] as one atom", () => {
    expect(types(inlineSpans("hi [eicon]lickinglips[/eicon]"))).toEqual([
      "eicon:3-29",
    ]);
  });

  it("does not cross newlines", () => {
    expect(inlineSpans("**a\nb**")).toEqual([]);
    // and offsets on line 2 are absolute
    expect(inlineSpans("x\n**b**")[1]).toEqual({
      from: 4,
      to: 5,
      type: "bold",
    });
  });
});
