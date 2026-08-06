// @vitest-environment jsdom
//
// Long-press action sheets end to end through React (MP2 §1, #376): a hold on
// a claimed element opens the same menu the right-click opens, as a bottom
// sheet on the phone tier, and a hover-capable pointer sees none of it.
//
// The eicon menu is the target under test because it is the one that is
// mounted once at the shell and opened from a store — so a test can press the
// eicon and assert on the menu without a route, a socket, or a member list.
// What is being checked is the wiring, not the menu: the items are the same
// object graph in both shapes, so "the sheet has the same items as the
// popover" is a real assertion about the shared surface.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { RichText } from "./RichText.js";
import { EiconContextMenu } from "./EiconContextMenu.js";
import { LONG_PRESS_MS, LONG_PRESS_SLOP } from "../../lib/useLongPress.js";
import {
  useSessionsStore,
  type IdentitySession,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { useEiconMenuStore } from "../../stores/eicon-menu.js";
import { setWindowWidth, stubNoHover } from "../../test-support/dom.js";

vi.mock("../../gateway/socket.js", () => ({
  gateway: { cmd: vi.fn().mockResolvedValue({ ok: true }) },
}));

const IDENTITY = "id1";
const EICON = "tearsofjoy";

function seed(): void {
  useSessionsStore.setState({
    sessions: {
      [IDENTITY]: {
        identityId: IDENTITY,
        character: "Me",
        prefs: { ...PREFS_DEFAULTS, eiconDisplay: "inline" },
      } as unknown as IdentitySession,
    },
  });
  useUiStore.setState({ activeIdentityId: IDENTITY });
}

// `stubNoHover` supplies the capability the recognizer is gated on: jsdom has
// no matchMedia at all, which is the desktop answer, so the touch cases have
// to install one.

function renderEicon() {
  return render(
    <>
      {/* A focusable neighbour, so "focus goes back where it came from" has
          somewhere to go back to. */}
      <button type="button">Opener</button>
      <RichText bbcode={`[eicon]${EICON}[/eicon]`} />
      <EiconContextMenu />
    </>,
  );
}

function eicon(): HTMLElement {
  return screen.getByRole("img", { name: EICON });
}

/** One hold: down, the threshold elapses, up. */
function press(
  element: HTMLElement,
  { x = 120, y = 240 }: { x?: number; y?: number } = {},
): void {
  fireEvent.pointerDown(element, {
    pointerId: 1,
    pointerType: "touch",
    clientX: x,
    clientY: y,
  });
  act(() => {
    vi.advanceTimersByTime(LONG_PRESS_MS);
  });
  fireEvent.pointerUp(element, { pointerId: 1, pointerType: "touch" });
}

/** A tap: what the ✕ and the backdrop get, and — the part that matters here
 * — with the `pointerdown` of its own that tells it apart from the
 * compatibility click a press leaves behind. */
function tap(element: Element): void {
  fireEvent.pointerDown(element, { pointerId: 2, pointerType: "touch" });
  fireEvent.pointerUp(element, { pointerId: 2, pointerType: "touch" });
  fireEvent.click(element);
}

/** The labels of the menu's items, in order — the thing that has to be the
 * same whichever shape the menu took. */
function itemLabels(): string[] {
  return screen
    .getAllByRole("menuitem")
    .map((item) => item.textContent?.trim() ?? "");
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  seed();
  setWindowWidth(1024);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  act(() => {
    useEiconMenuStore.getState().close();
  });
});

describe("on a phone-sized touchscreen", () => {
  beforeEach(() => {
    stubNoHover(true);
    setWindowWidth(390);
  });

  it("opens the menu as a bottom sheet, with the popover's items", () => {
    // The reference: what the right-click opens on a desktop.
    stubNoHover(false);
    setWindowWidth(1024);
    const desktop = renderEicon();
    fireEvent.contextMenu(eicon(), { clientX: 10, clientY: 10 });
    expect(screen.getByRole("menu", { name: `${EICON} eicon menu` }));
    const expected = itemLabels();
    expect(expected).toEqual(["Favourite", "Block", "Copy name"]);
    desktop.unmount();
    act(() => {
      useEiconMenuStore.getState().close();
    });

    stubNoHover(true);
    setWindowWidth(390);
    renderEicon();
    // Nothing is open until the hold completes.
    fireEvent.pointerDown(eicon(), { pointerId: 1, pointerType: "touch" });
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });

    const sheet = screen.getByRole("dialog", { name: `${EICON} eicon menu` });
    expect(sheet).toHaveAttribute("aria-modal", "true");
    // It names its target and offers a way out, which the popover does not
    // need because tapping beside it is enough.
    expect(sheet).toHaveTextContent(EICON);
    expect(
      screen.getByRole("button", { name: `Close ${EICON} eicon menu` }),
    ).toBeInTheDocument();
    expect(itemLabels()).toEqual(expected);
  });

  it("closes on Escape, on the backdrop, and on the ✕", () => {
    renderEicon();
    press(eicon());
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    // The backdrop: the sliver of conversation left showing beside the sheet.
    press(eicon());
    const backdrop = screen.getByRole("dialog").previousElementSibling;
    expect(backdrop).not.toBeNull();
    tap(backdrop!);
    expect(screen.queryByRole("dialog")).toBeNull();

    // The ✕ — and it has to survive the press's own ghost-click window, which
    // is still open: the sheet rose under the thumb that opened it.
    press(eicon());
    tap(screen.getByRole("button", { name: `Close ${EICON} eicon menu` }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("returns focus to whatever opened it", () => {
    renderEicon();
    // A press does not focus its target, so stand in for the keyboard user
    // who opened the same menu with the Menu key.
    const button = screen.getByRole("button", { name: "Opener" });
    button.focus();
    expect(document.activeElement).toBe(button);

    press(eicon());
    expect(document.activeElement).not.toBe(button);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(button);
  });

  it("does not open from a drag — that is a scroll", () => {
    renderEicon();
    fireEvent.pointerDown(eicon(), {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(eicon(), {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 100 + LONG_PRESS_SLOP + 5,
    });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens one menu when Android also synthesizes a contextmenu", () => {
    renderEicon();
    const opened = vi.spyOn(useEiconMenuStore.getState(), "open");
    press(eicon());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(opened).toHaveBeenCalledTimes(1);

    // Android's duplicate, arriving on the element we just claimed.
    const duplicate = fireEvent.contextMenu(eicon(), {
      clientX: 500,
      clientY: 500,
    });
    // Swallowed before the element's own handler saw it: no second open, and
    // therefore no second menu keyed to a different point.
    expect(duplicate).toBe(false);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
});

describe("on a coarse pointer above the phone tier", () => {
  it("opens the anchored popover at the press point, not a sheet", () => {
    stubNoHover(true);
    setWindowWidth(1024);
    renderEicon();
    press(eicon(), { x: 300, y: 400 });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("menu", { name: `${EICON} eicon menu` }),
    ).toBeInTheDocument();
  });
});

describe("where the pointer can hover", () => {
  beforeEach(() => {
    stubNoHover(false);
    setWindowWidth(1024);
  });

  it("attaches nothing — a long left-press is a text selection", () => {
    renderEicon();
    expect(eicon()).not.toHaveAttribute("data-eb-press");

    press(eicon());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("still opens the menu from a right-click", () => {
    renderEicon();
    fireEvent.contextMenu(eicon(), { clientX: 10, clientY: 10 });
    expect(
      screen.getByRole("menu", { name: `${EICON} eicon menu` }),
    ).toBeInTheDocument();
  });
});
