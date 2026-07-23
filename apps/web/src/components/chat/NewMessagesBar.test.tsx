// @vitest-environment jsdom
//
// The Discord-style "new messages" bar (#363): it appears with the unread
// count when the first unread is off screen, stays hidden when the unreads are
// already visible or there are none, jumps on click, and — routed through the
// shared Escape stack — dismisses on Escape while a later-mounted overlay
// closes first.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NewMessagesBar } from "./NewMessagesBar.js";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";

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
