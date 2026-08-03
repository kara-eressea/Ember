// @vitest-environment jsdom
//
// The layout tiers (#375), and specifically the bug they exist to prevent:
// the interface-scale pref zooms :root, so a media query at 125% still calls a
// 1000px window "wide" while the shell is painting into 800 effective pixels.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPACT_MAX_WIDTH,
  COMPACT_MIN_WIDTH,
  currentLayoutMode,
  effectiveWidth,
  layoutModeFor,
  startLayoutTracking,
} from "./layout-mode.js";

function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
  });
}

function setUiScale(percent: number) {
  document.documentElement.style.setProperty(
    "--eb-ui-zoom",
    String(percent / 100),
  );
}

afterEach(() => {
  document.documentElement.style.removeProperty("--eb-ui-zoom");
  setWindowWidth(1024); // jsdom's default
});

describe("layoutModeFor", () => {
  it("puts anything below the compact floor on the phone tier", () => {
    expect(layoutModeFor(320)).toBe("phone");
    expect(layoutModeFor(767)).toBe("phone");
    expect(layoutModeFor(COMPACT_MIN_WIDTH - 0.5)).toBe("phone");
  });

  it("includes both of its own boundaries in compact", () => {
    expect(layoutModeFor(COMPACT_MIN_WIDTH)).toBe("compact");
    expect(layoutModeFor(850)).toBe("compact");
    expect(layoutModeFor(COMPACT_MAX_WIDTH)).toBe("compact");
  });

  it("is wide only strictly above the compact ceiling", () => {
    expect(layoutModeFor(COMPACT_MAX_WIDTH + 0.5)).toBe("wide");
    expect(layoutModeFor(941)).toBe("wide");
    expect(layoutModeFor(1920)).toBe("wide");
  });

  it("keeps the boundaries where the tier table says", () => {
    expect(COMPACT_MIN_WIDTH).toBe(768);
    expect(COMPACT_MAX_WIDTH).toBe(940);
  });
});

describe("zoom-corrected tier selection", () => {
  it("reads a 1000px window as wide at 100%", () => {
    setWindowWidth(1000);
    setUiScale(100);
    expect(effectiveWidth()).toBe(1000);
    expect(currentLayoutMode()).toBe("wide");
  });

  it("reads the same 1000px window as compact at 125%", () => {
    // The shell is painting into 800 CSS pixels; a media query would still
    // see 1000 and hand it the untouched desktop grid.
    setWindowWidth(1000);
    setUiScale(125);
    expect(effectiveWidth()).toBe(800);
    expect(currentLayoutMode()).toBe("compact");
  });

  it("drops that window to phone once the scale gets steep enough", () => {
    setWindowWidth(1000);
    setUiScale(150);
    expect(currentLayoutMode()).toBe("phone");
  });

  it("treats a missing or nonsensical scale as 100%", () => {
    setWindowWidth(1000);
    document.documentElement.style.removeProperty("--eb-ui-zoom");
    expect(effectiveWidth()).toBe(1000);
    document.documentElement.style.setProperty("--eb-ui-zoom", "0");
    expect(effectiveWidth()).toBe(1000);
  });
});

describe("root attribute stamping", () => {
  let stop: (() => void) | undefined;

  beforeEach(() => {
    // Frame-coalesced publishing: run the callback immediately so a resize is
    // observable without waiting on jsdom's frame loop.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.unstubAllGlobals();
  });

  it("stamps the tier on :root as soon as it is installed", () => {
    setWindowWidth(1400);
    stop = startLayoutTracking();
    expect(document.documentElement.getAttribute("data-layout")).toBe("wide");
  });

  it("tracks a resize across both boundaries", () => {
    setWindowWidth(1400);
    stop = startLayoutTracking();

    setWindowWidth(900);
    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.getAttribute("data-layout")).toBe(
      "compact",
    );

    setWindowWidth(400);
    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.getAttribute("data-layout")).toBe("phone");

    setWindowWidth(1400);
    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.getAttribute("data-layout")).toBe("wide");
  });

  it("follows an interface-scale change with no resize at all", async () => {
    setWindowWidth(1000);
    stop = startLayoutTracking();
    expect(document.documentElement.getAttribute("data-layout")).toBe("wide");

    // Exactly what theme.ts applyInterface does — and it fires no resize
    // event, which is why the tier watcher observes the style attribute.
    setUiScale(125);
    await Promise.resolve(); // MutationObserver callbacks are microtasks
    expect(document.documentElement.getAttribute("data-layout")).toBe(
      "compact",
    );
  });

  it("clears the attribute when tracking stops", () => {
    stop = startLayoutTracking();
    stop();
    stop = undefined;
    expect(document.documentElement.hasAttribute("data-layout")).toBe(false);
  });
});
