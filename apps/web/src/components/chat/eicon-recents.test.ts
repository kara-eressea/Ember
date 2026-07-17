import { describe, expect, it } from "vitest";
import { eiconsIn, mergeRecents } from "./eicon-recents.js";

describe("eiconsIn", () => {
  it("extracts names in order, case-insensitively deduped", () => {
    expect(
      eiconsIn(
        "hi [eicon]teacup[/eicon] and [EICON]Teacup[/EICON] [eicon]fox tail[/eicon]",
      ),
    ).toEqual(["teacup", "fox tail"]);
  });

  it("drops names the pref schema would refuse", () => {
    expect(
      eiconsIn(`[eicon]bad/slash[/eicon] [eicon]${"x".repeat(101)}[/eicon]`),
    ).toEqual([]);
  });

  it("returns nothing for plain text", () => {
    expect(eiconsIn("no eicons here")).toEqual([]);
  });
});

describe("mergeRecents", () => {
  it("puts new uses first and dedupes what was already there", () => {
    expect(mergeRecents(["a", "b", "c"], ["c", "d"])).toEqual([
      "c",
      "d",
      "a",
      "b",
    ]);
  });

  it("caps at the limit, dropping the oldest", () => {
    const existing = Array.from({ length: 50 }, (_, i) => `old${String(i)}`);
    const merged = mergeRecents(existing, ["new"]);
    expect(merged).toHaveLength(50);
    expect(merged[0]).toBe("new");
    expect(merged).not.toContain("old49");
  });
});
