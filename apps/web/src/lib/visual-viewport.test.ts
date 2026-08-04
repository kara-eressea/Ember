// @vitest-environment jsdom
//
// The soft-keyboard inset (#376). Two things are worth pinning here: the
// arithmetic (including the zoom correction, which is the part that is wrong in
// a way nobody notices until the interface-scale pref is turned up), and the
// subscription lifecycle — the module arms listeners on the first consumer and
// must take every one of them back off when the last one leaves, or a mounted
// test suite leaks handlers into the next file.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KEYBOARD_INSET_VAR,
  currentKeyboardInset,
  keyboardInsetFor,
  startKeyboardTracking,
} from "./visual-viewport.js";

/** jsdom has no visualViewport at all, which is itself a case under test (the
 * module has to read "no keyboard" from a missing API rather than throw). The
 * rest of the file installs this stand-in, whose surface is exactly the three
 * properties and two events the module touches. */
interface FakeViewport {
  height: number;
  offsetTop: number;
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
  emit: (type: string) => void;
  listenerCount: () => number;
}

function installViewport(height: number, offsetTop = 0): FakeViewport {
  const handlers = new Map<string, Set<() => void>>();
  const fake: FakeViewport = {
    height,
    offsetTop,
    addEventListener(type, fn) {
      const set = handlers.get(type) ?? new Set();
      set.add(fn);
      handlers.set(type, set);
    },
    removeEventListener(type, fn) {
      handlers.get(type)?.delete(fn);
    },
    emit(type) {
      for (const fn of handlers.get(type) ?? []) {
        fn();
      }
    },
    listenerCount() {
      let n = 0;
      for (const set of handlers.values()) {
        n += set.size;
      }
      return n;
    },
  };
  Object.defineProperty(window, "visualViewport", {
    value: fake,
    configurable: true,
  });
  return fake;
}

function removeViewport() {
  Object.defineProperty(window, "visualViewport", {
    value: undefined,
    configurable: true,
  });
}

/** The layout viewport — the other half of the subtraction. */
function setLayoutHeight(height: number) {
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: height,
    configurable: true,
  });
}

function setUiScale(percent: number) {
  document.documentElement.style.setProperty(
    "--eb-ui-zoom",
    String(percent / 100),
  );
}

function insetVar(): string {
  return document.documentElement.style.getPropertyValue(KEYBOARD_INSET_VAR);
}

beforeEach(() => {
  setLayoutHeight(727); // the Pixel 5 the mobile e2e project runs on
});

afterEach(() => {
  removeViewport();
  document.documentElement.style.removeProperty("--eb-ui-zoom");
  document.documentElement.style.removeProperty(KEYBOARD_INSET_VAR);
  document.documentElement.removeAttribute("data-keyboard");
  vi.restoreAllMocks();
});

describe("keyboardInsetFor", () => {
  it("is the strip of the layout viewport the visual one does not cover", () => {
    expect(
      keyboardInsetFor({
        layoutHeight: 727,
        visualHeight: 427,
        offsetTop: 0,
        zoom: 1,
      }),
    ).toBe(300);
  });

  it("subtracts offsetTop — a visual viewport scrolled down over the layout one covers less of it", () => {
    // iOS slides the visual viewport to reveal the focused field, so the same
    // 300px keyboard reports a smaller occluded strip below it.
    expect(
      keyboardInsetFor({
        layoutHeight: 727,
        visualHeight: 427,
        offsetTop: 100,
        zoom: 1,
      }),
    ).toBe(200);
  });

  it("is zero when the two viewports agree — the desktop case, and Firefox Android's", () => {
    // The whole inertness guarantee: an engine that resizes the layout viewport
    // itself has already done the work, and this must add nothing on top.
    expect(
      keyboardInsetFor({
        layoutHeight: 727,
        visualHeight: 727,
        offsetTop: 0,
        zoom: 1,
      }),
    ).toBe(0);
  });

  it("floors at zero rather than growing the shell", () => {
    // Pinch-zoom: the visual viewport is smaller than the layout one but the
    // arithmetic can still come out negative once offsetTop overshoots.
    expect(
      keyboardInsetFor({
        layoutHeight: 727,
        visualHeight: 400,
        offsetTop: 500,
        zoom: 1,
      }),
    ).toBe(0);
  });

  it("ignores fractional rounding between the two viewports", () => {
    expect(
      keyboardInsetFor({
        layoutHeight: 727,
        visualHeight: 726.5,
        offsetTop: 0,
        zoom: 1,
      }),
    ).toBe(0);
  });

  it("never mistakes the browser's own chrome for a keyboard", () => {
    // An Android address bar (~56px) and a bottom toolbar (~48px). Treating
    // either as a keyboard would park a permanent dead strip along the bottom
    // of the shell for as long as the bar is showing.
    for (const chrome of [48, 56, 96]) {
      expect(
        keyboardInsetFor({
          layoutHeight: 727,
          visualHeight: 727 - chrome,
          offsetTop: 0,
          zoom: 1,
        }),
      ).toBe(0);
    }
  });

  it("still catches the shortest plausible keyboard", () => {
    // A landscape phone's is ~200px; the floor has to be well under that.
    expect(
      keyboardInsetFor({
        layoutHeight: 727,
        visualHeight: 527,
        offsetTop: 0,
        zoom: 1,
      }),
    ).toBe(200);
  });

  it("survives a non-finite reading", () => {
    expect(
      keyboardInsetFor({
        layoutHeight: Number.NaN,
        visualHeight: 427,
        offsetTop: 0,
        zoom: 1,
      }),
    ).toBe(0);
  });

  describe("the interface-scale correction", () => {
    // Measured in Chromium (Pixel 5, 727px): clientHeight and
    // visualViewport.height both keep reporting VIEWPORT pixels at any zoom,
    // while a `100px` term inside calc() on a zoomed root paints as 125 of them
    // at 125%. Publishing the raw difference would shrink the shell by 1.25× the
    // keyboard and strand a band of dead space above it.
    it("converts the occluded strip into the zoomed root's own pixels", () => {
      expect(
        keyboardInsetFor({
          layoutHeight: 727,
          visualHeight: 427,
          offsetTop: 0,
          zoom: 1.25,
        }),
      ).toBe(240); // 300 viewport px is 240 root px, which paints as 300 again
    });

    it("scales the other way for a shrunk interface", () => {
      expect(
        keyboardInsetFor({
          layoutHeight: 727,
          visualHeight: 427,
          offsetTop: 0,
          zoom: 0.75,
        }),
      ).toBe(400);
    });

    it("falls back to 1 for a poisoned factor rather than dividing by zero", () => {
      for (const zoom of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
          keyboardInsetFor({
            layoutHeight: 727,
            visualHeight: 427,
            offsetTop: 0,
            zoom,
          }),
        ).toBe(300);
      }
    });
  });
});

describe("currentKeyboardInset", () => {
  it("reads zero where the platform has no visualViewport at all", () => {
    removeViewport();
    expect(currentKeyboardInset()).toBe(0);
  });

  it("reads the live viewport", () => {
    installViewport(427);
    expect(currentKeyboardInset()).toBe(300);
  });

  it("picks up the interface scale from the document", () => {
    installViewport(427);
    setUiScale(125);
    expect(currentKeyboardInset()).toBe(240);
  });
});

describe("startKeyboardTracking", () => {
  let stop: (() => void) | undefined;

  beforeEach(() => {
    // Frame-coalesced publishing: run the callback immediately so a viewport
    // event is observable without waiting on jsdom's frame loop (the same stub
    // layout-mode.test.ts uses for the same reason).
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    // Unconditionally, and NOT at the end of each test: the listener set is
    // module-level, so a test that fails an assertion before its own stop()
    // would leak a subscriber and silently disarm every later test's watch().
    stop?.();
    stop = undefined;
    vi.unstubAllGlobals();
  });

  it("publishes nothing while no keyboard is up", () => {
    installViewport(727);
    stop = startKeyboardTracking();
    expect(insetVar()).toBe("");
    expect(document.documentElement.hasAttribute("data-keyboard")).toBe(false);
  });

  it("stamps the property and the attribute when the keyboard opens", () => {
    const viewport = installViewport(727);
    stop = startKeyboardTracking();

    viewport.height = 427;
    viewport.emit("resize");

    expect(insetVar()).toBe("300px");
    expect(document.documentElement.getAttribute("data-keyboard")).toBe("open");
  });

  it("removes both again when it closes, so the CSS fallback is the only definition of 'no keyboard'", () => {
    const viewport = installViewport(727);
    stop = startKeyboardTracking();

    viewport.height = 427;
    viewport.emit("resize");
    expect(insetVar()).toBe("300px");

    viewport.height = 727;
    viewport.emit("resize");
    expect(insetVar()).toBe("");
    expect(document.documentElement.hasAttribute("data-keyboard")).toBe(false);
  });

  it("tracks a scroll of the visual viewport, not just a resize", () => {
    // offsetTop changes without either height changing — iOS settling the
    // focused field. The inset moves, so the module has to hear about it.
    const viewport = installViewport(427);
    stop = startKeyboardTracking();
    expect(insetVar()).toBe("300px");

    viewport.offsetTop = 100;
    viewport.emit("scroll");
    expect(insetVar()).toBe("200px");
  });

  it("republishes on a plain window resize — the layout viewport is half the sum", () => {
    installViewport(427);
    stop = startKeyboardTracking();
    expect(insetVar()).toBe("300px");

    // Rotation: the layout viewport changed without the visual one firing.
    setLayoutHeight(600);
    window.dispatchEvent(new Event("resize"));
    expect(insetVar()).toBe("173px");
  });

  it("takes every listener back off when the last consumer leaves", () => {
    const viewport = installViewport(727);
    const windowRemove = vi.spyOn(window, "removeEventListener");

    stop = startKeyboardTracking();
    expect(viewport.listenerCount()).toBe(2); // resize + scroll

    stop();
    stop = undefined;
    expect(viewport.listenerCount()).toBe(0);
    expect(windowRemove).toHaveBeenCalledWith("resize", expect.any(Function));
  });

  it("leaves no trace of itself on the document after stopping", () => {
    installViewport(427);
    stop = startKeyboardTracking();
    expect(insetVar()).toBe("300px");

    stop();
    stop = undefined;
    expect(insetVar()).toBe("");
    expect(document.documentElement.hasAttribute("data-keyboard")).toBe(false);
  });

  it("does not arm anything on a platform without the API", () => {
    removeViewport();
    stop = startKeyboardTracking();
    expect(insetVar()).toBe("");
  });
});
