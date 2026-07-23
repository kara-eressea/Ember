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
  dividerCursorAfter,
  newMessagesBarHidden,
  type NewMessagesBarState,
} from "./NewMessagesBar.js";
import { buildRows } from "./log-rows.js";
import type { MessageDto } from "@emberchat/protocol";

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

// The bar is presentational (#373): MessageLog owns Escape/mark-caught-up, so
// these cover only rendering and the click-to-jump affordance. Escape clearing
// the divider is exercised end-to-end in e2e/messagelog-tail.spec.ts, against
// real gateway state and scroll geometry.
describe("NewMessagesBar (#363)", () => {
  it("shows the unread count in plain language when unreads are off screen", () => {
    render(<NewMessagesBar count={5} hidden={false} onJump={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /5 new messages since you left/ }),
    ).toBeTruthy();
  });

  it("uses the singular for a single unread message", () => {
    render(<NewMessagesBar count={1} hidden={false} onJump={vi.fn()} />);
    expect(screen.getByText("1 new message since you left")).toBeTruthy();
  });

  it("renders nothing when the unreads are already visible on screen", () => {
    render(<NewMessagesBar count={5} hidden={true} onJump={vi.fn()} />);
    expect(screen.queryByTestId("new-messages-bar")).toBeNull();
  });

  it("renders nothing when there are no unread messages", () => {
    render(<NewMessagesBar count={0} hidden={false} onJump={vi.fn()} />);
    expect(screen.queryByTestId("new-messages-bar")).toBeNull();
  });

  it("jumps to the first unread on click", () => {
    const onJump = vi.fn();
    render(<NewMessagesBar count={3} hidden={false} onJump={onJump} />);
    fireEvent.click(screen.getByTestId("new-messages-bar"));
    expect(onJump).toHaveBeenCalledTimes(1);
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

describe("dividerCursorAfter — Esc clears the in-log divider (#363 follow-up)", () => {
  const msgs: MessageDto[] = [
    {
      id: 1,
      senderCharacter: "Nyx Firemane",
      kind: "msg",
      bbcode: "read one",
      sentByUs: false,
      mention: false,
      createdAt: "2026-07-23T12:00:00.000Z",
    },
    {
      id: 2,
      senderCharacter: "Nyx Firemane",
      kind: "msg",
      bbcode: "new one",
      sentByUs: false,
      mention: false,
      createdAt: "2026-07-23T12:01:00.000Z",
    },
  ];
  const cursor = 1; // read up to message 1; message 2 is "new".

  const hasDivider = (c: number | null) =>
    buildRows(msgs, c).some((row) => row.type === "new");

  it("shows the divider before any catch-up gesture", () => {
    expect(hasDivider(cursor)).toBe(true);
  });

  it("Esc (dismiss) clears the cursor, removing the divider — fully caught up", () => {
    const after = dividerCursorAfter("dismiss", cursor);
    expect(after).toBeNull();
    expect(hasDivider(after)).toBe(false);
  });

  it("a bar-click jump keeps the cursor and the divider (reading up toward it)", () => {
    const after = dividerCursorAfter("jumpToUnread", cursor);
    expect(after).toBe(cursor);
    expect(hasDivider(after)).toBe(true);
  });
});
