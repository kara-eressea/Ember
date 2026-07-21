import { describe, expect, it } from "vitest";
import { appendPage, emptyGallery, hasMore } from "./eicon-gallery.js";

describe("eicon gallery paging", () => {
  it("accumulates pages and advances the cursor", () => {
    let state = appendPage(emptyGallery, {
      names: ["a", "b", "c"],
      total: 5,
    });
    expect(state.names).toEqual(["a", "b", "c"]);
    expect(state.offset).toBe(3);
    expect(hasMore(state)).toBe(true);

    state = appendPage(state, { names: ["d", "e"], total: 5 });
    expect(state.names).toEqual(["a", "b", "c", "d", "e"]);
    expect(state.offset).toBe(5);
    expect(hasMore(state)).toBe(false);
  });

  it("de-dupes names that reappear across pages", () => {
    const first = appendPage(emptyGallery, { names: ["a", "b"], total: 4 });
    // Overlap: "b" repeats (e.g. the index shifted mid-scroll).
    const second = appendPage(first, { names: ["b", "c"], total: 4 });
    expect(second.names).toEqual(["a", "b", "c"]);
    // Cursor still advances by the reported page length.
    expect(second.offset).toBe(4);
  });

  it("reports more remaining until the total is reached", () => {
    const partial = appendPage(emptyGallery, { names: ["a"], total: 10 });
    expect(hasMore(partial)).toBe(true);
    const full = appendPage(emptyGallery, {
      names: ["a", "b"],
      total: 2,
    });
    expect(hasMore(full)).toBe(false);
  });

  it("treats an empty initial gallery as not-yet-loaded", () => {
    expect(hasMore(emptyGallery)).toBe(false);
    expect(emptyGallery.names).toEqual([]);
  });
});
