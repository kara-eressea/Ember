// @vitest-environment jsdom
//
// Clearing a rating races the note field's blur-save: the pointer that
// presses "Clear rating" blurs the textarea first, and an unguarded blur
// would PUT the rating straight back after the DELETE. `clearingRef` is
// armed on pointerdown — before the focus change — so the blur stands down.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RatingDto } from "@emberchat/protocol";
import { RateEditor } from "./RateEditor.js";
import { useRatingsStore } from "../../stores/ratings.js";

const putRating = vi.hoisted(() => vi.fn());
const deleteRating = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api.js", () => ({
  api: {
    putRating,
    deleteRating,
    getRatings: vi.fn().mockResolvedValue({ ratings: [] }),
  },
}));

const EXISTING: RatingDto = {
  character: "Sorrel",
  score: 4,
  note: "good scene partner",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const anchor = () =>
  ({
    top: 100,
    left: 100,
    bottom: 130,
    right: 200,
    width: 100,
    height: 30,
  }) as DOMRect;

function renderEditor(onClose = vi.fn()) {
  render(<RateEditor character="Sorrel" anchor={anchor()} onClose={onClose} />);
  return onClose;
}

const note = () => screen.getByLabelText("Private note");
const rated = () => useRatingsStore.getState().byName["sorrel"];

beforeEach(() => {
  useRatingsStore.setState({ loaded: true, byName: { sorrel: EXISTING } });
  putRating.mockImplementation(
    (character: string, score: number, text?: string) =>
      Promise.resolve({
        rating: { character, score, note: text, updatedAt: EXISTING.updatedAt },
      }),
  );
  deleteRating.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("RateEditor clear flow (M11)", () => {
  it("clears without the note's blur-save resurrecting the rating", async () => {
    const user = userEvent.setup();
    const onClose = renderEditor();

    // Edit the note, then reach straight for Clear — the blur fires as part
    // of that same press.
    await user.click(note());
    await user.type(note(), " and fast");
    await user.click(screen.getByRole("button", { name: "Clear rating" }));

    expect(deleteRating).toHaveBeenCalledWith("Sorrel");
    expect(putRating).not.toHaveBeenCalled();
    expect(rated()).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });

  it("still saves the note on an ordinary blur", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(note());
    await user.type(note(), "!");
    await user.tab();

    expect(putRating).toHaveBeenCalledWith("Sorrel", 4, "good scene partner!");
    expect(deleteRating).not.toHaveBeenCalled();
  });

  it("does not save an empty rating on blur", async () => {
    // Unrated character: no score yet, so a stray blur must not write a 0.
    useRatingsStore.setState({ loaded: true, byName: {} });
    const user = userEvent.setup();
    renderEditor();

    await user.click(note());
    await user.type(note(), "jotting");
    await user.tab();

    expect(putRating).not.toHaveBeenCalled();
    // Nothing to clear either — the Clear row only exists for a saved rating.
    expect(
      screen.queryByRole("button", { name: "Clear rating" }),
    ).not.toBeInTheDocument();
  });

  it("saves on a star pick and reports it", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole("radio", { name: "5 stars" }));

    expect(putRating).toHaveBeenCalledWith("Sorrel", 5, "good scene partner");
    expect(await screen.findByText("Saved ✓")).toBeInTheDocument();
    expect(rated()?.score).toBe(5);
  });
});

// The editor opens on an ad row inside the virtualized log, and the log
// auto-scrolls behind it as messages arrive (#284). Placed once from the rect
// captured at click time, it drifted away from its own trigger and pointed at
// an unrelated message — and stayed on screen after the virtualizer unmounted
// the row entirely. MiniProfileCard solved this; this is the same machinery
// (#560).
describe("RateEditor follows its trigger", () => {
  /** A trigger whose box the test can move, the way scrolling would. */
  function trigger(box: { top: number; left: number }) {
    const button = document.createElement("button");
    document.body.append(button);
    let current = box;
    button.getBoundingClientRect = () => ({
      top: current.top,
      left: current.left,
      bottom: current.top + 30,
      right: current.left + 100,
      width: 100,
      height: 30,
      x: current.left,
      y: current.top,
      toJSON: () => ({}),
    });
    const moveTo = (next: { top: number; left: number }) => {
      current = next;
    };
    return { button, moveTo };
  }

  /** One scroll frame: the capture-phase listener, then its rAF. */
  async function scrollFrame() {
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
  }

  const editor = () => screen.getByRole("dialog", { name: "Rate Sorrel" });

  it("re-measures its trigger as the log scrolls under it", async () => {
    const { button, moveTo } = trigger({ top: 400, left: 100 });
    render(
      <RateEditor
        character="Sorrel"
        anchor={button.getBoundingClientRect()}
        anchorElement={button}
        onClose={vi.fn()}
      />,
    );
    const opened = editor().style.top;

    // A message arrives and the bottom-stick controller moves the row up.
    moveTo({ top: 240, left: 100 });
    await scrollFrame();

    expect(editor().style.top).not.toBe(opened);
    // 30px tall trigger + the shared 6px popover gap.
    expect(editor().style.top).toBe("276px");
    expect(editor().style.left).toBe("100px");
  });

  it("closes rather than float on when the row is virtualized away", async () => {
    const { button } = trigger({ top: 400, left: 100 });
    const onClose = vi.fn();
    render(
      <RateEditor
        character="Sorrel"
        anchor={button.getBoundingClientRect()}
        anchorElement={button}
        onClose={onClose}
      />,
    );
    expect(onClose).not.toHaveBeenCalled();

    button.remove(); // scrolled out of the virtualizer's window
    await scrollFrame();

    expect(onClose).toHaveBeenCalled();
  });

  it("still places from the given rect when no trigger was handed over", async () => {
    render(
      <RateEditor character="Sorrel" anchor={anchor()} onClose={vi.fn()} />,
    );
    // The mini card's docked placement has no element to follow, and a scroll
    // must not close an editor that never had a trigger to lose.
    await scrollFrame();
    expect(editor().style.top).toBe("136px");
  });
});
