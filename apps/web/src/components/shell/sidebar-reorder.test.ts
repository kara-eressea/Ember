// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePrefs, userPrefsPatchSchema } from "@emberchat/protocol";
import {
  applyManualOrder,
  clearLegacySidebarOrders,
  legacySidebarOrders,
  moveRow,
  sectionOrder,
  withSectionOrder,
  type SidebarOrderMap,
} from "./sidebar-reorder.js";

interface Row {
  id: string;
}
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
const ids = (list: Row[]) => list.map((r) => r.id);
const byId = (r: Row) => r.id;

describe("applyManualOrder", () => {
  it("returns the input order when no saved order exists", () => {
    const input = rows("a", "b", "c");
    expect(ids(applyManualOrder(input, byId, undefined))).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(ids(applyManualOrder(input, byId, []))).toEqual(["a", "b", "c"]);
  });

  it("orders saved rows by their saved position", () => {
    const input = rows("a", "b", "c");
    expect(ids(applyManualOrder(input, byId, ["c", "a", "b"]))).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("appends unsaved rows stably after the saved ones", () => {
    // b and d are not in the saved order — they keep their incoming order and
    // sort after the saved a and c.
    const input = rows("a", "b", "c", "d");
    expect(ids(applyManualOrder(input, byId, ["c", "a"]))).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  it("ignores saved ids that are no longer present", () => {
    const input = rows("a", "b");
    expect(ids(applyManualOrder(input, byId, ["gone", "b", "a"]))).toEqual([
      "b",
      "a",
    ]);
  });

  it("does not mutate the input", () => {
    const input = rows("b", "a");
    applyManualOrder(input, byId, ["a", "b"]);
    expect(ids(input)).toEqual(["b", "a"]);
  });
});

describe("moveRow", () => {
  it("drops before the target", () => {
    expect(moveRow(["a", "b", "c"], "c", "a", "before")).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("drops after the target", () => {
    expect(moveRow(["a", "b", "c"], "a", "b", "after")).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("is a no-op dropping a row onto itself", () => {
    expect(moveRow(["a", "b", "c"], "b", "b", "before")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("is a no-op for an unknown target", () => {
    expect(moveRow(["a", "b"], "a", "z", "before")).toEqual(["a", "b"]);
  });

  it("does not mutate the input", () => {
    const input = ["a", "b", "c"];
    moveRow(input, "c", "a", "before");
    expect(input).toEqual(["a", "b", "c"]);
  });
});

describe("withSectionOrder", () => {
  it("round-trips a section order per identity", () => {
    const map = withSectionOrder({}, "id-1", "channels", ["c", "a", "b"]);
    expect(sectionOrder(map, "id-1", "channels")).toEqual(["c", "a", "b"]);
  });

  it("keeps identities and sections independent", () => {
    let map: SidebarOrderMap = withSectionOrder({}, "id-1", "channels", ["a"]);
    map = withSectionOrder(map, "id-1", "dms", ["x", "y"]);
    map = withSectionOrder(map, "id-2", "channels", ["b"]);
    expect(sectionOrder(map, "id-1", "channels")).toEqual(["a"]);
    expect(sectionOrder(map, "id-1", "dms")).toEqual(["x", "y"]);
    expect(sectionOrder(map, "id-2", "channels")).toEqual(["b"]);
    expect(sectionOrder(map, "id-2", "dms")).toBeUndefined();
  });

  it("does not mutate the input map", () => {
    const map: SidebarOrderMap = { "id-1": { channels: ["a"] } };
    withSectionOrder(map, "id-1", "channels", ["b"]);
    expect(map).toEqual({ "id-1": { channels: ["a"] } });
  });

  it("produces a value the synced prefs schema accepts", () => {
    const map = withSectionOrder({}, "id-1", "friends", ["ann", "bo"]);
    const parsed = userPrefsPatchSchema.safeParse({ sidebarOrder: map });
    expect(parsed.success).toBe(true);
    expect(resolvePrefs({ sidebarOrder: map }).sidebarOrder).toEqual(map);
  });

  it("rejects an unknown section in the synced pref", () => {
    const parsed = userPrefsPatchSchema.safeParse({
      sidebarOrder: { "id-1": { nope: ["a"] } },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("legacy localStorage migration", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("reads the pre-#412 key so it can seed the pref", () => {
    localStorage.setItem(
      "emberchat.sidebarOrder",
      JSON.stringify({ "id-1": { channels: ["c", "a"] } }),
    );
    const map = legacySidebarOrders();
    expect(sectionOrder(map, "id-1", "channels")).toEqual(["c", "a"]);
    // What it yields must survive the round-trip through the prefs schema.
    expect(resolvePrefs({ sidebarOrder: map }).sidebarOrder).toEqual(map);
  });

  it("resolves malformed storage to an empty map", () => {
    localStorage.setItem("emberchat.sidebarOrder", "{not json");
    expect(legacySidebarOrders()).toEqual({});
    localStorage.setItem("emberchat.sidebarOrder", "[]");
    expect(legacySidebarOrders()).toEqual({});
  });

  it("drops non-string and non-array entries when loading", () => {
    localStorage.setItem(
      "emberchat.sidebarOrder",
      JSON.stringify({
        "id-1": { channels: ["a", 2, "b"], dms: "nope", friends: ["ok"] },
        bad: 5,
      }),
    );
    const map = legacySidebarOrders();
    expect(sectionOrder(map, "id-1", "channels")).toBeUndefined();
    expect(sectionOrder(map, "id-1", "dms")).toBeUndefined();
    expect(sectionOrder(map, "id-1", "friends")).toEqual(["ok"]);
    expect(map["bad"]).toBeUndefined();
  });

  it("clears the legacy key once migrated", () => {
    localStorage.setItem("emberchat.sidebarOrder", JSON.stringify({}));
    clearLegacySidebarOrders();
    expect(localStorage.getItem("emberchat.sidebarOrder")).toBeNull();
  });

  it("survives an unavailable localStorage without throwing", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => clearLegacySidebarOrders()).not.toThrow();
  });
});
