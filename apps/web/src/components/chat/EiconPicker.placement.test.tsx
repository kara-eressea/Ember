// @vitest-environment jsdom

// The picker is anchored to its own height (§13 flips it above the composer's
// ☺ button), and its height moves with its content — a search narrowing from
// a full grid to one empty-state line, a gallery page landing. Before the
// audit-backlog fix the placement was only measured on mount and on a tab
// switch, so a content-driven resize left the panel at coordinates computed
// for the old height: detached from the caret, or hanging off-screen.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { EiconPicker } from "./EiconPicker.js";

let panelHeight = 300;
let resizeCallbacks: ResizeObserverCallback[] = [];

class ResizeObserverStub implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    resizeCallbacks.push(this.callback);
  }
  unobserve() {}
  disconnect() {
    resizeCallbacks = resizeCallbacks.filter((cb) => cb !== this.callback);
  }
}

/** Fire every live observer, as the browser would after a content reflow. */
function fireResize() {
  act(() => {
    for (const callback of [...resizeCallbacks]) {
      callback([], {} as ResizeObserver);
    }
  });
}

beforeEach(() => {
  panelHeight = 300;
  resizeCallbacks = [];
  globalThis.ResizeObserver = ResizeObserverStub;
  // jsdom reports every offsetHeight as 0; the picker measures the panel.
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => panelHeight,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// The composer sits low in the 768px-tall jsdom viewport, so the picker is
// placed ABOVE the button and its top is a function of its height.
const ANCHOR = { top: 680, left: 200, bottom: 700, right: 232 };

function renderPicker() {
  render(
    <EiconPicker
      identityId="identity-1"
      prefs={PREFS_DEFAULTS}
      anchor={ANCHOR}
      iconsBlacklisted={false}
      onInsert={() => undefined}
      onClose={() => undefined}
    />,
  );
  return screen.getByRole("dialog", { name: "Eicon picker" });
}

describe("EiconPicker placement", () => {
  it("re-places when its content changes the panel's height", () => {
    const panel = renderPicker();
    // 680 - 6 gap - 300 tall.
    expect(panel.style.top).toBe("374px");

    // Results narrow to a one-line empty state: the panel shrinks, and its
    // top edge must drop to keep the bottom pinned to the ☺ button.
    panelHeight = 100;
    fireResize();
    expect(panel.style.top).toBe("574px");

    // …and grows back when the results come back.
    panelHeight = 300;
    fireResize();
    expect(panel.style.top).toBe("374px");
  });

  it("clamps a panel too tall for the viewport instead of running off it", () => {
    const panel = renderPicker();
    panelHeight = 900;
    fireResize();
    // Capped to the viewport less the 8px margin on each side, then clamped.
    expect(Number.parseInt(panel.style.top, 10)).toBe(8);
  });

  it("leaves the position alone when a resize changes nothing", () => {
    const panel = renderPicker();
    const before = panel.style.top;
    fireResize();
    fireResize();
    expect(panel.style.top).toBe(before);
  });
});
