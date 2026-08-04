// A submenu that opens on hover — and what it has to be instead where the
// primary pointer cannot hover (MP2 §5-D finding, closed in MP4 / #378).
//
// The two nested panels in the context menus ("Invite to →", "Show →") open on
// `mouseenter`, close on `mouseleave`, and their trigger's own click is
// deliberately **open-only**: the pointer must enter the wrapper before it can
// click, so a toggle would shut the panel hover had only just opened (#316).
//
// On a touchscreen every part of that arrangement is wrong, and MP2's audit
// caught it in the surface built for touch. The engines synthesize a
// compatibility `mouseenter` from a press — including the press that *raises*
// the action sheet the submenu is in, so a sheet long-pressed off a DM row
// arrived with the panel already expanded, under the finger. They then never
// send the matching `mouseleave`, and against an open-only trigger that left
// no gesture on a phone that could collapse it again.
//
// So the rule is either/or, never both: where `hover: none` matches, the hover
// pair is not attached at all and the trigger becomes an ordinary toggle. It
// is the same call `RichText`'s eicon chip already makes for its preview, for
// the same reason — a touchscreen's compatibility mouse events are not a
// pointer, and wiring both paths at once is how one gesture fires two of them.
//
// Named once rather than written twice: "Show →" is a copy of "Invite to →",
// and it copied this along with everything else.

import { useNoHover } from "./pointer.js";

export interface SubmenuTrigger {
  /** Spread on the element that owns the hover region — empty on a
   * touchscreen, which is the whole point. */
  wrapper: {
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
  };
  /** What the trigger button's `onClick` should do: open-only under a mouse
   * (which has already opened it by arriving), a toggle under a finger. */
  press: () => void;
}

/**
 * Wire a hover-opened submenu for whichever pointer is driving.
 *
 * `enabled` is for a trigger that is present but has nothing to show (the
 * channel menu's "Show →" in a room the server locks to one message kind): it
 * may never open, by either route.
 */
export function useSubmenuTrigger(
  open: boolean,
  setOpen: (open: boolean) => void,
  enabled = true,
): SubmenuTrigger {
  const noHover = useNoHover();
  if (noHover) {
    return {
      wrapper: {},
      press: () => {
        setOpen(enabled && !open);
      },
    };
  }
  return {
    wrapper: {
      onMouseEnter: () => {
        setOpen(enabled);
      },
      onMouseLeave: () => {
        setOpen(false);
      },
    },
    press: () => {
      setOpen(enabled);
    },
  };
}
