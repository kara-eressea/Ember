// One ticker for every clock on screen. Each partner clock re-rendering off
// its own setInterval would mean N timers drifting apart; this is a single
// timeout that re-arms on the next minute boundary (so it also self-corrects
// after a laptop sleep) and fans out through useSyncExternalStore.

import { useSyncExternalStore } from "react";

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
  timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
}

function subscribe(listener: () => void): () => void {
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
}

/** Unix ms, updated once a minute. */
export function useMinuteClock(): number {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}
