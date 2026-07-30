// Identity-rail visibility store (#346): toggle/setHidden flip the preference
// and persist it, so a reload restores the choice.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useRailStore } from "./rail.js";

const storage = new Map<string, string>();

beforeAll(() => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});

beforeEach(() => {
  storage.clear();
  useRailStore.setState({ hidden: false });
});

describe("useRailStore", () => {
  it("toggle flips the preference and persists it", () => {
    useRailStore.getState().toggle();
    expect(useRailStore.getState().hidden).toBe(true);
    expect(storage.get("eb.rail.hidden")).toBe("1");

    useRailStore.getState().toggle();
    expect(useRailStore.getState().hidden).toBe(false);
    expect(storage.get("eb.rail.hidden")).toBe("0");
  });

  it("setHidden writes an explicit value through storage", () => {
    useRailStore.getState().setHidden(true);
    expect(useRailStore.getState().hidden).toBe(true);
    expect(storage.get("eb.rail.hidden")).toBe("1");
  });
});
