// The soft keyboard (MP2 §2, #376): the one place the app is allowed to have
// an opinion about how tall the usable window is.
//
// An on-screen keyboard shrinks the VISUAL viewport — the part of the page you
// can actually see. What it does to the LAYOUT viewport (the box `100%`,
// `100vh` and every percentage height resolve against) is engine-specific, and
// the three mobile engines disagree:
//
//   iOS Safari      layout viewport unchanged; the visual viewport shrinks and
//                   is scrolled down over it. `100%` still measures the full
//                   screen, so a bottom-anchored composer sits *behind* the
//                   keyboard. This is the case the module exists for.
//   Chrome Android  same by default (`interactive-widget=resizes-visual`), and
//                   the default is what we ship — see index.html for why we did
//                   not reach for `resizes-content`.
//   Firefox Android resizes the layout viewport itself, so `100%` is already
//                   correct and the inset below computes to ~0 on its own.
//
// The measurement is therefore the same everywhere and the *correction* is
// self-cancelling: where the engine already did the work, the inset is zero and
// nothing downstream moves. That is what keeps this inert on desktop, where the
// visual and layout viewports are the same box (barring pinch-zoom, which is
// handled by the same arithmetic and wants the same answer).
//
// Shape is deliberately `layout-mode.ts`'s: a module-level listener set armed
// by the first consumer, one coalesced frame per burst, `useSyncExternalStore`
// for React. The difference is what the consumer is — see startKeyboardTracking
// at the bottom: the inset is published as a CSS custom property, NOT as React
// state, because a keyboard animates open over ~250ms and re-rendering the
// conversation on every one of those frames is a cost with no benefit. CSS can
// read a variable that changes 15 times without React hearing about it at all.

import { useSyncExternalStore } from "react";
import { uiZoom } from "./ui-zoom.js";

/** The CSS custom property the tracker publishes on :root. Consumers style
 * against it (`calc(100% - var(--eb-keyboard-inset, 0px))`), so a document that
 * never armed the tracker — SSR, a test fixture, a paint before boot — falls
 * back to the full-height layout the app has always had. */
export const KEYBOARD_INSET_VAR = "--eb-keyboard-inset";

/** Insets below this are not a keyboard, whatever else they are.
 *
 * Two things to keep out. The small one is rounding: engines report fractional
 * viewport heights, and a sub-pixel disagreement must not flip the attribute or
 * dirty the property. The large one is the browser's own retracting chrome — an
 * Android address bar is ~56px and a bottom toolbar ~48px, and while both
 * *should* leave the two viewports in agreement (the layout viewport tracks the
 * small viewport, so a retracted bar makes the visual viewport the larger of
 * the two and the arithmetic goes negative into the floor below), that is a
 * guarantee about engine behaviour we would rather not depend on. Getting it
 * wrong would park a permanent ~56px dead strip along the bottom of the shell
 * whenever the address bar is showing, which is a far worse failure than
 * ignoring an implausibly short keyboard.
 *
 * 120px sits above anything the browser's own chrome can be and comfortably
 * below any soft keyboard — even a landscape phone's is ~200px — so no real
 * keyboard is missed and no toolbar is ever mistaken for one. */
const KEYBOARD_MIN_PX = 120;

export interface ViewportMetrics {
  /** The layout viewport's height — what `100%` resolves against, in the
   * viewport's own (visual) pixels. */
  layoutHeight: number;
  /** The visual viewport's height — what the user can actually see. */
  visualHeight: number;
  /** How far the visual viewport's top edge sits below the layout viewport's.
   * Non-zero when the engine scrolled the visual viewport to reveal the
   * focused field (iOS does this constantly). */
  offsetTop: number;
  /** The interface-scale `zoom` on :root (lib/ui-zoom.ts). See below — the
   * three heights above are in viewport pixels, and the answer has to come out
   * in the zoomed root's own pixels. */
  zoom: number;
}

/**
 * The occluded strip along the bottom of the layout viewport, in the ROOT's own
 * CSS pixels — the units a stylesheet inside the zoomed root will read it in.
 *
 * The visual viewport covers `[offsetTop, offsetTop + visualHeight)` of the
 * layout viewport, so whatever is hidden below it is the remainder.
 *
 * The zoom division is not decoration, and it is the same correction
 * layout-mode.ts makes for the same reason (ui-zoom.ts: "any code that has to
 * reason about the viewport in the root's own CSS pixels divides by this").
 * Measured in Chromium at the uiScale pref's 125%: `documentElement
 * .clientHeight` and `visualViewport.height` both keep reporting *viewport*
 * pixels — 727 either way, zoom or no zoom — while a `100px` term inside
 * `calc(100% - …)` on a zoomed root paints as 125 of those pixels. Publishing
 * the raw difference would therefore shrink the shell by 1.25× the keyboard and
 * leave a band of dead space above it, growing with the pref. Divide once,
 * here, where the model is under test.
 *
 * Floored at zero because the arithmetic goes negative in perfectly ordinary
 * situations — pinch-zoom makes the visual viewport smaller than the layout one
 * while scrolled anywhere but the top, and a scrolled-down visual viewport on a
 * page shorter than the screen can report an offsetTop that overshoots. Neither
 * is a keyboard, and neither may shrink the shell.
 *
 * Pure, so the whole model is testable without a DOM or an engine.
 */
export function keyboardInsetFor({
  layoutHeight,
  visualHeight,
  offsetTop,
  zoom,
}: ViewportMetrics): number {
  const occluded = layoutHeight - visualHeight - offsetTop;
  // The threshold is applied in viewport pixels, before the division: it is
  // about the engine's own rounding noise, which does not scale with the pref.
  if (!Number.isFinite(occluded) || occluded < KEYBOARD_MIN_PX) {
    return 0;
  }
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return occluded / factor;
}

/** Read the two viewports, or `undefined` where the environment has no answer
 * (SSR, jsdom without a visualViewport shim, any engine predating the API). No
 * answer means no keyboard, which is the correct reading everywhere the API is
 * missing: those engines do not have a soft keyboard that overlays the page. */
function measurable(): ViewportMetrics | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const visual = window.visualViewport;
  if (!visual) {
    return undefined;
  }
  // documentElement.clientHeight, not innerHeight: innerHeight tracks the
  // VISUAL viewport on the very engines this module is for (iOS shrinks it with
  // the keyboard), which would make the inset identically zero and the whole
  // module a no-op. clientHeight is the layout viewport by definition.
  const layoutHeight = document.documentElement.clientHeight;
  if (!Number.isFinite(layoutHeight)) {
    return undefined;
  }
  return {
    layoutHeight,
    visualHeight: visual.height,
    offsetTop: visual.offsetTop,
    zoom: uiZoom(),
  };
}

function measure(): number {
  const metrics = measurable();
  if (metrics === undefined) {
    return 0;
  }
  // Rounded to whole pixels: sub-pixel precision on a keyboard inset means
  // nothing visually, and the engines report fractional heights that jitter in
  // the last decimal on every frame of the open animation. Rounding makes the
  // equality check in publish() actually dedupe that jitter instead of waking
  // every subscriber ~15 times for one keypress.
  return Math.round(keyboardInsetFor(metrics));
}

/** The live keyboard inset in CSS pixels; 0 where nothing is occluding. */
export function currentKeyboardInset(): number {
  return measure();
}

const listeners = new Set<() => void>();
let snapshot: number | undefined;
let scheduled = false;
let frame: number | undefined;

function getSnapshot(): number {
  snapshot ??= measure();
  return snapshot;
}

/** Re-measure and wake subscribers, but only when the inset actually moved —
 * `useSyncExternalStore` re-renders on any notification, and the visual
 * viewport fires `scroll` on every address-bar nudge. */
function publish(): void {
  const next = measure();
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
  // Flag before the request, and separate from the handle, so a rAF that runs
  // its callback synchronously (test doubles, polyfills) cannot wedge the
  // scheduler shut — same reasoning as layout-mode.ts.
  scheduled = true;
  frame = requestAnimationFrame(() => {
    scheduled = false;
    frame = undefined;
    publish();
  });
}

function watch(): void {
  const visual = window.visualViewport;
  if (!visual) {
    return;
  }
  // Both signals matter and neither implies the other: `resize` is the keyboard
  // opening and closing, `scroll` is the engine sliding the visual viewport
  // over the layout one to reveal the focused field (which changes offsetTop,
  // and therefore the inset, without changing either height).
  visual.addEventListener("resize", schedule);
  visual.addEventListener("scroll", schedule);
  // The layout viewport is the other half of the subtraction, and it changes on
  // rotation and on a desktop window resize without the visual viewport
  // necessarily firing anything useful.
  window.addEventListener("resize", schedule);
}

function unwatch(): void {
  const visual = window.visualViewport;
  visual?.removeEventListener("resize", schedule);
  visual?.removeEventListener("scroll", schedule);
  window.removeEventListener("resize", schedule);
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
    snapshot = measure();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unwatch();
    }
  };
}

/** The live keyboard inset, kept current. For the rare consumer that needs the
 * number in JS; anything that only needs to *lay out* around the keyboard
 * should read the CSS variable instead and cost React nothing. */
export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}

/**
 * Publish the inset onto the document element as the `--eb-keyboard-inset`
 * custom property (plus `data-keyboard="open"` for anything that needs to
 * switch rather than subtract), and keep it there.
 *
 * Installed once at boot from main.tsx, exactly like startLayoutTracking, and
 * for the same two reasons: the value has to exist before React's first paint,
 * and the login and identity-picker screens live outside AppShell but still get
 * typed into.
 *
 * Why a CSS variable rather than React state — the decision this module turns
 * on. A keyboard does not appear, it *animates*, firing a resize per frame for
 * ~250ms, and iOS fires a `scroll` burst on top of that as it settles the
 * focused field. Routing that through `useSyncExternalStore` re-renders the
 * conversation — the virtualized log, every visible row, the member list — 15
 * times for one keypress on a device with the least CPU to spare. Writing a
 * custom property instead confines the whole thing to style recalculation on
 * the handful of rules that reference it: the shell's height, and nothing else.
 * React never learns the keyboard opened, and does not need to.
 *
 * One cross-module note, since it is not obvious from either side: writing this
 * property touches :root's inline `style` attribute, which is exactly what
 * layout-mode.ts's MutationObserver watches for interface-scale changes. So
 * every keyboard frame does wake that module's scheduler. It is deliberate that
 * this is harmless rather than merely unlikely — layout-mode coalesces into one
 * frame, re-measures a width the keyboard cannot have changed, and publishes
 * nothing because the tier did not flip. The cost is one width comparison per
 * frame and zero renders. Cheaper than the alternatives (a second attribute
 * namespace, or moving the property to <body> and splitting it from
 * `data-keyboard`), and stated here so the next person to touch either module
 * knows the coupling exists.
 *
 * Returns a stop function for tests; the app never calls it.
 */
export function startKeyboardTracking(): () => void {
  const root = document.documentElement;
  const stamp = () => {
    const inset = getSnapshot();
    if (inset > 0) {
      root.style.setProperty(KEYBOARD_INSET_VAR, `${String(inset)}px`);
      root.setAttribute("data-keyboard", "open");
    } else {
      // Removed rather than set to 0px so the `var(…, 0px)` fallback in the
      // stylesheets is the single definition of "no keyboard".
      root.style.removeProperty(KEYBOARD_INSET_VAR);
      root.removeAttribute("data-keyboard");
    }
  };
  const unsubscribe = subscribe(stamp);
  stamp();
  return () => {
    unsubscribe();
    root.style.removeProperty(KEYBOARD_INSET_VAR);
    root.removeAttribute("data-keyboard");
  };
}
