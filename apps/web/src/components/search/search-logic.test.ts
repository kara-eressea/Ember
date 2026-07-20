import { beforeEach, describe, expect, it, vi } from "vitest";

// Node test environment — back the run store with an in-memory stub.
const backing = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => backing.set(key, value),
  removeItem: (key: string) => backing.delete(key),
  clear: () => {
    backing.clear();
  },
});
import {
  filterNames,
  filtersOf,
  loadRun,
  newSince,
  normalizeFilters,
  savedMeta,
  saveRun,
  type SavedSearch,
} from "./search-logic.js";

describe("normalizeFilters", () => {
  it("drops empty optional arrays, keeps real narrowing", () => {
    expect(
      normalizeFilters({
        kinks: ["523"],
        genders: [],
        roles: ["Switch"],
      }),
    ).toEqual({ kinks: ["523"], roles: ["Switch"] });
  });
});

describe("filterNames", () => {
  it("narrows case-insensitively and passes everything on empty query", () => {
    const names = ["Kolvarr", "Vesna Marlowe", "Bramble"];
    expect(filterNames(names, "")).toEqual(names);
    expect(filterNames(names, "  vES")).toEqual(["Vesna Marlowe"]);
    expect(filterNames(names, "zzz")).toEqual([]);
  });
});

describe("newSince", () => {
  it("counts names absent from the previous run, case-insensitively", () => {
    expect(
      newSince(["Kolvarr", "Bramble"], ["kolvarr", "Vesna", "Thorn"]),
    ).toBe(2);
    expect(newSince([], ["A"])).toBe(1);
    expect(newSince(["A"], [])).toBe(0);
  });
});

describe("search runs (localStorage)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips a run and survives garbage", () => {
    expect(loadRun("s1")).toBeUndefined();
    saveRun("s1", ["Kolvarr", "Vesna"]);
    expect(loadRun("s1")?.names).toEqual(["Kolvarr", "Vesna"]);
    localStorage.setItem("emberchat.searchRun.s2", "not json");
    expect(loadRun("s2")).toBeUndefined();
  });
});

describe("saved-search helpers", () => {
  const saved: SavedSearch = {
    id: "s1",
    name: "Arctic slow-burn",
    kinks: ["523", "66"],
    genders: ["Female", "Herm"],
    languages: [],
  };

  it("filtersOf normalizes away empty arrays", () => {
    expect(filtersOf(saved)).toEqual({
      kinks: ["523", "66"],
      genders: ["Female", "Herm"],
    });
  });

  it("savedMeta counts kinks and non-empty filters", () => {
    expect(savedMeta(saved)).toBe("2 kinks · 1 filter");
    expect(savedMeta({ id: "x", name: "n", kinks: ["1"] })).toBe("1 kink");
  });
});
