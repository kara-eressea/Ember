import { describe, expect, it } from "vitest";
import {
  insertAt,
  isSlashListMode,
  newestPending,
  slashKeyAction,
  stripColor,
  wrapRange,
} from "./composer-edit.js";

describe("insertAt", () => {
  it("inserts at the caret and leaves the caret after the run", () => {
    // "ab|cd" + snippet → "abXYcd", caret after XY.
    expect(insertAt("abcd", 2, 2, "XY")).toEqual({
      text: "abXYcd",
      selStart: 4,
      selEnd: 4,
    });
  });

  it("replaces the selection when from < to", () => {
    // "a[bc]d" → "aXd"
    expect(insertAt("abcd", 1, 3, "X")).toEqual({
      text: "aXd",
      selStart: 2,
      selEnd: 2,
    });
  });

  it("appends when the caret is at the end", () => {
    expect(insertAt("hi", 2, 2, "!").text).toBe("hi!");
  });

  it("drops an eicon in the middle of a word intact", () => {
    const { text } = insertAt("XY", 1, 1, "[eicon]teacup[/eicon]");
    expect(text).toBe("X[eicon]teacup[/eicon]Y");
  });
});

describe("wrapRange", () => {
  it("wraps a selection and restores the inner selection", () => {
    // select "glow", wrap ** ** → **glow**, selection still around glow.
    expect(wrapRange("glow", 0, 4, "**", "**")).toEqual({
      text: "**glow**",
      selStart: 2,
      selEnd: 6,
    });
  });

  it("wraps an empty caret with the caret between the markers", () => {
    expect(wrapRange("", 0, 0, "**", "**")).toEqual({
      text: "****",
      selStart: 2,
      selEnd: 2,
    });
  });

  it("wraps asymmetric BBCode tags", () => {
    expect(wrapRange("hi", 0, 2, "[u]", "[/u]")).toEqual({
      text: "[u]hi[/u]",
      selStart: 3,
      selEnd: 5,
    });
  });

  it("wraps only the selected sub-run", () => {
    // "a[bc]d" wrapped in ** → "a**bc**d"
    expect(wrapRange("abcd", 1, 3, "**", "**").text).toBe("a**bc**d");
  });
});

describe("stripColor", () => {
  it("removes color tags but keeps the contents", () => {
    const text = "[color=red]warm[/color]";
    expect(stripColor(text, 0, text.length)).toEqual({
      text: "warm",
      selStart: 0,
      selEnd: 4,
    });
  });

  it("is case-insensitive and strips every color tag in the run", () => {
    const text = "[COLOR=blue]a[/COLOR] [color=red]b[/color]";
    expect(stripColor(text, 0, text.length).text).toBe("a b");
  });

  it("leaves other tags untouched", () => {
    const text = "[color=red][b]x[/b][/color]";
    expect(stripColor(text, 0, text.length).text).toBe("[b]x[/b]");
  });

  it("only strips inside the selection", () => {
    const text = "[color=red]a[/color][color=red]b[/color]";
    // Select just the first tagged run.
    const firstRunEnd = "[color=red]a[/color]".length;
    const out = stripColor(text, 0, firstRunEnd);
    expect(out.text).toBe("a[color=red]b[/color]");
  });
});

describe("newestPending", () => {
  const row = (id: string, createdAt: string) => ({ id, createdAt });

  it("returns undefined when nothing is pending", () => {
    expect(newestPending([])).toBeUndefined();
  });

  it("returns the newest by creation time, not array order", () => {
    const items = [
      row("a", "2026-07-22T10:00:00.000Z"),
      row("c", "2026-07-22T10:00:02.000Z"),
      row("b", "2026-07-22T10:00:01.000Z"),
    ];
    expect(newestPending(items)?.id).toBe("c");
  });

  it("a later-armed shorter delay does not shadow an earlier send", () => {
    // 'early' was created first; 'late' created after — recall targets 'late'
    // regardless of when each is scheduled to release.
    const items = [
      row("early", "2026-07-22T10:00:00.000Z"),
      row("late", "2026-07-22T10:00:05.000Z"),
    ];
    expect(newestPending(items)?.id).toBe("late");
  });
});

describe("slashKeyAction — list-mode keyboard (#235 stale-state fix)", () => {
  it("Tab always completes the highlighted command", () => {
    expect(slashKeyAction("Tab", "/ro", "roll")).toBe("complete");
    expect(slashKeyAction("Tab", "/bottle", "bottle")).toBe("complete");
  });

  it("Enter completes a partially-typed command", () => {
    expect(slashKeyAction("Enter", "/ro", "roll")).toBe("complete");
    expect(slashKeyAction("Enter", "/b", "bottle")).toBe("complete");
  });

  it("Enter runs a fully-typed bare command instead of re-completing", () => {
    expect(slashKeyAction("Enter", "/bottle", "bottle")).toBe("run");
    expect(slashKeyAction("Enter", "/help", "help")).toBe("run");
  });

  it("is case-insensitive on the already-typed check", () => {
    expect(slashKeyAction("Enter", "/BOTTLE", "bottle")).toBe("run");
  });

  it("does nothing without a highlighted row or for other keys", () => {
    expect(slashKeyAction("Enter", "/x", undefined)).toBe("none");
    expect(slashKeyAction("ArrowDown", "/ro", "roll")).toBe("none");
  });
});

describe("isSlashListMode", () => {
  it("is list mode while the command word is being chosen", () => {
    expect(isSlashListMode("/")).toBe(true);
    expect(isSlashListMode("/ba")).toBe(true);
    expect(isSlashListMode("/bottle")).toBe(true);
  });

  it("switches to signature-hint mode once a separator follows the word", () => {
    expect(isSlashListMode("/ban Kestrel")).toBe(false);
    expect(isSlashListMode("/timeout Nyx, 30")).toBe(false);
    expect(isSlashListMode("/me waves")).toBe(false);
  });
});
