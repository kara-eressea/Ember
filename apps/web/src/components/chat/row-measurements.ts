// Measured message-row heights that outlive the virtualizer instance (#460).
//
// The MessageLog is keyed by conversation, so switching channels destroys the
// virtualizer and with it every height it measured. The next visit therefore
// lays every row out against the flat 26px estimate again — and long roleplay
// rows measure 10–40x that, so the log paints its rows stacked on top of one
// another until the measurement pass catches up. Keeping the sizes here means a
// revisit opens from truth: the first layout is already correct, and only rows
// that were never on screen fall back to the estimate.
//
// Sizes are only valid for the layout that produced them, so two things
// invalidate the whole store: the log's width (wrapping is what makes a row
// tall) and the type/density prefs that set the row's font and padding. Both
// are all-or-nothing — a resize or a pref change reflows every conversation, so
// there is nothing worth keeping.

import type { VirtualItem } from "@tanstack/react-virtual";

/** Conversations to remember, most-recently-used last. A handful of channels is
 * the realistic working set; the map holds one small array per conversation. */
const MAX_CONVERSATIONS = 12;

const EMPTY: VirtualItem[] = [];

/** convId → the virtualizer snapshot from that conversation's last visit.
 * Insertion order IS the LRU order: `rememberMeasuredRows` re-inserts, and a
 * conversation is only read back after a visit that filed it. */
const byConversation = new Map<string, VirtualItem[]>();
let logWidth = 0;
let prefsSignature = "";

/** The log's content width changed (window resize, rail toggle, sidebar): every
 * measured height was taken at the old width, so drop them all. */
export function noteLogWidth(width: number): void {
  // A log that is unmounting, or one measured before it has been laid out,
  // reports zero — which is not a layout change, and treating it as one would
  // throw away the snapshot the conversation we are switching TO is about to
  // ask for.
  if (width <= 0) {
    return;
  }
  if (width !== logWidth) {
    logWidth = width;
    byConversation.clear();
  }
}

/**
 * Heights measured under the previous visit's layout, or empty when there is
 * nothing usable. Pass straight to `initialMeasurementsCache`.
 *
 * A pure read, deliberately (#560): the log calls it from render, and render is
 * not a commit — React 19 StrictMode invokes it twice in development, and a
 * render discarded by a transition or a Suspense retry runs it for a commit
 * that never happens. Clearing the store from there would throw away the
 * heights of a conversation that is still mounted, which is the #460 stacking
 * bug this module exists to prevent. `noteVisit` does the writing, from a
 * layout effect.
 */
export function measuredRows(convId: string, signature: string): VirtualItem[] {
  if (signature !== prefsSignature) {
    return EMPTY;
  }
  return byConversation.get(convId) ?? EMPTY;
}

/**
 * A log is now on screen for `convId` under `signature` — everything the read
 * above used to do as a side effect, moved to where a side effect belongs.
 *
 * Two things happen here. A signature the store has not seen invalidates every
 * remembered height at once (the type ramp, the density and the layout tier
 * reflow every row of every conversation, exactly like `noteLogWidth`); and the
 * visited conversation moves to the front of the LRU queue, so a channel the
 * user keeps coming back to is not evicted by the ones they pass through.
 *
 * Called from a layout effect, so it still lands before the outgoing log's
 * unmount cleanup files its snapshot — `rememberMeasuredRows` compares against
 * this signature specifically to drop heights measured under the old layout.
 */
export function noteVisit(convId: string, signature: string): void {
  if (signature !== prefsSignature) {
    prefsSignature = signature;
    byConversation.clear();
    return;
  }
  const items = byConversation.get(convId);
  if (items === undefined) {
    return;
  }
  byConversation.delete(convId);
  byConversation.set(convId, items);
}

/** Keep this visit's measurements for the next one (`virtualizer.takeSnapshot()`
 * on unmount). */
export function rememberMeasuredRows(
  convId: string,
  signature: string,
  items: VirtualItem[],
): void {
  prefsSignature ||= signature;
  // The unmounting log measured under the layout it was rendered in, and a pref
  // change mid-visit is exactly what makes that a DIFFERENT layout from the one
  // the next visit will use — the incoming log has already re-read the store
  // under the new signature by the time this runs. Drop the stale heights rather
  // than filing them (or, worse, re-stamping the layout back).
  if (signature !== prefsSignature || items.length === 0) {
    return;
  }
  byConversation.delete(convId);
  byConversation.set(convId, items);
  for (const oldest of byConversation.keys()) {
    if (byConversation.size <= MAX_CONVERSATIONS) {
      break;
    }
    byConversation.delete(oldest);
  }
}

/** Test seam: the store is module state, so unit tests need a clean slate. */
export function resetMeasuredRows(): void {
  byConversation.clear();
  logWidth = 0;
  prefsSignature = "";
}
