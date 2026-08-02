// One ticker per period for every clock on screen. Each partner clock or
// pending-send countdown re-rendering off its own setInterval would mean N
// timers drifting apart; each clock here is a single timeout that re-arms on
// the next period boundary (so it also self-corrects after a laptop sleep)
// and fans out through useSyncExternalStore. Nothing is armed until the first
// subscriber and the timer is cleared again when the last one leaves.

import { useSyncExternalStore } from "react";

interface Clock {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => number;
}

/** Exported for the unit test — the app uses the two hooks below. */
export function makeClock(period: number): Clock {
  const listeners = new Set<() => void>();
  let snapshot = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function tick(): void {
    snapshot = Date.now();
    for (const listener of listeners) {
      listener();
    }
    arm();
  }

  function arm(): void {
    // +50ms so we land just after the boundary, never a hair before it.
    timer = setTimeout(tick, period - (Date.now() % period) + 50);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (timer === undefined) {
        snapshot = Date.now();
        arm();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
    },
    getSnapshot: () => snapshot,
  };
}

const minute = makeClock(60_000);
const second = makeClock(1_000);

/** Unix ms, updated once a minute. */
export function useMinuteClock(): number {
  return useSyncExternalStore(
    minute.subscribe,
    minute.getSnapshot,
    minute.getSnapshot,
  );
}

/** Unix ms, updated once a second — for countdowns, where a minute clock is
 * far too coarse (the outbox pending rows). */
export function useSecondClock(): number {
  return useSyncExternalStore(
    second.subscribe,
    second.getSnapshot,
    second.getSnapshot,
  );
}
