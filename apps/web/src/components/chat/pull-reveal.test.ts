// The pull-to-reveal axis lock (#513). The recognizer sits on top of a scroll
// container carrying every invariant in #266/#360/#372/#411/#454, so what is
// worth pinning is not "does it reveal" but "when does it refuse to" — the
// decision boundary, the finality of a release, and the two pointer shapes it
// never touches at all.

import { describe, expect, it, vi } from "vitest";
import {
  AXIS_LOCK_PX,
  REVEAL_MAX_PX,
  REVEAL_OVERSHOOT_PX,
  createPullReveal,
  revealOffset,
  type PullPointer,
  type PullRevealMachine,
} from "./pull-reveal.js";

function touch(x: number, y: number, id = 1): PullPointer {
  return { pointerId: id, pointerType: "touch", clientX: x, clientY: y };
}

function harness(): {
  machine: PullRevealMachine;
  reveal: ReturnType<typeof vi.fn>;
  settle: ReturnType<typeof vi.fn>;
} {
  const reveal = vi.fn();
  const settle = vi.fn();
  const machine = createPullReveal({ onReveal: reveal, onSettle: settle });
  return { machine, reveal, settle };
}

/** The last offset the machine painted. */
function lastOffset(reveal: ReturnType<typeof vi.fn>): number {
  const call = reveal.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call?.[0] as number;
}

describe("revealOffset", () => {
  it("tracks the finger one-to-one up to the cap", () => {
    expect(revealOffset(0)).toBe(0);
    expect(revealOffset(30)).toBe(30);
    expect(revealOffset(REVEAL_MAX_PX)).toBe(REVEAL_MAX_PX);
  });

  it("is inert leftward — the gutter is on the left, nothing is right", () => {
    expect(revealOffset(-1)).toBe(0);
    expect(revealOffset(-400)).toBe(0);
  });

  it("resists past the cap and never passes the overshoot ceiling", () => {
    const justPast = revealOffset(REVEAL_MAX_PX + 20);
    expect(justPast).toBeGreaterThan(REVEAL_MAX_PX);
    expect(justPast).toBeLessThan(REVEAL_MAX_PX + 20);
    // A yank of half a screen still lands inside the ceiling.
    expect(revealOffset(REVEAL_MAX_PX + 2000)).toBeLessThan(
      REVEAL_MAX_PX + REVEAL_OVERSHOOT_PX,
    );
    // …and monotonically: more finger is always at least as much reveal.
    expect(revealOffset(200)).toBeGreaterThan(revealOffset(150));
  });
});

describe("the axis lock", () => {
  it("stays undecided inside the threshold", () => {
    const { machine, reveal } = harness();
    machine.down(touch(100, 300));
    expect(machine.phase()).toBe("armed");
    machine.move(touch(100 + AXIS_LOCK_PX, 300));
    expect(machine.phase()).toBe("armed");
    expect(reveal).not.toHaveBeenCalled();
  });

  it("claims a predominantly horizontal move past the threshold", () => {
    const { machine, reveal } = harness();
    machine.down(touch(100, 300));
    expect(machine.move(touch(100 + AXIS_LOCK_PX + 1, 302))).toBe(true);
    expect(machine.phase()).toBe("claimed");
    // The pull is measured from the claim point, so the rows start at rest
    // rather than jumping the threshold's worth the instant they are claimed.
    expect(reveal).not.toHaveBeenCalled();
    machine.move(touch(100 + AXIS_LOCK_PX + 41, 302));
    expect(lastOffset(reveal)).toBe(40);
  });

  it("releases a predominantly vertical move, for the rest of the gesture", () => {
    const { machine, reveal } = harness();
    machine.down(touch(100, 300));
    expect(machine.move(touch(104, 300 + AXIS_LOCK_PX + 1))).toBe(false);
    expect(machine.phase()).toBe("idle");
    // The scroll is the compositor's now. A finger that turns sideways
    // mid-flick must not have the gesture taken back off it.
    expect(machine.move(touch(300, 320))).toBe(false);
    expect(machine.phase()).toBe("idle");
    expect(reveal).not.toHaveBeenCalled();
  });

  it("gives an exact diagonal to the scroll", () => {
    const { machine } = harness();
    const step = AXIS_LOCK_PX + 4;
    machine.down(touch(100, 300));
    machine.move(touch(100 + step, 300 + step));
    expect(machine.phase()).toBe("idle");
  });

  it("decides on whichever axis crosses first, not on the frame's total", () => {
    // A finger that has already travelled 40px down and only 12px across is
    // scrolling, however far past the threshold both numbers are.
    const { machine } = harness();
    machine.down(touch(100, 300));
    machine.move(touch(112, 340));
    expect(machine.phase()).toBe("idle");
  });

  it("claims leftward too, so a drag that comes back reveals smoothly", () => {
    const { machine, reveal } = harness();
    machine.down(touch(200, 300));
    machine.move(touch(200 - AXIS_LOCK_PX - 1, 300));
    expect(machine.phase()).toBe("claimed");
    machine.move(touch(200 - AXIS_LOCK_PX - 21, 300));
    expect(lastOffset(reveal)).toBe(0);
    machine.move(touch(200 - AXIS_LOCK_PX - 1 + 30, 300));
    expect(lastOffset(reveal)).toBe(30);
  });
});

describe("what the recognizer will not touch", () => {
  it("ignores a mouse — a horizontal drag on prose is a text selection", () => {
    const { machine, reveal } = harness();
    machine.down({
      pointerId: 1,
      pointerType: "mouse",
      clientX: 100,
      clientY: 300,
    });
    expect(machine.phase()).toBe("idle");
    expect(
      machine.move({
        pointerId: 1,
        pointerType: "mouse",
        clientX: 260,
        clientY: 300,
      }),
    ).toBe(false);
    expect(reveal).not.toHaveBeenCalled();
  });

  it("ignores moves from a pointer it is not watching", () => {
    const { machine } = harness();
    machine.down(touch(100, 300, 7));
    expect(machine.move(touch(300, 300, 9))).toBe(false);
    expect(machine.phase()).toBe("armed");
  });

  it("gives the gesture up when a second finger arrives", () => {
    const { machine, settle } = harness();
    machine.down(touch(100, 300, 1));
    machine.move(touch(140, 302, 1));
    expect(machine.phase()).toBe("claimed");
    machine.down(touch(220, 400, 2));
    expect(machine.phase()).toBe("idle");
    // A claimed pull interrupted by a pinch still has to come home.
    expect(settle).toHaveBeenCalledTimes(1);
    expect(machine.move(touch(300, 302, 1))).toBe(false);
  });
});

describe("ending the gesture", () => {
  it("settles a claimed pull on lift", () => {
    const { machine, settle } = harness();
    machine.down(touch(100, 300));
    machine.move(touch(160, 300));
    machine.up();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(machine.phase()).toBe("idle");
  });

  it("settles a claimed pull the compositor cancels", () => {
    const { machine, settle } = harness();
    machine.down(touch(100, 300));
    machine.move(touch(160, 300));
    machine.cancel();
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("settles nothing when the gesture was never claimed", () => {
    const { machine, settle } = harness();
    machine.down(touch(100, 300));
    machine.up();
    machine.down(touch(100, 300));
    machine.move(touch(100, 400));
    machine.cancel();
    expect(settle).not.toHaveBeenCalled();
  });

  it("re-arms cleanly for the next gesture", () => {
    const { machine, reveal } = harness();
    machine.down(touch(100, 300));
    machine.move(touch(100, 400));
    machine.up();
    machine.down(touch(100, 300));
    machine.move(touch(160, 300));
    expect(machine.phase()).toBe("claimed");
    machine.move(touch(180, 300));
    expect(lastOffset(reveal)).toBe(20);
  });
});
