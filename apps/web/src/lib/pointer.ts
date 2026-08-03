// Pointer capability (MP1 §5-F). The CSS half of the hover-affordance
// fallbacks lives in styles/base.css (data-eb-hover-reveal); this is the half
// that behaviour needs — a preview that only ever opens from mouseenter has
// to open from a tap instead, and only where there is no hover to open it
// from.
//
// `hover: none` rather than `pointer: coarse`, the same call the CSS makes,
// and a media query rather than a measurement: the spec's §2 correction is
// about *layout* questions, which media queries answer wrongly under the
// interface-scale zoom. This is a device question, which they answer exactly.
// The question is whether the primary pointer can hover at all, not whether
// some attached input is coarse — a touchscreen laptop answers "yes, it has a
// mouse" and keeps the desktop behaviour untouched.
//
// One subscription for the whole app, not one per consumer: useNoHover() is
// called from EiconChip, which is per-eicon inside RichText, so a long log in
// name-only display mode mounts hundreds of them, each otherwise holding its
// own listener for the same global boolean. Same shape as lib/layout-mode.ts
// — its sibling module: that one answers "how wide is the layout", this one
// "can the pointer hover", and neither imports the other — a module-level
// listener set, one real MediaQueryList subscription installed when the first
// consumer arrives and dropped when the last leaves, published through
// useSyncExternalStore.

import { useSyncExternalStore } from "react";

/** The device question this module is about. */
export const NO_HOVER_QUERY = "(hover: none)";

/** The live answer, read straight from the platform. False wherever the
 * environment can't answer (SSR, jsdom without matchMedia) — which is the
 * desktop behaviour, the one this module exists to leave alone. */
export function noHoverNow(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) {
    return false;
  }
  return window.matchMedia(NO_HOVER_QUERY).matches;
}

const listeners = new Set<() => void>();
let snapshot: boolean | undefined;
let query: MediaQueryList | undefined;

function getSnapshot(): boolean {
  // With no subscriber there is no change event keeping a cached answer
  // honest, so measure instead of trusting it. (It is also what stops two
  // consecutive tests, swapping the matchMedia stub between them, from
  // reading each other's answer.)
  if (listeners.size === 0) {
    snapshot = noHoverNow();
  }
  return snapshot ?? noHoverNow();
}

function publish(): void {
  const next = noHoverNow();
  if (next === snapshot) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) {
    return () => {};
  }
  if (listeners.size === 0) {
    // The capability does change mid-session — plugging a mouse into a
    // tablet, or a devtools device-emulation toggle, which is how this gets
    // exercised in practice. Re-measure while arming, too: a change between
    // the first read and this subscription would otherwise be missed.
    query = window.matchMedia(NO_HOVER_QUERY);
    query.addEventListener("change", publish);
    snapshot = noHoverNow();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      query?.removeEventListener("change", publish);
      query = undefined;
    }
  };
}

/** True while the primary pointer cannot hover. */
export function useNoHover(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
