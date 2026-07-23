// @vitest-environment jsdom
//
// The Discord-style "new messages" bar (#363): it appears with the unread
// count when the first unread is off screen, stays hidden when the unreads are
// already visible or there are none, jumps on click, and — routed through the
// shared Escape stack — dismisses on Escape while a later-mounted overlay
// closes first.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  NewMessagesBar,
  newMessagesBarHidden,
  type NewMessagesBarState,
} from "./NewMessagesBar.js";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";

/** Parked at the live tail with off-screen unreads the user has not yet
 * acknowledged — the one state where the bar shows. */
const SHOWING: NewMessagesBarState = {
  count: 5,
  atBottom: true,
  firstUnreadOffscreen: true,
  acknowledged: false,
  detachedTail: false,
};

afterEach(cleanup);

function pressEscape() {
  fireEvent.keyDown(window, { key: "Escape" });
}

describe("NewMessagesBar (#363)", () => {
  it("shows the unread count in plain language when unreads are off screen", () => {
    render(
      <NewMessagesBar
        count={5}
        hidden={false}
        onJump={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /5 new messages since you left/ }),
    ).toBeTruthy();
  });

  it("uses the singular for a single unread message", () => {
    render(
      <NewMessagesBar
        count={1}
        hidden={false}
        onJump={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("1 new message since you left")).toBeTruthy();
  });

  it("renders nothing when the unreads are already visible on screen", () => {
    render(
      <NewMessagesBar
        count={5}
        hidden={true}
        onJump={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("new-messages-bar")).toBeNull();
  });

  it("renders nothing when there are no unread messages", () => {
    render(
      <NewMessagesBar
        count={0}
        hidden={false}
        onJump={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("new-messages-bar")).toBeNull();
  });

  it("jumps to the first unread on click", () => {
    const onJump = vi.fn();
    render(
      <NewMessagesBar
        count={3}
        hidden={false}
        onJump={onJump}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("new-messages-bar"));
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("dismisses (advancing the read cursor) on Escape", () => {
    const onDismiss = vi.fn();
    render(
      <NewMessagesBar
        count={3}
        hidden={false}
        onJump={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    pressEscape();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not claim Escape while hidden", () => {
    const onDismiss = vi.fn();
    render(
      <NewMessagesBar
        count={3}
        hidden={true}
        onJump={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    pressEscape();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("lets a later-mounted overlay handle Escape first (topmost wins)", () => {
    const onDismiss = vi.fn();
    const overlayEsc = vi.fn();

    // A modal mounted above the bar registers on the shared stack after it.
    function Overlay() {
      useEscapeToClose(overlayEsc);
      return null;
    }

    render(
      <>
        <NewMessagesBar
          count={3}
          hidden={false}
          onJump={vi.fn()}
          onDismiss={onDismiss}
        />
        <Overlay />
      </>,
    );

    // First Escape closes the topmost overlay only.
    pressEscape();
    expect(overlayEsc).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("newMessagesBarHidden (#363 follow-up)", () => {
  it("shows only while parked at the tail with off-screen unacknowledged unreads", () => {
    expect(newMessagesBarHidden(SHOWING)).toBe(false);
  });

  it("hides once the unreads are on screen or there are none", () => {
    expect(
      newMessagesBarHidden({ ...SHOWING, firstUnreadOffscreen: false }),
    ).toBe(true);
    expect(newMessagesBarHidden({ ...SHOWING, count: 0 })).toBe(true);
  });

  it("hides while scrolled up (Escape belongs to back-to-present there)", () => {
    expect(newMessagesBarHidden({ ...SHOWING, atBottom: false })).toBe(true);
  });

  it("does not re-show after the jump-up-then-return cycle", () => {
    // Shown at the tail…
    expect(newMessagesBarHidden(SHOWING)).toBe(false);
    // …click the bar → jump up (no longer at the tail) → hidden, and the click
    // marks it acknowledged.
    const jumpedUp = { ...SHOWING, atBottom: false, acknowledged: true };
    expect(newMessagesBarHidden(jumpedUp)).toBe(true);
    // …return to the tail via the pill: the tail-with-off-screen-unreads state
    // recurs, but acknowledged keeps the bar down — no loop.
    const returned = { ...SHOWING, acknowledged: true };
    expect(newMessagesBarHidden(returned)).toBe(true);
  });

  it("stays hidden in the detached history view", () => {
    expect(newMessagesBarHidden({ ...SHOWING, detachedTail: true })).toBe(true);
  });
});
