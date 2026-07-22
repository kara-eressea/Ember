import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VIEWER_FULLSCREEN_KEY,
  persistViewerFullscreen,
  savedViewerFullscreen,
} from "./viewer-size.js";

// Node environment — stub the storage surface the pref reads/writes.
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("viewer-size persistence", () => {
  it("defaults to windowed (false) when nothing is stored", () => {
    expect(savedViewerFullscreen()).toBe(false);
  });

  it("round-trips an explicit full-screen preference", () => {
    persistViewerFullscreen(true);
    expect(localStorage.getItem(VIEWER_FULLSCREEN_KEY)).toBe("1");
    expect(savedViewerFullscreen()).toBe(true);
  });

  it("round-trips an explicit windowed preference", () => {
    persistViewerFullscreen(false);
    expect(localStorage.getItem(VIEWER_FULLSCREEN_KEY)).toBe("0");
    expect(savedViewerFullscreen()).toBe(false);
  });

  it("reads a legacy 'true' string as full-screen", () => {
    localStorage.setItem(VIEWER_FULLSCREEN_KEY, "true");
    expect(savedViewerFullscreen()).toBe(true);
  });

  it("treats any other stored value as windowed", () => {
    localStorage.setItem(VIEWER_FULLSCREEN_KEY, "garbage");
    expect(savedViewerFullscreen()).toBe(false);
  });

  it("defaults to windowed when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
    });
    expect(savedViewerFullscreen()).toBe(false);
  });
});
