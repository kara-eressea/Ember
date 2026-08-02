// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../stores/ui.js";
import { startWindowFocusTracking } from "./window-focus.js";

afterEach(() => {
  vi.restoreAllMocks();
  useUiStore.getState().setWindowFocused(true);
});

describe("startWindowFocusTracking", () => {
  it("seeds from the real focus state and follows focus/blur (#440)", () => {
    // A tab opened in the background never fires a blur, so the seed is the
    // only thing that can correct the optimistic default.
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const stop = startWindowFocusTracking();
    expect(useUiStore.getState().windowFocused).toBe(false);

    window.dispatchEvent(new Event("focus"));
    expect(useUiStore.getState().windowFocused).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(useUiStore.getState().windowFocused).toBe(false);

    stop();
    window.dispatchEvent(new Event("focus"));
    expect(useUiStore.getState().windowFocused).toBe(false);
  });
});
