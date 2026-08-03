// The shared-ticker lifecycle. The point of the module is that N clocks on
// screen cost ONE timer (the audit-backlog finding was PendingLine running a
// setInterval per queued row), and that the timer exists only while something
// is actually subscribed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeClock } from "./clock.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-02T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("makeClock", () => {
  it("arms nothing until the first subscriber and disarms after the last", () => {
    const clock = makeClock(1_000);
    expect(vi.getTimerCount()).toBe(0);

    const first = clock.subscribe(() => undefined);
    expect(vi.getTimerCount()).toBe(1);

    const second = clock.subscribe(() => undefined);
    const third = clock.subscribe(() => undefined);
    // Three subscribers, still one timer — this is the whole point.
    expect(vi.getTimerCount()).toBe(1);

    first();
    second();
    expect(vi.getTimerCount()).toBe(1);
    third();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fans one tick out to every subscriber and re-arms", () => {
    const clock = makeClock(1_000);
    const a = vi.fn();
    const b = vi.fn();
    clock.subscribe(a);
    clock.subscribe(b);
    const start = clock.getSnapshot();

    vi.advanceTimersByTime(1_100);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(clock.getSnapshot()).toBeGreaterThan(start);
    // Still exactly one timer after the tick — it re-armed, it didn't stack.
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1_000);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("re-arms on the period boundary rather than a fixed interval", () => {
    // Landing on the boundary is what keeps a countdown's visible digit in
    // step with the wall clock (and self-corrects after a laptop sleep).
    vi.setSystemTime(new Date("2026-08-02T12:00:00.400Z"));
    const clock = makeClock(1_000);
    const tick = vi.fn();
    clock.subscribe(tick);

    // 600ms to the next second boundary, +50ms of slack — not a full period.
    vi.advanceTimersByTime(649);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("stops ticking once unsubscribed", () => {
    const clock = makeClock(1_000);
    const tick = vi.fn();
    const stop = clock.subscribe(tick);
    stop();

    vi.advanceTimersByTime(10_000);
    expect(tick).not.toHaveBeenCalled();
  });

  it("re-arms when a later subscriber arrives after a full teardown", () => {
    const clock = makeClock(1_000);
    clock.subscribe(() => undefined)();
    expect(vi.getTimerCount()).toBe(0);

    const tick = vi.fn();
    clock.subscribe(tick);
    vi.advanceTimersByTime(1_100);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
