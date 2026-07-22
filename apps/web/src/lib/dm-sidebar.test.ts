import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DM_SIDEBAR_KEY,
  persistDmSidebarOpen,
  savedDmSidebarOpen,
} from "./dm-sidebar.js";

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

describe("dm-sidebar persistence", () => {
  it("defaults to open when nothing is stored", () => {
    expect(savedDmSidebarOpen()).toBe(true);
  });

  it("round-trips an explicit open preference", () => {
    persistDmSidebarOpen(true);
    expect(localStorage.getItem(DM_SIDEBAR_KEY)).toBe("1");
    expect(savedDmSidebarOpen()).toBe(true);
  });

  it("round-trips an explicit closed preference", () => {
    persistDmSidebarOpen(false);
    expect(localStorage.getItem(DM_SIDEBAR_KEY)).toBe("0");
    expect(savedDmSidebarOpen()).toBe(false);
  });

  it("reads a legacy 'true' string as open", () => {
    localStorage.setItem(DM_SIDEBAR_KEY, "true");
    expect(savedDmSidebarOpen()).toBe(true);
  });

  it("treats any other stored value as closed", () => {
    localStorage.setItem(DM_SIDEBAR_KEY, "garbage");
    expect(savedDmSidebarOpen()).toBe(false);
  });

  it("defaults to open when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
    });
    expect(savedDmSidebarOpen()).toBe(true);
  });
});
