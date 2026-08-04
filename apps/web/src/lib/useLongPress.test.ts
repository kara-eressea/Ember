// @vitest-environment jsdom
//
// The long-press state machine (MP2 §1, #376). Driven directly rather than
// through a rendered component: every rule here is about an event sequence —
// a hold, a drag, a second finger, the compatibility click, Android's
// duplicate contextmenu — and the sequences are the test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXTMENU_DEDUP_MS,
  createLongPress,
  GHOST_CLICK_MS,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP,
  type PointerLike,
  type PressEvent,
} from "./useLongPress.js";

let target: HTMLElement;

function pointer(overrides: Partial<PointerLike> = {}): PointerLike {
  return {
    pointerId: 1,
    pointerType: "touch",
    clientX: 100,
    clientY: 200,
    currentTarget: target,
    ...overrides,
  };
}

/** A cancellable stand-in, so a test can ask whether it was swallowed. */
function cancellable() {
  return {
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
}

/** Dispatch a real click, since the ghost-click swallow is a window listener.
 * Returns true when something claimed it. */
function click(on: HTMLElement = target): boolean {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  on.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  vi.useFakeTimers();
  target = document.createElement("button");
  document.body.append(target);
});

afterEach(() => {
  vi.useRealTimers();
  target.remove();
});

describe("createLongPress", () => {
  it("fires once, at the hold threshold, at the point the finger went down", () => {
    const fired: PressEvent[] = [];
    const machine = createLongPress((press) => fired.push(press));

    machine.pointerDown(pointer({ clientX: 40, clientY: 90 }));
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(fired).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ clientX: 40, clientY: 90 });
    expect(fired[0]?.currentTarget).toBe(target);

    // Holding longer does not fire again, and neither does letting go.
    vi.advanceTimersByTime(LONG_PRESS_MS * 3);
    machine.pointerUp(pointer());
    expect(fired).toHaveLength(1);
  });

  it("survives a wobble but not a drag — past the slop radius it is a scroll", () => {
    const steady = vi.fn();
    const wobbly = createLongPress(steady);
    wobbly.pointerDown(pointer({ clientX: 100, clientY: 100 }));
    // Just inside the radius, and on the diagonal so the distance is real
    // rather than one axis at a time.
    wobbly.pointerMove(pointer({ clientX: 104, clientY: 104 }));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(steady).toHaveBeenCalledTimes(1);

    const dragged = vi.fn();
    const machine = createLongPress(dragged);
    machine.pointerDown(pointer({ clientX: 100, clientY: 100 }));
    machine.pointerMove(
      pointer({ clientX: 100, clientY: 100 + LONG_PRESS_SLOP + 1 }),
    );
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(dragged).not.toHaveBeenCalled();
  });

  it("ignores movement from a pointer it is not timing", () => {
    const fire = vi.fn();
    const machine = createLongPress(fire);
    machine.pointerDown(pointer({ pointerId: 7, clientX: 100, clientY: 100 }));
    // A stray move from another pointer id must not cancel this press.
    machine.pointerMove(pointer({ pointerId: 9, clientX: 400, clientY: 400 }));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("gives up on pointercancel — the compositor took the gesture", () => {
    const fire = vi.fn();
    const machine = createLongPress(fire);
    machine.pointerDown(pointer());
    machine.pointerCancel(pointer());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fire).not.toHaveBeenCalled();
  });

  it("gives up on a second finger", () => {
    const fire = vi.fn();
    const machine = createLongPress(fire);
    machine.pointerDown(pointer({ pointerId: 1 }));
    machine.pointerDown(pointer({ pointerId: 2, clientX: 300 }));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fire).not.toHaveBeenCalled();
  });

  it("leaves a mouse alone — it already has a right button", () => {
    const fire = vi.fn();
    const machine = createLongPress(fire);
    machine.pointerDown(pointer({ pointerType: "mouse" }));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fire).not.toHaveBeenCalled();
  });

  it("swallows the compatibility click that follows a recognized press", () => {
    const machine = createLongPress(vi.fn());
    machine.pointerDown(pointer());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    // The finger can rest on the element for as long as it likes; the click
    // window opens when it lifts, not when the menu opened.
    vi.advanceTimersByTime(3_000);
    machine.pointerUp(pointer());

    // Wherever it lands — Chromium dispatches it to whatever is topmost under
    // the point by then, which after a recognized press is the sheet's own
    // backdrop.
    expect(click(document.body)).toBe(true);
    // One shot: the next click is the user's, on the menu that just opened.
    expect(click(document.body)).toBe(false);
  });

  it("stands aside for a tap that brought its own pointerdown", () => {
    const machine = createLongPress(vi.fn());
    machine.pointerDown(pointer());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    machine.pointerUp(pointer());

    // The sheet rises under the thumb that just pressed, so its ✕ can be
    // tapped well inside the ghost window. What makes that tap different is
    // that a finger goes down for it — the echo has no pointer of its own.
    window.dispatchEvent(new Event("pointerdown"));
    expect(click()).toBe(false);
  });

  it("stops waiting for a click that never comes", () => {
    const machine = createLongPress(vi.fn());
    machine.pointerDown(pointer());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    machine.pointerUp(pointer());

    vi.advanceTimersByTime(GHOST_CLICK_MS + 1);
    expect(click()).toBe(false);
  });

  it("leaves the click alone when the press was never recognized", () => {
    const machine = createLongPress(vi.fn());
    machine.pointerDown(pointer());
    machine.pointerUp(pointer());
    expect(click()).toBe(false);
  });

  it("swallows Android's duplicate contextmenu after it has fired", () => {
    const fire = vi.fn();
    const machine = createLongPress(fire);
    machine.pointerDown(pointer());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fire).toHaveBeenCalledTimes(1);

    const duplicate = cancellable();
    expect(machine.contextMenu(duplicate)).toBe(true);
    expect(duplicate.prevented).toBe(true);
    expect(duplicate.stopped).toBe(true);
  });

  it("keeps swallowing it across the lift, then stops", () => {
    const machine = createLongPress(vi.fn());
    machine.pointerDown(pointer());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    machine.pointerUp(pointer());

    // Some engines fire the contextmenu after the touch sequence ends.
    expect(machine.contextMenu(cancellable())).toBe(true);
    vi.advanceTimersByTime(CONTEXTMENU_DEDUP_MS);
    // Long after, it is a fresh interaction — a right-click from a mouse
    // plugged into the same device — and must reach the menu handler.
    expect(machine.contextMenu(cancellable())).toBe(false);
  });

  it("stands down when the platform's own hold threshold beats it", () => {
    const fire = vi.fn();
    const machine = createLongPress(fire);
    machine.pointerDown(pointer());
    vi.advanceTimersByTime(LONG_PRESS_MS - 100);

    // Android got there first. Its event opens the menu through the
    // right-click path, so it is passed through untouched…
    const platform = cancellable();
    expect(machine.contextMenu(platform)).toBe(false);
    expect(platform.prevented).toBe(false);

    // …and the timer that would have opened a second one is gone.
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fire).not.toHaveBeenCalled();
  });

  it("re-arms for the next press", () => {
    const fire = vi.fn();
    const machine = createLongPress(fire);
    machine.pointerDown(pointer());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    machine.pointerUp(pointer());

    machine.pointerDown(pointer());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("drops its timer and its click listener when disposed", () => {
    const fire = vi.fn();
    const machine = createLongPress(fire);
    machine.pointerDown(pointer());
    machine.dispose();
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fire).not.toHaveBeenCalled();

    const second = createLongPress(vi.fn());
    second.pointerDown(pointer());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    second.pointerUp(pointer());
    second.dispose();
    // The unmount happened between the lift and the click; nothing is left
    // behind to eat a click the user meant for whatever replaced it.
    expect(click()).toBe(false);
  });
});
