// @vitest-environment jsdom
//
// Dialog focus containment (WP-7). Before this hook every modal only focused
// itself on open: Tab walked straight out into the app behind it, and closing
// dropped focus on the body instead of the control that opened the dialog.

import { describe, expect, it } from "vitest";
import { useRef, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useFocusTrap } from "./useFocusTrap.js";

function Dialog({ initialInput = false }: { initialInput?: boolean }) {
  const windowRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(windowRef, initialInput ? inputRef : undefined);
  return (
    <div role="dialog" aria-modal="true" tabIndex={-1} ref={windowRef}>
      <button type="button">First</button>
      <input ref={inputRef} aria-label="Middle" />
      <button type="button">Last</button>
    </div>
  );
}

/** The app behind the dialog, with its own tabbable control. */
function App({ initialInput = false }: { initialInput?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open dialog
      </button>
      <button type="button">Behind</button>
      {open && <Dialog initialInput={initialInput} />}
    </>
  );
}

const first = () => screen.getByRole("button", { name: "First" });
const last = () => screen.getByRole("button", { name: "Last" });

describe("useFocusTrap", () => {
  it("wraps Tab from the last focusable back to the first", async () => {
    const user = userEvent.setup();
    render(<Dialog />);

    last().focus();
    await user.tab();

    expect(first()).toHaveFocus();
  });

  it("wraps Shift+Tab from the first focusable to the last", async () => {
    const user = userEvent.setup();
    render(<Dialog />);

    first().focus();
    await user.tab({ shift: true });

    expect(last()).toHaveFocus();
  });

  it("focuses the dialog on open and hands focus back to its opener on close", async () => {
    const user = userEvent.setup();

    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            Open dialog
          </button>
          {open && (
            <>
              <Dialog />
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                }}
              >
                Close from outside
              </button>
            </>
          )}
        </>
      );
    }
    render(<Host />);

    const opener = screen.getByRole("button", { name: "Open dialog" });
    await user.click(opener);
    expect(screen.getByRole("dialog")).toHaveFocus();

    await user.click(
      screen.getByRole("button", { name: "Close from outside" }),
    );
    expect(opener).toHaveFocus();
  });

  it("puts initial focus on the named element when one is given", async () => {
    const user = userEvent.setup();
    render(<App initialInput />);

    await user.click(screen.getByRole("button", { name: "Open dialog" }));

    expect(screen.getByRole("textbox", { name: "Middle" })).toHaveFocus();
  });
});
