// Pull-to-reveal timestamps (#513) — the phone log's horizontal gesture.
//
// On `phone` the message log drops its timestamp column entirely (the whole
// point: at 393px a stamp plus an aligned name column left roleplay prose
// rendering one word wide). The stamps are still there, parked at a negative
// inline offset just outside the log's clip edge; dragging the rows sideways
// is what brings them into view, per row, the way iMessage does it — mirrored,
// because our timestamps have always sat on the left.
//
// Two things make this safe to put on top of a scroll container that has as
// many invariants as this one does.
//
// **The axis lock.** A finger that goes down on the log has not yet said what
// it wants. The recognizer arms, watches, and decides exactly once, on the
// first movement past AXIS_LOCK_PX: predominantly horizontal claims the
// gesture, anything else releases it *for good* — no re-arming later in the
// same gesture, so a scroll that wanders a little sideways is never stolen
// mid-flick. A tie goes to the scroll, which is the reading gesture and the
// one whose failure is felt.
//
// **`touch-action: pan-y pinch-zoom` on the log** (chat.module.css) is what
// actually keeps the two apart, and it is worth being explicit that this
// module does *not* call `preventDefault` to do it: by spec a `pointermove`'s
// default action is not cancelable in any way that matters — only
// `pointerdown`'s is — so a preventDefault here would be decoration. The
// declaration is the mechanism. It tells the compositor that this element
// pans vertically and nothing else, which means (a) a horizontal gesture is
// never handled by the browser and its moves reach JS, and (b) a vertical one
// still scrolls on the compositor at full speed, arriving here as the
// `pointercancel` that releases us. `pinch-zoom` is kept because the log is
// prose and taking page zoom away from it would be a regression.
//
// The offset is published as a CSS custom property written imperatively — the
// `--eb-keyboard-inset` pattern (COMPONENTS.md §Touch conventions). A pointer
// drag produces a move event per frame and React must not see any of them.

import { useEffect, type RefObject } from "react";

/** How far a finger may wander before the axis is decided. Deliberately below
 * `useLongPress`'s 10px slop: by the time a pull is doing anything visible the
 * press it may have started on has already cancelled itself, so one gesture
 * can never both open a menu and reveal the gutter. */
export const AXIS_LOCK_PX = 8;

/** How far the rows travel at full pull. Sized from the content, not picked:
 * the widest stamp the prefs can produce (`seconds`, `12:04:33`) is ~55px of
 * tabular mono at the L type step, and it sits 8px clear of the row's leading
 * edge — so 72px shows the whole column with a little air. */
export const REVEAL_MAX_PX = 72;

/** How much further the rows will go, ever, past the cap. The pull resists
 * asymptotically beyond REVEAL_MAX_PX rather than stopping dead: a hard wall
 * reads as a dropped gesture, and this reads as an end. */
export const REVEAL_OVERSHOOT_PX = 24;

/** Snap-back duration on release. Short — this is a spring returning, not a
 * transition anyone should watch. */
export const SNAP_BACK_MS = 180;

/** The custom property the log publishes its pull offset on. */
export const REVEAL_VAR = "--eb-log-reveal";

export type PullPhase = "idle" | "armed" | "claimed";

/** The subset of a pointer event the machine reads — React synthetics, native
 * events and hand-rolled test objects all satisfy it. */
export interface PullPointer {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
}

export interface PullRevealSink {
  /** A claimed gesture moved: paint the rows this far right. */
  onReveal: (px: number) => void;
  /** A claimed gesture ended: return to rest. */
  onSettle: () => void;
}

export interface PullRevealMachine {
  phase: () => PullPhase;
  down: (event: PullPointer) => void;
  /** True when the move was consumed as part of a claimed pull. */
  move: (event: PullPointer) => boolean;
  up: () => void;
  cancel: () => void;
}

/**
 * Finger travel → row travel. Linear to the cap, then asymptotic: an infinite
 * drag lands at `REVEAL_MAX_PX + REVEAL_OVERSHOOT_PX` and never beyond, so the
 * gutter cannot be pulled off the screen no matter how hard it is yanked.
 * Leftward travel is inert — the gutter is on the left, there is nothing on
 * the right to uncover — but it is still *claimed*, so a drag that starts left
 * and comes back right reveals smoothly instead of re-deciding the axis.
 */
export function revealOffset(dx: number): number {
  if (dx <= 0) {
    return 0;
  }
  if (dx <= REVEAL_MAX_PX) {
    return dx;
  }
  const over = dx - REVEAL_MAX_PX;
  return (
    REVEAL_MAX_PX +
    REVEAL_OVERSHOOT_PX *
      (1 - REVEAL_OVERSHOOT_PX / (over + REVEAL_OVERSHOOT_PX))
  );
}

/**
 * The recognizer proper, with no DOM and no React in it — the axis lock is
 * where every interaction with the log's scroll invariants actually lives, so
 * it is driven directly by unit tests rather than through a rendered log.
 */
export function createPullReveal(sink: PullRevealSink): PullRevealMachine {
  let phase: PullPhase = "idle";
  /** The pointer being watched. Cleared the moment the gesture is released,
   * which is what makes a release final: no later move can match. */
  let pointerId: number | undefined;
  let originX = 0;
  let originY = 0;
  /** Where the pull is measured from — the position at the instant the axis
   * was claimed, not the touchdown point, so the rows start at rest instead of
   * jumping AXIS_LOCK_PX the moment they are claimed. */
  let claimX = 0;
  /** Pointers down on the log. A second one is a pinch or a two-finger
   * scroll — neither is a pull, and racing them is how you steal a zoom. */
  let down = 0;

  function reset(): void {
    phase = "idle";
    pointerId = undefined;
    down = 0;
  }

  return {
    phase: () => phase,

    down(event) {
      down += 1;
      if (down > 1) {
        // Give the gesture up rather than fight the second finger. A claimed
        // pull that a pinch interrupts still has to come home.
        if (phase === "claimed") {
          sink.onSettle();
        }
        phase = "idle";
        pointerId = undefined;
        return;
      }
      // A mouse is left entirely alone, inside the phone tier as well as
      // outside it. The tier says whether the feature exists; this says who it
      // listens to, and it has to, because a horizontal mouse drag across
      // prose is a text selection — the one gesture MP2 §6 promises survives
      // everything. A finger cannot select without a hold first, so there is
      // nothing to take from it.
      if (event.pointerType === "mouse") {
        return;
      }
      phase = "armed";
      pointerId = event.pointerId;
      originX = event.clientX;
      originY = event.clientY;
    },

    move(event) {
      if (phase === "idle" || event.pointerId !== pointerId) {
        return false;
      }
      if (phase === "armed") {
        const adx = Math.abs(event.clientX - originX);
        const ady = Math.abs(event.clientY - originY);
        if (Math.max(adx, ady) <= AXIS_LOCK_PX) {
          return false;
        }
        if (adx <= ady) {
          // Vertical, or an exact diagonal. Released for the rest of the
          // gesture: the compositor owns this one and we never touch it
          // again, not even if it turns sideways later.
          phase = "idle";
          pointerId = undefined;
          return false;
        }
        phase = "claimed";
        claimX = event.clientX;
        return true;
      }
      sink.onReveal(revealOffset(event.clientX - claimX));
      return true;
    },

    up() {
      if (phase === "claimed") {
        sink.onSettle();
      }
      reset();
    },

    cancel() {
      if (phase === "claimed") {
        sink.onSettle();
      }
      reset();
    },
  };
}

/** Cubic ease-out — the snap back is decelerating, like everything else that
 * returns to rest in this app (COMPONENTS.md §Animation). */
function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Install the pull on a scroll container. Publishes the travel as
 * `--eb-log-reveal` on that element; the stylesheet decides what moves.
 *
 * `enabled` is the layout tier, decided by the caller: this is a `phone`
 * feature the way the action sheet is one — the question it answers is
 * geometric (there is no room for a timestamp column beside 393px of prose),
 * and a 390px window on a desktop has exactly the same problem.
 */
export function usePullReveal(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!enabled || el === null) {
      return;
    }
    let frame = 0;
    let offset = 0;

    function write(px: number): void {
      offset = px;
      el?.style.setProperty(REVEAL_VAR, `${String(px)}px`);
    }

    function rest(): void {
      offset = 0;
      // Removed rather than set to 0 so `var(--eb-log-reveal, 0px)` stays the
      // single definition of "not pulled" — the keyboard inset's convention.
      el?.style.removeProperty(REVEAL_VAR);
    }

    function snapBack(): void {
      cancelAnimationFrame(frame);
      const from = offset;
      if (from === 0 || prefersReducedMotion()) {
        rest();
        return;
      }
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / SNAP_BACK_MS);
        if (t >= 1) {
          rest();
          return;
        }
        write(from * (1 - easeOut(t)));
        frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    }

    const machine = createPullReveal({
      onReveal: (px) => {
        // A fresh pull supersedes an in-flight snap-back rather than racing it.
        cancelAnimationFrame(frame);
        write(px);
      },
      onSettle: snapBack,
    });

    const onDown = (event: PointerEvent) => {
      machine.down(event);
    };
    const onMove = (event: PointerEvent) => {
      machine.move(event);
    };
    const onUp = () => {
      machine.up();
    };
    const onCancel = () => {
      machine.cancel();
    };

    // Down and move on the element: a touch pointer is implicitly captured to
    // whatever got `pointerdown`, so the moves keep arriving at that child and
    // bubble here even after the finger has wandered off the row. Up and
    // cancel at the window, for the same reason the log's own `pointerHeldRef`
    // listens there — a finger lifted over the composer, or a gesture the
    // system takes away, still ends this one.
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      cancelAnimationFrame(frame);
      rest();
    };
  }, [ref, enabled]);
}
