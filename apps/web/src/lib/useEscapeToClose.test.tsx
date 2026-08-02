// @vitest-environment jsdom
//
// Escape-stack ordering. Mount order alone used to decide who gets the key,
// which lost the moment an *ambient* handler armed itself while an overlay
// was open: a message arriving behind the mini profile card registered
// MessageLog's "mark caught up" on top of the card, so the first Escape
// acked the tail and the card only closed on the second press.

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useEscapeToClose, type EscapeKind } from "./useEscapeToClose.js";

function Layer({
  onEscape,
  kind,
  enabled = true,
}: {
  onEscape: () => void;
  kind?: EscapeKind;
  enabled?: boolean;
}) {
  useEscapeToClose(onEscape, enabled, kind);
  return null;
}

function pressEscape() {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
  );
}

describe("useEscapeToClose", () => {
  it("gives the key to the last-mounted overlay, one press at a time", () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(
      <>
        <Layer onEscape={first} />
        <Layer onEscape={second} />
      </>,
    );

    pressEscape();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    view.rerender(<Layer onEscape={first} />);
    pressEscape();
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("claims the event so background listeners stand down", () => {
    render(<Layer onEscape={vi.fn()} />);
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("lets an overlay outrank an ambient handler registered later", () => {
    const card = vi.fn();
    const markCaughtUp = vi.fn();
    const view = render(
      <>
        <Layer onEscape={card} />
        <Layer onEscape={markCaughtUp} kind="ambient" enabled={false} />
      </>,
    );

    // A message arrives while the card is open: the ambient handler arms.
    view.rerender(
      <>
        <Layer onEscape={card} />
        <Layer onEscape={markCaughtUp} kind="ambient" enabled />
      </>,
    );

    pressEscape();
    expect(card).toHaveBeenCalledTimes(1);
    expect(markCaughtUp).not.toHaveBeenCalled();

    // Card closed → the next press reaches the ambient handler.
    view.rerender(<Layer onEscape={markCaughtUp} kind="ambient" enabled />);
    pressEscape();
    expect(markCaughtUp).toHaveBeenCalledTimes(1);
  });

  it("keeps LIFO among ambient handlers when no overlay is open", () => {
    const older = vi.fn();
    const newer = vi.fn();
    render(
      <>
        <Layer onEscape={older} kind="ambient" />
        <Layer onEscape={newer} kind="ambient" />
      </>,
    );

    pressEscape();
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
  });

  it("ignores a disabled registration entirely", () => {
    const handler = vi.fn();
    render(<Layer onEscape={handler} enabled={false} />);
    pressEscape();
    expect(handler).not.toHaveBeenCalled();
  });

  // The composer stack from WP-7: the slash popover, the toolbar's colour /
  // timer / link popover, and the eicon picker opened from inside it are three
  // overlays that can be open at once over the same message box. Each press
  // must peel exactly one of them off, innermost first.
  it("unwinds nested composer layers one press at a time", () => {
    const slashPopover = vi.fn();
    const toolbarPopover = vi.fn();
    const eiconPicker = vi.fn();
    const view = render(
      <>
        <Layer onEscape={slashPopover} />
        <Layer onEscape={toolbarPopover} />
        <Layer onEscape={eiconPicker} />
      </>,
    );

    pressEscape();
    expect(eiconPicker).toHaveBeenCalledTimes(1);
    expect(toolbarPopover).not.toHaveBeenCalled();
    expect(slashPopover).not.toHaveBeenCalled();

    view.rerender(
      <>
        <Layer onEscape={slashPopover} />
        <Layer onEscape={toolbarPopover} />
      </>,
    );
    pressEscape();
    expect(toolbarPopover).toHaveBeenCalledTimes(1);
    expect(slashPopover).not.toHaveBeenCalled();

    view.rerender(<Layer onEscape={slashPopover} />);
    pressEscape();
    expect(slashPopover).toHaveBeenCalledTimes(1);
  });

  // Handlers are allowed not to close (the Ad Center's dirty-draft warning,
  // the private note's collapse-to-peek): the entry stays on the stack and
  // still owns the next press — it must not fall through to what is behind.
  it("keeps the key when a handler collapses instead of closing", () => {
    const behind = vi.fn();
    const warnThenClose = vi.fn();
    render(
      <>
        <Layer onEscape={behind} />
        <Layer onEscape={warnThenClose} />
      </>,
    );

    pressEscape();
    pressEscape();
    expect(warnThenClose).toHaveBeenCalledTimes(2);
    expect(behind).not.toHaveBeenCalled();
  });
});
