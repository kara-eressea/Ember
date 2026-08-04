// The member-row status subset (#494): what survives into a row and what is
// flattened away. The bug this closes is the first case — a [color] status
// rendered as uncoloured plain text.

import { describe, expect, it } from "vitest";
import { statusSegments } from "./member-status.js";

describe("statusSegments", () => {
  it("keeps [color] as a coloured run, not literal tag text", () => {
    expect(statusSegments("[color=green]open for RP[/color]")).toEqual([
      { kind: "text", text: "open for RP", color: "green" },
    ]);
  });

  it("colours only the wrapped run", () => {
    expect(statusSegments("mood: [color=red]busy[/color] today")).toEqual([
      { kind: "text", text: "mood: ", color: undefined },
      { kind: "text", text: "busy", color: "red" },
      { kind: "text", text: " today", color: undefined },
    ]);
  });

  it("takes the innermost colour of nested colours", () => {
    expect(statusSegments("[color=red][color=blue]x[/color][/color]")).toEqual([
      { kind: "text", text: "x", color: "blue" },
    ]);
  });

  it("keeps [eicon] and [icon] as images", () => {
    expect(statusSegments("hi [eicon]sparkle[/eicon]")).toEqual([
      { kind: "text", text: "hi ", color: undefined },
      { kind: "image", tag: "eicon", name: "sparkle" },
    ]);
    expect(statusSegments("[icon]Vesna Kohl[/icon]")).toEqual([
      { kind: "image", tag: "icon", name: "Vesna Kohl" },
    ]);
  });

  it("flattens everything a row must not render as a control", () => {
    // [url] keeps its label, never a link chip; [user] keeps its bare name,
    // never a mention chip; an invite link keeps its visible label. Nesting
    // any of those inside the row's <button> would be invalid HTML.
    expect(statusSegments("see [url=https://x.example]my ad[/url]")).toEqual([
      { kind: "text", text: "see my ad", color: undefined },
    ]);
    expect(statusSegments("ask [user]Mara Quill[/user]")).toEqual([
      { kind: "text", text: "ask Mara Quill", color: undefined },
    ]);
    expect(statusSegments("[session=Book Club]ADH-123[/session]")).toEqual([
      { kind: "text", text: "Book Club", color: undefined },
    ]);
  });

  it("drops emphasis but keeps the text it wrapped, colour included", () => {
    expect(
      statusSegments("[b]very[/b] [color=purple][i]soon[/i][/color]"),
    ).toEqual([
      { kind: "text", text: "very ", color: undefined },
      { kind: "text", text: "soon", color: "purple" },
    ]);
  });

  it("collapses whitespace and trims, so a status stays one line", () => {
    expect(statusSegments("  two\n\nlines  ")).toEqual([
      { kind: "text", text: "two lines", color: undefined },
    ]);
  });

  it("decodes the server's wire entities exactly once (#350)", () => {
    expect(statusSegments("Other canons &amp; Summer Vibes!")).toEqual([
      { kind: "text", text: "Other canons & Summer Vibes!", color: undefined },
    ]);
  });

  it("renders unknown tags as the literal text the parser keeps", () => {
    // Never a crash, never a dropped status: the parser literalizes what it
    // does not know, and the row shows it as text.
    expect(statusSegments("[blink]hi[/blink]")).toEqual([
      { kind: "text", text: "[blink]hi[/blink]", color: undefined },
    ]);
  });

  it("has nothing to render for an empty or tags-only status", () => {
    expect(statusSegments("")).toEqual([]);
    expect(statusSegments("   ")).toEqual([]);
    expect(statusSegments("[b][/b]")).toEqual([]);
  });
});
