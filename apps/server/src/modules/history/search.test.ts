import { describe, expect, it } from "vitest";
import { escapeLike, parseSearchQuery } from "./search.js";

describe("parseSearchQuery", () => {
  it("plain text passes through", () => {
    expect(parseSearchQuery("hello there")).toEqual({ text: "hello there" });
  });

  it("extracts from: with and without quotes", () => {
    expect(parseSearchQuery("from:Nyx fire")).toEqual({
      text: "fire",
      from: "Nyx",
    });
    expect(parseSearchQuery('tea from:"Old Greywhisker"')).toEqual({
      text: "tea",
      from: "Old Greywhisker",
    });
  });

  it("extracts date bounds; start-of-day UTC", () => {
    const parsed = parseSearchQuery("after:2026-01-01 before:2026-02-01 x");
    expect(parsed.text).toBe("x");
    expect(parsed.afterMs).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(parsed.beforeMs).toBe(Date.parse("2026-02-01T00:00:00Z"));
  });

  it("keeps malformed filters as plain text instead of dropping them", () => {
    expect(parseSearchQuery("before:someday tea")).toEqual({
      text: "before:someday tea",
    });
    // Unknown filter keys are text too — no silent surprises.
    expect(parseSearchQuery("since:2026-01-01")).toEqual({
      text: "since:2026-01-01",
    });
  });

  it("escapes ILIKE wildcards", () => {
    expect(escapeLike("100%_sure\\")).toBe("100\\%\\_sure\\\\");
  });
});
