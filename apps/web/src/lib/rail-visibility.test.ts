// Identity-rail visibility (#346): the persist helpers round-trip the hide
// preference and tolerate an absent/poisoned store, and railHidden() forces
// the rail visible once a second identity is connected while leaving the
// stored preference untouched for the single-identity case.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistRailHidden,
  railHidden,
  savedRailHidden,
} from "./rail-visibility.js";

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
});

describe("savedRailHidden", () => {
  it("defaults to visible when nothing is stored", () => {
    expect(savedRailHidden()).toBe(false);
  });

  it("reads a stored hide preference", () => {
    storage.set("eb.rail.hidden", "1");
    expect(savedRailHidden()).toBe(true);
    storage.set("eb.rail.hidden", "0");
    expect(savedRailHidden()).toBe(false);
  });

  it('treats any non-"1" value as visible', () => {
    storage.set("eb.rail.hidden", "yes");
    expect(savedRailHidden()).toBe(false);
  });
});

describe("persistRailHidden", () => {
  it("round-trips the preference through storage", () => {
    persistRailHidden(true);
    expect(storage.get("eb.rail.hidden")).toBe("1");
    expect(savedRailHidden()).toBe(true);
    persistRailHidden(false);
    expect(storage.get("eb.rail.hidden")).toBe("0");
    expect(savedRailHidden()).toBe(false);
  });
});

describe("railHidden", () => {
  it("hides only when the pref is set and a single identity is connected", () => {
    expect(railHidden(true, 1)).toBe(true);
    expect(railHidden(true, 0)).toBe(true);
  });

  it("forces the rail visible once a second identity connects", () => {
    expect(railHidden(true, 2)).toBe(false);
    expect(railHidden(true, 3)).toBe(false);
  });

  it("stays visible whenever the pref is not set", () => {
    expect(railHidden(false, 1)).toBe(false);
    expect(railHidden(false, 2)).toBe(false);
  });
});
