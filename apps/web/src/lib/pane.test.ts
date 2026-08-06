// @vitest-environment jsdom
//
// The phone stack's pane selection (#375): one pane at a time, chosen by the
// route and the tier, and by nothing else — no `paneOpen` flag anywhere means
// the only way the visible pane can be wrong is if one of these is.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePane, visiblePane } from "./pane.js";
import { setWindowWidth } from "../test-support/dom.js";

/** A window resize, the way the browser delivers one. */
function resizeTo(width: number) {
  act(() => {
    setWindowWidth(width);
    window.dispatchEvent(new Event("resize"));
  });
}

describe("visiblePane", () => {
  it("shows the list for an identity route on a phone", () => {
    expect(visiblePane("phone", false)).toBe("list");
  });

  it("shows the conversation for a conversation route on a phone", () => {
    expect(visiblePane("phone", true)).toBe("conversation");
  });

  it("has no single pane on the tiers that show both columns", () => {
    expect(visiblePane("compact", false)).toBeUndefined();
    expect(visiblePane("compact", true)).toBeUndefined();
    expect(visiblePane("wide", false)).toBeUndefined();
    expect(visiblePane("wide", true)).toBeUndefined();
  });

  it("answers on the route, not on whether the conversation resolved", () => {
    // AppShell passes "the URL names a conversation", so an unjoined channel
    // or a stale bookmark still opens the conversation pane — with its empty
    // state and a way back — instead of silently becoming the list.
    expect(visiblePane("phone", true)).toBe("conversation");
  });
});

describe("usePane", () => {
  beforeEach(() => {
    // Frame-coalesced publishing in layout-mode.ts: run the callback straight
    // away so a resize is observable without waiting on jsdom's frame loop.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setWindowWidth(1024); // jsdom's default
  });

  it("gives the desktop grid no pane at all", () => {
    setWindowWidth(1400);
    const { result } = renderHook(() => usePane(true));
    expect(result.current).toBeUndefined();
  });

  it("stacks below the compact floor", () => {
    setWindowWidth(390);
    expect(renderHook(() => usePane(true)).result.current).toBe("conversation");
    expect(renderHook(() => usePane(false)).result.current).toBe("list");
  });

  // The case a rotating phone and a dragged desktop window share: the route
  // does not change, the tier does, and the shell has to arrive in the right
  // shape without a navigation.
  it("takes an open conversation into and back out of the stack on resize", () => {
    setWindowWidth(1400);
    const { result } = renderHook(() => usePane(true));
    expect(result.current).toBeUndefined();

    resizeTo(390);
    expect(result.current).toBe("conversation");

    // Portrait → landscape on a phone-sized window stays inside the tier.
    resizeTo(700);
    expect(result.current).toBe("conversation");

    // Back over the floor: both columns again, still on the same route.
    resizeTo(1400);
    expect(result.current).toBeUndefined();
  });

  it("lands the list pane when the tier flips with no conversation open", () => {
    setWindowWidth(1400);
    const { result } = renderHook(() => usePane(false));
    expect(result.current).toBeUndefined();
    resizeTo(360);
    expect(result.current).toBe("list");
  });

  it("follows the interface scale, not the raw viewport", () => {
    // 1000px at 200% lays out as 500 effective pixels — a phone, however wide
    // the window is. This is the bug the tier model exists for (#375).
    setWindowWidth(1000);
    const { result } = renderHook(() => usePane(true));
    expect(result.current).toBeUndefined();

    act(() => {
      document.documentElement.style.setProperty("--eb-ui-zoom", "2");
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe("conversation");
    document.documentElement.style.removeProperty("--eb-ui-zoom");
  });
});
