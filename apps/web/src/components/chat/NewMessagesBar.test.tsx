// @vitest-environment jsdom
//
// The Discord-style "new messages" bar (#363, reworked in #495): it appears
// with the unread count and the time the backlog starts at when the first
// unread is off screen, stays hidden when the unreads are already visible or
// there are none, jumps from anywhere on the bar, and carries one "Mark as
// read" button that must never reach the jump.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  NewMessagesBar,
  dividerCursorAfter,
  newMessagesBarHidden,
  unreadSinceLabel,
  type NewMessagesBarState,
} from "./NewMessagesBar.js";
import { buildRows } from "./log-rows.js";
import type { MessageDto } from "@emberchat/protocol";
import type { TimeFormat } from "../../lib/time.js";

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
// these cover only rendering and the two affordances. Escape clearing the
// divider is exercised end-to-end in e2e/messagelog-tail.spec.ts, against real
// gateway state and scroll geometry.
describe("NewMessagesBar (#363, #495)", () => {
  it("names the count and when the backlog starts", () => {
    render(
      <NewMessagesBar
        count={5}
        since="14:32"
        hidden={false}
        onJump={vi.fn()}
        onMarkRead={vi.fn()}
      />,
    );
    expect(screen.getByText("5 new messages since 14:32")).toBeTruthy();
  });

  it("uses the singular for a single unread message", () => {
    render(
      <NewMessagesBar
        count={1}
        since="14:32"
        hidden={false}
        onJump={vi.fn()}
        onMarkRead={vi.fn()}
      />,
    );
    expect(screen.getByText("1 new message since 14:32")).toBeTruthy();
  });

  it("falls back to the plain wording when no timestamp is known", () => {
    render(
      <NewMessagesBar
        count={3}
        since={undefined}
        hidden={false}
        onJump={vi.fn()}
        onMarkRead={vi.fn()}
      />,
    );
    expect(screen.getByText("3 new messages since you left")).toBeTruthy();
  });

  it("renders nothing when the unreads are already visible on screen", () => {
    render(
      <NewMessagesBar
        count={5}
        since="14:32"
        hidden={true}
        onJump={vi.fn()}
        onMarkRead={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("new-messages-bar")).toBeNull();
  });

  it("renders nothing when there are no unread messages", () => {
    render(
      <NewMessagesBar
        count={0}
        since="14:32"
        hidden={false}
        onJump={vi.fn()}
        onMarkRead={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("new-messages-bar")).toBeNull();
  });

  it("jumps to the first unread from the bar itself", () => {
    const onJump = vi.fn();
    render(
      <NewMessagesBar
        count={3}
        since="14:32"
        hidden={false}
        onJump={onJump}
        onMarkRead={vi.fn()}
      />,
    );
    // The bar's whole width is the jump: the count text is INSIDE the button,
    // so a press on the sentence is a press on the target.
    const jump = screen.getByTestId("new-messages-jump");
    expect(jump.textContent).toBe("3 new messages since 14:32");
    fireEvent.click(jump);
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("marks read from its button, and that press never reaches the jump", () => {
    const onJump = vi.fn();
    const onMarkRead = vi.fn();
    render(
      <NewMessagesBar
        count={3}
        since="14:32"
        hidden={false}
        onJump={onJump}
        onMarkRead={onMarkRead}
      />,
    );
    // Bubbling, as a real press does: the guard is the point of the test.
    fireEvent.click(
      screen.getByRole("button", { name: /Mark these messages/ }),
    );
    expect(onMarkRead).toHaveBeenCalledTimes(1);
    expect(onJump).not.toHaveBeenCalled();
  });

  it("offers exactly two targets — the jump and the one exception to it", () => {
    render(
      <NewMessagesBar
        count={3}
        since="14:32"
        hidden={false}
        onJump={vi.fn()}
        onMarkRead={vi.fn()}
      />,
    );
    const bar = screen.getByTestId("new-messages-bar");
    // Siblings, not nested: a button inside a button is both invalid HTML and
    // the shape where the small target can fire the big one.
    expect(bar.querySelectorAll("button")).toHaveLength(2);
    expect(bar.querySelector("button button")).toBeNull();
  });

  it("never writes the jump verb or the Escape hint out", () => {
    render(
      <NewMessagesBar
        count={3}
        since="14:32"
        hidden={false}
        onJump={vi.fn()}
        onMarkRead={vi.fn()}
      />,
    );
    const bar = screen.getByTestId("new-messages-bar");
    expect(bar.textContent).toBe("3 new messages since 14:32Mark as read");
    expect(bar.textContent).not.toMatch(/jump|esc/iu);
  });

  it("labels both targets the way a person would say them", () => {
    render(
      <NewMessagesBar
        count={5}
        since="14:32"
        hidden={false}
        onJump={vi.fn()}
        onMarkRead={vi.fn()}
      />,
    );
    // Spoken, the sentence alone does not say what pressing the bar does.
    expect(
      screen.getByRole("button", {
        name: "Go to the first of 5 new messages since 14:32",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Mark these messages as read" }),
    ).toBeTruthy();
  });

  it("labels a single unread in the singular too", () => {
    render(
      <NewMessagesBar
        count={1}
        since="14:32"
        hidden={false}
        onJump={vi.fn()}
        onMarkRead={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Go to the new message from 14:32" }),
    ).toBeTruthy();
  });
});

// Read as text rather than imported: vitest stubs CSS imports out, and no
// jsdom render can measure a stylesheet's phone tier. The E2E touch-target
// sweep measures the painted result; this asserts the rule that produces it
// still names both halves of the bar.
describe("phone touch targets (MP2 §3)", () => {
  const chatCss = readFileSync(
    resolve("src/components/chat/chat.module.css"),
    "utf8",
  );

  it("gives both of the bar's buttons the 44px floor on phone", () => {
    const rule =
      /:root\[data-layout="phone"\][^{]*\.newMessagesJump[^{]*\.newMessagesMarkRead[^{]*\{[^}]*min-height:\s*var\(--eb-touch-target\)/u;
    expect(chatCss).toMatch(rule);
  });

  it("keeps the strip itself free of padding and gaps a press could fall into", () => {
    const bar = /\.newMessagesBar \{([^}]*)\}/u.exec(chatCss)?.[1] ?? "";
    expect(bar).not.toMatch(/^\s*(padding|gap)/mu);
  });
});

describe("unreadSinceLabel (#495)", () => {
  const at = (iso: string, format: Partial<TimeFormat> = {}) =>
    unreadSinceLabel(
      iso,
      { timestampFormat: "time", use24HourClock: true, ...format },
      new Date("2026-08-04T20:00:00"),
    );

  it("formats the oldest unread's clock time the way the log does", () => {
    expect(at("2026-08-04T14:32:09")).toBe("14:32");
    expect(at("2026-08-04T14:32:09", { use24HourClock: false })).toBe("02:32");
    expect(at("2026-08-04T14:32:09", { timestampFormat: "seconds" })).toBe(
      "14:32:09",
    );
  });

  it("still names a time when the log's own timestamps are off", () => {
    // The bar is one sentence and needs its anchor; the pref governs the
    // per-line stamps, not this.
    expect(at("2026-08-04T14:32:09", { timestampFormat: "off" })).toBe("14:32");
  });

  it("carries a date for a backlog that started on an earlier day", () => {
    // "since 23:40" alone would read as tonight.
    expect(at("2026-08-02T23:40:00")).toMatch(/23:40$/u);
    expect(at("2026-08-02T23:40:00")).not.toBe("23:40");
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
