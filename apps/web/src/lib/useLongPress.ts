// Long-press recognition (MP2 §1, #376). The one genuine functional hole on
// touch: every context menu in the app hangs off `onContextMenu`, and iOS
// Safari never fires that event from a long press. Android synthesizes it,
// desktop browsers fire it from the right button — iOS alone leaves the menus
// unreachable. This module is the second opener: a hold on a claimed element
// calls the same handler the right-click calls, with the same shape of event.
//
// Pointer events rather than touch events, for two reasons that both matter
// here. The browser implicitly captures a *touch* pointer to the element that
// received `pointerdown`, so `pointermove`/`up`/`cancel` keep arriving at that
// element even after the finger has wandered off it — no document-level
// listener, no manual setPointerCapture. And a scroll is announced as
// `pointercancel` the moment the compositor takes the gesture over, which is
// the single most reliable "this was a drag, not a press" signal there is.
// The slop radius is the backstop for the engines that hesitate before
// cancelling, not the primary test.
//
// What the recognizer deliberately does NOT do: set `touch-action: none`.
// Every claimed target sits inside something scrollable (the log, the member
// list, the sidebar), and taking the gesture away from the compositor to get
// cleaner `pointermove` data would cost the scroll it is sitting in.
//
// Installed only where `useNoHover()` says the primary pointer cannot hover.
// On a desktop the right-click already works and a long left-press means text
// selection; claiming it there would be a regression, so with a hover-capable
// pointer this hook returns nothing at all and no listener is attached.

import { useEffect, useInsertionEffect, useMemo, useRef } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useNoHover } from "./pointer.js";

/** How long the finger must stay down. 450ms sits between iOS's own callout
 * delay (~500ms) and the point where a hold starts to feel unresponsive. */
export const LONG_PRESS_MS = 450;

/** How far it may wander first, in client pixels. Past this the gesture is a
 * scroll that the compositor has not got around to cancelling yet. */
export const LONG_PRESS_SLOP = 10;

/** How long after a recognized press — measured from recognition, and again
 * from the lift — a synthetic `contextmenu` is treated as this press's rather
 * than a new interaction's. Android fires it around its own hold threshold,
 * which is close to ours but not pinned to it. */
export const CONTEXTMENU_DEDUP_MS = 700;

/** How long after the finger lifts the compatibility click is still expected.
 * Engines dispatch it within a frame or two of `pointerup`; the window is
 * measured from the lift rather than from recognition because a hold can be
 * held for as long as the user likes after the menu has opened. */
export const GHOST_CLICK_MS = 350;

/**
 * What a menu opener needs from the event that opened it. A real
 * `contextmenu` MouseEvent satisfies it, and so does the synthetic press this
 * module hands to the same handler — which is the whole point: the right-click
 * path is not reimplemented for touch, it is called.
 */
export interface PressEvent {
  clientX: number;
  clientY: number;
  /** The element the handler was attached to. Carried because some openers
   * anchor to the row rather than to the point (the identity rail measures
   * it, so a Menu-key press lands beside the avatar and not in the corner)
   * — for a press it is the element the finger went down on. */
  currentTarget: EventTarget & Element;
  preventDefault: () => void;
  stopPropagation: () => void;
}

/** The subset of a pointer event the machine reads. React's synthetic pointer
 * events satisfy it; so does a hand-rolled object in a unit test. */
export interface PointerLike {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  currentTarget: EventTarget & Element;
}

/** A cancellable event the machine may swallow (click, contextmenu). */
export interface CancellableLike {
  preventDefault: () => void;
  stopPropagation: () => void;
}

export interface LongPressMachine {
  pointerDown: (event: PointerLike) => void;
  pointerMove: (event: PointerLike) => void;
  pointerUp: (event: PointerLike) => void;
  pointerCancel: (event: PointerLike) => void;
  /** Returns true when the event was swallowed as this press's duplicate. */
  contextMenu: (event: CancellableLike) => boolean;
  /** Drop timers and listeners — the hook calls this on unmount. */
  dispose: () => void;
}

/**
 * The recognizer proper, with no React in it. Kept separate from the hook so
 * the state machine — which is where every browser quirk this module exists
 * for actually lives — can be driven directly by a test.
 */
export function createLongPress(
  fire: (press: PressEvent) => void,
): LongPressMachine {
  /** The press being timed, if any. */
  let armed:
    | {
        pointerId: number;
        x: number;
        y: number;
        target: EventTarget & Element;
      }
    | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Pointers currently down on this element. A second one means a pinch or a
   * two-finger scroll, neither of which is a press. */
  let down = 0;
  /** True from recognition until the gesture ends: it is what makes the lift
   * arm a ghost-click swallow, and what swallows a duplicate contextmenu
   * arriving while the finger is still down. */
  let recognized = false;
  let recognizedAt = 0;
  /** The one-shot capture listener that eats that click, while installed. */
  let ghost: (() => void) | undefined;

  function disarm(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    armed = undefined;
  }

  /**
   * Eat the compatibility ("ghost") click that the engines synthesize from a
   * touch after `pointerup`. It has to go: the claimed elements are links,
   * rows and buttons whose click does something — opens the conversation,
   * inserts the eicon — and a hold that opens a menu must not also navigate.
   *
   * On `window` in the capture phase rather than on the element, and without
   * asking where it landed, because it does not reliably land where the
   * finger was. Verified in Chromium mobile emulation: a hold on an eicon
   * opened the sheet, and the click Chromium then synthesized was dispatched
   * to the sheet's *backdrop* — the topmost element under the point by then —
   * which closed the sheet in the same frame it appeared in. A swallow scoped
   * to the pressed subtree would have missed it entirely.
   *
   * What tells the ghost apart from a real tap is not its target but its
   * lack of a `pointerdown`: the engines synthesize the mouse compatibility
   * events from the touch that already ended, and no new pointer goes down
   * for them. So any pointerdown disarms this, and the first click after a
   * lift with no pointerdown in between is the echo. The timer is only a
   * backstop for a lift that is never followed by either.
   */
  function armGhostClick(): void {
    if (typeof window === "undefined") {
      return;
    }
    ghost?.();
    const onClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      ghost?.();
    };
    const onPointerDown = () => {
      ghost?.();
    };
    const expiry = setTimeout(() => {
      ghost?.();
    }, GHOST_CLICK_MS);
    ghost = () => {
      clearTimeout(expiry);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      ghost = undefined;
    };
    window.addEventListener("click", onClick, true);
    window.addEventListener("pointerdown", onPointerDown, true);
  }

  /** End of gesture, however it ended. */
  function settle(): void {
    disarm();
    recognized = false;
    down = 0;
  }

  return {
    pointerDown(event) {
      down += 1;
      // A second finger while the first is being timed: the user is pinching
      // or two-finger scrolling. Give the gesture up rather than racing it.
      if (down > 1) {
        disarm();
        return;
      }
      // A mouse under `hover: none` is odd enough to be a lie (some Android
      // browsers report one for a stylus) but it already has a right button,
      // and claiming a mouse's press would take text selection with it.
      if (event.pointerType === "mouse") {
        return;
      }
      recognized = false;
      armed = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        target: event.currentTarget,
      };
      timer = setTimeout(() => {
        timer = undefined;
        const press = armed;
        armed = undefined;
        if (!press) {
          return;
        }
        recognized = true;
        recognizedAt = Date.now();
        // A synthetic event, and its preventDefault/stopPropagation are
        // deliberately inert: the handlers on the other side call them
        // because they were written for a real `contextmenu`, and there is
        // no browser default pending here to prevent. The suppression this
        // press does need — the ghost click, the duplicate contextmenu — is
        // this module's own business, below.
        fire({
          clientX: press.x,
          clientY: press.y,
          currentTarget: press.target,
          preventDefault: () => undefined,
          stopPropagation: () => undefined,
        });
      }, LONG_PRESS_MS);
    },

    pointerMove(event) {
      if (!armed || event.pointerId !== armed.pointerId) {
        return;
      }
      // Square distance, no sqrt: the radius is a threshold, not a number
      // anyone reads.
      const dx = event.clientX - armed.x;
      const dy = event.clientY - armed.y;
      if (dx * dx + dy * dy > LONG_PRESS_SLOP * LONG_PRESS_SLOP) {
        disarm();
      }
    },

    pointerUp() {
      if (recognized) {
        // Restart the dedup window at the lift, not at recognition: a hold can
        // be held for seconds after the menu opened, and a duplicate
        // contextmenu that arrives as the finger comes off is still this
        // press's.
        recognizedAt = Date.now();
        armGhostClick();
      }
      settle();
    },

    pointerCancel() {
      // The compositor took the gesture — a scroll, or the system stepping in
      // (an incoming call, the iOS callout that we did not manage to suppress).
      // No click follows a cancel, so nothing to arm against.
      settle();
    },

    contextMenu(event) {
      if (armed) {
        // The platform's own hold threshold beat ours. Its `contextmenu` is
        // about to open the menu through the right-click path, which is the
        // correct outcome — stand down so the timer does not open a second
        // one a few milliseconds later.
        disarm();
        return false;
      }
      if (recognized || Date.now() - recognizedAt < CONTEXTMENU_DEDUP_MS) {
        // Ours opened the menu; this is Android's duplicate. Swallowing it
        // before the element's own `onContextMenu` sees it is what makes one
        // hold open one menu.
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      return false;
    },

    dispose() {
      disarm();
      ghost?.();
      recognized = false;
      down = 0;
    },
  };
}

/** Props to spread onto a claimed element. Empty where the pointer can hover. */
export interface LongPressProps {
  onPointerDown?: (event: ReactPointerEvent) => void;
  onPointerMove?: (event: ReactPointerEvent) => void;
  onPointerUp?: (event: ReactPointerEvent) => void;
  onPointerCancel?: (event: ReactPointerEvent) => void;
  onContextMenuCapture?: (event: ReactMouseEvent) => void;
  /** Marks the element for the native-behaviour suppression in base.css.
   * Its presence is the scope: only claimed elements carry it, so message
   * prose keeps its text selection and its callout menu. */
  "data-eb-press"?: "";
}

/**
 * Claim an element for long-press, calling `onPress` with the same event shape
 * its `onContextMenu` handler already takes. Returns props to spread; they are
 * empty — no listeners, no attribute — wherever the primary pointer can hover.
 *
 * `onPress` need not be stable — the claimed elements include a per-eicon
 * component that re-renders with the log — and neither the machine nor the
 * props it is spread through are rebuilt when it changes: a press being timed
 * must survive a re-render that lands mid-hold.
 *
 * The machine lives in a ref built by an effect, which is also what keeps it
 * out of render: it is only ever reached from an event handler or a timer.
 */
export function useLongPress(
  onPress: ((press: PressEvent) => void) | undefined,
): LongPressProps {
  const noHover = useNoHover();
  const enabled = noHover && onPress !== undefined;
  const machineRef = useRef<LongPressMachine>(undefined);
  const pressRef = useRef(onPress);
  // Latest handler without re-subscribing (the useEscapeToClose convention).
  useInsertionEffect(() => {
    pressRef.current = onPress;
  });

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const machine = createLongPress((press) => {
      pressRef.current?.(press);
    });
    machineRef.current = machine;
    return () => {
      machine.dispose();
      machineRef.current = undefined;
    };
  }, [enabled]);

  return useMemo(() => {
    if (!enabled) {
      return {};
    }
    return {
      onPointerDown(event) {
        // One hold opens one menu even where a claimed element sits inside
        // another one: React's synthetic pointer events bubble, so the inner
        // recognizer runs first, and the mark it leaves on the native event
        // tells every recognizer above it to stand down.
        if (isClaimed(event.nativeEvent)) {
          return;
        }
        claim(event.nativeEvent);
        machineRef.current?.pointerDown(event);
      },
      onPointerMove(event) {
        machineRef.current?.pointerMove(event);
      },
      onPointerUp(event) {
        machineRef.current?.pointerUp(event);
      },
      onPointerCancel(event) {
        machineRef.current?.pointerCancel(event);
      },
      onContextMenuCapture(event) {
        // Capture, so this runs before the element's own `onContextMenu` and
        // can take the duplicate away from it.
        machineRef.current?.contextMenu(event);
      },
      "data-eb-press": "",
    };
  }, [enabled]);
}

/** Marks a native pointerdown as already claimed by a nested recognizer. */
const CLAIMED = Symbol.for("emberchat.longpress.claimed");

function isClaimed(event: Event): boolean {
  return (event as Event & { [CLAIMED]?: true })[CLAIMED] === true;
}

function claim(event: Event): void {
  (event as Event & { [CLAIMED]?: true })[CLAIMED] = true;
}
