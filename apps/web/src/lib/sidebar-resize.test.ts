// Resizable shell columns (#292): the clamp/persist helpers must keep widths
// inside sensible bounds, round to whole pixels, tolerate a poisoned or absent
// store, and round-trip a chosen width.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampColumnWidth,
  LEFT_DEFAULT_WIDTH,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  persistColumnWidth,
  RIGHT_DEFAULT_WIDTH,
  savedColumnWidth,
} from "./sidebar-resize.js";

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

describe("clampColumnWidth", () => {
  it("keeps a width inside bounds unchanged (but rounded)", () => {
    expect(clampColumnWidth(300.6, "left")).toBe(301);
    expect(clampColumnWidth(MIN_COLUMN_WIDTH, "right")).toBe(MIN_COLUMN_WIDTH);
    expect(clampColumnWidth(MAX_COLUMN_WIDTH, "left")).toBe(MAX_COLUMN_WIDTH);
  });

  it("clamps below the minimum and above the maximum", () => {
    expect(clampColumnWidth(10, "left")).toBe(MIN_COLUMN_WIDTH);
    expect(clampColumnWidth(9999, "right")).toBe(MAX_COLUMN_WIDTH);
    expect(clampColumnWidth(-40, "left")).toBe(MIN_COLUMN_WIDTH);
  });

  it("falls back to the column default on a non-finite value", () => {
    expect(clampColumnWidth(Number.NaN, "left")).toBe(LEFT_DEFAULT_WIDTH);
    expect(clampColumnWidth(Number.POSITIVE_INFINITY, "right")).toBe(
      RIGHT_DEFAULT_WIDTH,
    );
  });
});

describe("savedColumnWidth", () => {
  it("returns the design-system default when nothing is stored", () => {
    expect(savedColumnWidth("left")).toBe(LEFT_DEFAULT_WIDTH);
    expect(savedColumnWidth("right")).toBe(RIGHT_DEFAULT_WIDTH);
  });

  it("reads and clamps a stored width", () => {
    storage.set("eb.sidebar.leftWidth", "320");
    expect(savedColumnWidth("left")).toBe(320);
    storage.set("eb.sidebar.rightWidth", "9999");
    expect(savedColumnWidth("right")).toBe(MAX_COLUMN_WIDTH);
  });

  it("falls back to the default on a poisoned value", () => {
    storage.set("eb.sidebar.leftWidth", "not-a-number");
    expect(savedColumnWidth("left")).toBe(LEFT_DEFAULT_WIDTH);
  });
});

describe("persistColumnWidth", () => {
  it("round-trips a clamped width through storage, keyed per column", () => {
    persistColumnWidth("left", 260);
    persistColumnWidth("right", 500);
    expect(storage.get("eb.sidebar.leftWidth")).toBe("260");
    // 500 is above MAX and is clamped before writing.
    expect(storage.get("eb.sidebar.rightWidth")).toBe(String(MAX_COLUMN_WIDTH));
    expect(savedColumnWidth("left")).toBe(260);
    expect(savedColumnWidth("right")).toBe(MAX_COLUMN_WIDTH);
  });
});
