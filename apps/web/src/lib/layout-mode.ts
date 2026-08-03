// Layout tiers (MP1, #375): the one place the shell's responsive breakpoints
// live. Three tiers, decided on the *effective* width — window.innerWidth
// divided by the interface-scale factor:
//
//   phone   < 768            single-pane navigation stack (MP1 packages B–D)
//   compact  768 … 940       the desktop grid, tightened
//   wide    > 940            the desktop grid, unchanged
//
// The boundaries are pinned rather than left to a `max-width` reading: 768 is
// the first compact width, 940 is the last one. Effective widths are often
// fractional (a 1000px window at 110% is 909.09…), so the tiers are defined as
// half-open ranges and there is no integer-only gap to argue about.
//
// Why not @media / matchMedia (the whole point of this module): the uiScale
// pref applies `zoom` to :root, and media queries evaluate against the visual
// viewport *before* that zoom. At 125% a 1000px window paints the shell as if
// it were 800px wide — cramped, single-column territory — while every media
// query still reports 1000px and hands it the full desktop grid. Dividing by
// the zoom factor is the correction, and it means recomputation has to be
// driven by two signals, not one:
//
//   1. window `resize` — the viewport itself changed.
//   2. a style-attribute mutation on :root — theme.ts `applyInterface` is the
//      only writer of that attribute (and of --eb-ui-zoom), so a MutationObserver
//      scoped to it is an exact, near-free signal for a scale change, which
//      fires no resize event of its own. A ResizeObserver on documentElement
//      would be the other candidate, but the box it reports for a zoomed root
//      is ambiguous enough between engines that it is not worth depending on
//      when the pref that changes the zoom is right here in our own code.
//
// Both signals are coalesced into one animation frame, so a drag-resize costs
// at most one comparison per frame and only publishes when the tier actually
// flips — no visible lag, no React render per pixel.

import { useSyncExternalStore } from "react";
import { uiZoom } from "./ui-zoom.js";

export type LayoutMode = "phone" | "compact" | "wide";

/** First effective width that is no longer a phone. */
export const COMPACT_MIN_WIDTH = 768;
/** Last effective width that is still compact; above it the layout is wide. */
export const COMPACT_MAX_WIDTH = 940;

/** The tier for a width, in effective (zoom-corrected) pixels. Pure — the
 * whole tier model is testable without a DOM. */
export function layoutModeFor(width: number): LayoutMode {
  if (width > COMPACT_MAX_WIDTH) {
    return "wide";
  }
  if (width >= COMPACT_MIN_WIDTH) {
    return "compact";
  }
  return "phone";
}

/** The viewport width in the zoomed root's own CSS pixels — the width the
 * layout is actually laid out at, which is what the tiers are about. */
export function effectiveWidth(): number {
  return window.innerWidth / uiZoom();
}

/** The live tier. Defaults to `wide` wherever the environment can't answer
 * (SSR, a headless runner without a window), so non-DOM tests keep seeing
 * today's desktop shape. */
export function currentLayoutMode(): LayoutMode {
  if (typeof window === "undefined" || !Number.isFinite(window.innerWidth)) {
    return "wide";
  }
  return layoutModeFor(effectiveWidth());
}

const listeners = new Set<() => void>();
let snapshot: LayoutMode | undefined;
let scheduled = false;
let frame: number | undefined;

function getSnapshot(): LayoutMode {
  snapshot ??= currentLayoutMode();
  return snapshot;
}

/** Re-measure and wake subscribers, but only on an actual tier flip. */
function publish(): void {
  const next = currentLayoutMode();
  if (next === snapshot) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

function schedule(): void {
  if (scheduled) {
    return;
  }
  if (typeof requestAnimationFrame !== "function") {
    publish(); // no frame loop to ride (jsdom without pretendToBeVisual)
    return;
  }
  // The "is a frame pending?" flag is separate from the handle, and is set
  // before the request: a rAF that runs its callback synchronously (test
  // doubles, some polyfills) would otherwise clear state we only write
  // afterwards and wedge the scheduler shut.
  scheduled = true;
  frame = requestAnimationFrame(() => {
    scheduled = false;
    frame = undefined;
    publish();
  });
}

let observer: MutationObserver | undefined;

function watch(): void {
  window.addEventListener("resize", schedule);
  if (typeof MutationObserver === "function") {
    observer = new MutationObserver(schedule);
    // Only the inline style carries the scale; `data-layout` (which we write
    // ourselves, below) is a different attribute, so this can't feed back.
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
  }
}

function unwatch(): void {
  window.removeEventListener("resize", schedule);
  observer?.disconnect();
  observer = undefined;
  if (frame !== undefined && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(frame);
  }
  frame = undefined;
  scheduled = false;
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  if (listeners.size === 0) {
    watch();
    // A resize between the first measurement and this subscription would
    // otherwise be missed; re-measuring here closes the window.
    snapshot = currentLayoutMode();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unwatch();
    }
  };
}

/** The current layout tier, kept live. */
export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, getSnapshot, () => "wide");
}

/**
 * Mirror the live tier onto `<html data-layout="…">` and keep it there.
 * Installed once at boot (main.tsx) rather than from an AppShell effect: the
 * attribute has to exist before React's first paint — otherwise the shell
 * renders one frame of desktop geometry and then reflows — and the login and
 * identity-picker screens live outside AppShell but still need the tiers.
 * Returns a stop function for tests; the app never calls it.
 */
export function startLayoutTracking(): () => void {
  const stamp = () => {
    document.documentElement.setAttribute("data-layout", getSnapshot());
  };
  const unsubscribe = subscribe(stamp);
  stamp();
  return () => {
    unsubscribe();
    document.documentElement.removeAttribute("data-layout");
  };
}
