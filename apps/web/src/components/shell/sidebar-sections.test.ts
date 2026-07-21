import { beforeEach, describe, expect, it, vi } from "vitest";

// Node test environment — back the store with an in-memory stub.
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
  loadCollapsedSections,
  toggleCollapsedSection,
} from "./sidebar-sections.js";

describe("sidebar collapsed sections", () => {
  beforeEach(() => {
    backing.clear();
  });

  it("starts all-expanded and round-trips a toggle", () => {
    expect(loadCollapsedSections()).toEqual({});
    const next = toggleCollapsedSection({}, "bookmarks");
    expect(next).toEqual({ bookmarks: true });
    expect(loadCollapsedSections()).toEqual({ bookmarks: true });
  });

  it("toggling again expands and drops the key", () => {
    const collapsed = toggleCollapsedSection({}, "friends");
    expect(toggleCollapsedSection(collapsed, "friends")).toEqual({});
    expect(loadCollapsedSections()).toEqual({});
  });

  it("resolves stored garbage to all-expanded", () => {
    backing.set("emberchat.sidebarCollapsed", "not json");
    expect(loadCollapsedSections()).toEqual({});
    backing.set("emberchat.sidebarCollapsed", '{"channels":"yes","dms":true}');
    expect(loadCollapsedSections()).toEqual({ dms: true });
  });
});
