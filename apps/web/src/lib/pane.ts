// The phone shell's single-pane navigation stack (MP1 package B, #375).
//
// On the `phone` tier there is room for one pane at a time, and WHICH pane is
// a pure function of the route:
//
//   /app/<Character>                     → the conversation list
//   /app/<Character>/c/<key> | /dm/<who> → that conversation
//
// Deriving it from the URL rather than from a `paneOpen` flag is the whole
// design. The browser Back button and the Android back gesture then navigate
// the stack for free — nothing has to intercept them — a deep link opens on
// the pane it names, and there is no third source of truth to drift out of
// sync with the router and the store. "Back to the list" is therefore an
// ordinary <Link> to the identity path, not a state transition.
//
// The tier comes from layout-mode.ts (zoom-corrected); this module adds no
// width of its own.

import { useLayoutMode, type LayoutMode } from "./layout-mode.js";

/** The two panes of the stack. */
export type Pane = "list" | "conversation";

/**
 * The one pane a stacked shell is showing, or `undefined` on the tiers that
 * show both columns at once (`compact` and `wide` keep today's grid). The
 * caller passes whether the route names a conversation — the *route*, not
 * whether that conversation resolved: an unjoined channel in the URL is still
 * the conversation pane, showing its empty state and a way back, rather than
 * silently becoming the list.
 */
export function visiblePane(
  mode: LayoutMode,
  onConversationRoute: boolean,
): Pane | undefined {
  if (mode !== "phone") {
    return undefined;
  }
  return onConversationRoute ? "conversation" : "list";
}

/** `visiblePane` against the live tier — re-evaluated when the window resizes
 * or the interface scale changes, so a rotation or a desktop window crossing
 * the phone boundary lands on the right pane without a navigation. */
export function usePane(onConversationRoute: boolean): Pane | undefined {
  return visiblePane(useLayoutMode(), onConversationRoute);
}
