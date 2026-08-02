import { describe, expect, it } from "vitest";
import {
  EICON_FAVORITES_CAP,
  hasEicon,
  toggleEiconFavorite,
  withEicon,
  withoutEicon,
} from "./eicon-lists.js";

describe("eicon list membership", () => {
  it("matches case-insensitively, like the server's index", () => {
    expect(hasEicon(["Sparkle"], "sparkle")).toBe(true);
    expect(hasEicon(["sparkle"], "SPARKLE")).toBe(true);
    expect(hasEicon(["sparkle"], "sparkles")).toBe(false);
    expect(hasEicon([], "sparkle")).toBe(false);
  });

  it("removes a differently-cased entry", () => {
    expect(withoutEicon(["Sparkle", "grin"], "sPaRkLe")).toEqual(["grin"]);
  });

  it("never stores the same eicon twice under two casings", () => {
    expect(withEicon(["Sparkle", "grin"], "sparkle")).toEqual([
      "grin",
      "sparkle",
    ]);
  });
});

describe("toggleEiconFavorite", () => {
  it("adds then removes", () => {
    const added = toggleEiconFavorite([], "sparkle");
    expect(added).toEqual(["sparkle"]);
    expect(toggleEiconFavorite(added, "Sparkle")).toEqual([]);
  });

  it("drops the oldest at the cap so the patch always validates", () => {
    const full = Array.from(
      { length: EICON_FAVORITES_CAP },
      (_, index) => `e${String(index)}`,
    );
    const next = toggleEiconFavorite(full, "sparkle");
    expect(next).toHaveLength(EICON_FAVORITES_CAP);
    expect(next.at(-1)).toBe("sparkle");
    expect(next[0]).toBe("e1");
  });
});
