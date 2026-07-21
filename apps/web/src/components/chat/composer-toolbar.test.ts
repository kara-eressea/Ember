import { describe, expect, it } from "vitest";

import {
  ALWAYS_KEPT,
  caretFormats,
  clampDelay,
  collapsedActions,
  countdownLabel,
  delayLabel,
  TOOLBAR_CLUSTERS,
  type ToolbarActionId,
} from "./composer-toolbar.js";

describe("collapsedActions — narrow-width priority collapse (spec §8)", () => {
  it("collapses nothing at full width", () => {
    expect(collapsedActions(900)).toEqual([]);
  });

  it("folds in priority order: sub/sup first, colour last", () => {
    // Squeeze gradually: each narrower width is a superset of the wider.
    let previous = new Set<ToolbarActionId>();
    let sawSubFirst = false;
    for (let width = 700; width >= 100; width -= 20) {
      const collapsed = new Set(collapsedActions(width));
      for (const id of previous) {
        expect(collapsed.has(id)).toBe(true);
      }
      if (collapsed.size > 0 && previous.size === 0) {
        // The very first fold is the Script pair.
        expect([...collapsed].sort()).toEqual(["sub", "sup"]);
        sawSubFirst = true;
      }
      previous = collapsed;
    }
    expect(sawSubFirst).toBe(true);
    // At the narrowest, colour has folded too…
    expect(previous.has("color")).toBe(true);
  });

  it("Bold, Italic, Eicon and Timer survive the narrowest width", () => {
    const collapsed = collapsedActions(0);
    for (const id of ALWAYS_KEPT) {
      expect(collapsed).not.toContain(id);
    }
  });

  it("returns overflow-menu entries in toolbar order", () => {
    const order = TOOLBAR_CLUSTERS.flat();
    const collapsed = collapsedActions(0);
    const indexes = collapsed.map((id) => order.indexOf(id));
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
  });

  it("an armed timer's wider label collapses more, never less", () => {
    for (let width = 100; width <= 900; width += 50) {
      expect(collapsedActions(width, 40).length).toBeGreaterThanOrEqual(
        collapsedActions(width, 0).length,
      );
    }
  });
});

describe("caretFormats — toggle reflection (spec §3)", () => {
  it("reflects markdown markers around the caret", () => {
    const text = "a **bold** and ~~gone~~";
    expect(caretFormats(text, 5).has("bold")).toBe(true);
    expect(caretFormats(text, 11).has("bold")).toBe(false);
    expect(caretFormats(text, 19).has("strike")).toBe(true);
  });

  it("distinguishes italic from bold stars", () => {
    expect(caretFormats("*it*", 2).has("italic")).toBe(true);
    expect(caretFormats("*it*", 2).has("bold")).toBe(false);
    expect(caretFormats("**b**", 3).has("italic")).toBe(false);
  });

  it("reflects spoiler and code spans", () => {
    expect(caretFormats("||sec||", 3).has("spoiler")).toBe(true);
    expect(caretFormats("`x`", 2).has("code")).toBe(true);
    expect(caretFormats("`x` y", 5).has("code")).toBe(false);
  });

  it("reflects BBCode wrapper depth in either mode", () => {
    const text = "[u]under[/u] [sup]hi[/sup]";
    expect(caretFormats(text, 6).has("underline")).toBe(true);
    expect(caretFormats(text, 14).has("underline")).toBe(false);
    expect(caretFormats(text, 20).has("sup")).toBe(true);
  });
});

describe("timer labels", () => {
  it("formats the armed delay label", () => {
    expect(delayLabel(0)).toBe("");
    expect(delayLabel(15)).toBe("15s");
    expect(delayLabel(60)).toBe("1m");
    expect(delayLabel(300)).toBe("5m");
    expect(delayLabel(90)).toBe("1m30s");
  });

  it("formats the countdown as m:ss and never negative", () => {
    expect(countdownLabel(29)).toBe("0:29");
    expect(countdownLabel(65)).toBe("1:05");
    expect(countdownLabel(-3)).toBe("0:00");
  });

  it("clamps custom delays into the protocol's 0…300", () => {
    expect(clampDelay(45)).toBe(45);
    expect(clampDelay(9999)).toBe(300);
    expect(clampDelay(-5)).toBe(0);
    expect(clampDelay(Number.NaN)).toBe(0);
  });
});
