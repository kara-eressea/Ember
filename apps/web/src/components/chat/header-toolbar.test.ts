// The conversation toolbar's priority collapse (#375, MP1 spec §3), and the
// behaviour it inherited from the provisional HEADER_DENSE_MAX_WIDTH threshold
// it retires: the topic slot and the DM clock leave the row before it gets
// crowded, and the row never sheds anything while it still has room.

import { describe, expect, it } from "vitest";

import {
  collapsedHeaderControls,
  HEADER_COLLAPSE_STEPS,
  HEADER_CONTROL_ORDER,
  type HeaderControlId,
} from "./header-toolbar.js";

/** A DM header with everything it can have: a status, a partner whose clock
 * is known, and the three-chip cluster. The widest row the app renders. */
const DM: readonly HeaderControlId[] = [
  "topic",
  "clock",
  "pin",
  "mute",
  "ignore",
  "panel",
  "actions",
  "close",
];

/** A channel with a description, seen by a non-op. */
const CHANNEL: readonly HeaderControlId[] = ["topic", "pin", "mute", "members"];

/**
 * The row is not the window. The toolbar spans the chat column *and* the
 * right column (shell.module.css `.shell > header { grid-column: 3 / -1 }`),
 * so what it gets is the window minus the identity rail and the sidebar at
 * their default widths, minus its own 18/10 padding — the measurement is a
 * ResizeObserver contentRect. Both columns are drag-resizable and the rail
 * hides, which is the whole reason this decision moved from a window
 * threshold to a measurement; but at the defaults the two are comparable, and
 * that is what lets these cases be written in the old rule's own units.
 * Verified against Chromium: a 900px window gives this row 568 content pixels.
 */
function rowFor(windowWidth: number): number {
  return windowWidth - 60 - 244 - 28;
}

describe("collapsedHeaderControls", () => {
  it("collapses nothing while the row has room", () => {
    expect(collapsedHeaderControls(rowFor(940), DM)).toEqual([]);
    expect(collapsedHeaderControls(2000, DM)).toEqual([]);
  });

  it("folds in priority order, each width a superset of the wider one", () => {
    let previous = new Set<HeaderControlId>();
    for (let width = 700; width >= 0; width -= 20) {
      const collapsed = new Set(collapsedHeaderControls(width, DM));
      for (const id of previous) {
        expect(collapsed.has(id)).toBe(true);
      }
      previous = collapsed;
    }
    // Everything the row can shed, at the narrowest width there is.
    expect([...previous].sort()).toEqual([...DM].sort());
  });

  it("walks the steps in the documented order as the row shrinks", () => {
    expect(collapsedHeaderControls(450, DM)).toEqual([
      "topic",
      "clock",
      "pin",
      "mute",
    ]);
    expect(collapsedHeaderControls(380, DM)).toEqual([
      "topic",
      "clock",
      "pin",
      "mute",
      "ignore",
      "close",
    ]);
    expect(collapsedHeaderControls(310, DM)).toEqual([
      "topic",
      "clock",
      "pin",
      "mute",
      "ignore",
      "actions",
      "close",
    ]);
    // The two view toggles are the last to go, after everything else.
    expect(collapsedHeaderControls(280, DM)).toContain("panel");
  });

  it("leaves nothing but the inbox and search at the narrow end", () => {
    // Neither is a HeaderControlId at all — they cannot be collapsed, so
    // "everything else has folded" is the whole statement (spec §3).
    expect(collapsedHeaderControls(0, DM)).toEqual(
      HEADER_CONTROL_ORDER.filter((id) => DM.includes(id)),
    );
    expect(collapsedHeaderControls(0, CHANNEL)).toEqual(
      HEADER_CONTROL_ORDER.filter((id) => CHANNEL.includes(id)),
    );
  });

  it("lists the overflow in row order, not collapse order", () => {
    const collapsed = collapsedHeaderControls(0, DM);
    const indexes = collapsed.map((id) => HEADER_CONTROL_ORDER.indexOf(id));
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
  });

  it("never collapses a control the row does not have", () => {
    const bare: HeaderControlId[] = ["pin", "mute"];
    expect(collapsedHeaderControls(0, bare)).toEqual(["pin", "mute"]);
  });

  it("puts the topic and the clock in the first step, together", () => {
    expect(HEADER_COLLAPSE_STEPS[0]).toEqual(["topic", "clock"]);
  });
});

// What the retired `@media (max-width: 820px)` rule encoded, width for width:
// the topic and the clock step out before the row gets tight (the clock was
// costing the DM partner's name its last characters), and they are still
// there at 900px, where there was still room for them.
describe("the retired header-density threshold", () => {
  it("sheds the topic and the clock before the row is crowded", () => {
    expect(collapsedHeaderControls(rowFor(800), DM)).toEqual([
      "topic",
      "clock",
    ]);
    // …and they are the first two out, wherever the fold starts.
    expect(collapsedHeaderControls(rowFor(768), DM).slice(0, 2)).toEqual([
      "topic",
      "clock",
    ]);
  });

  it("keeps them where the old rule kept them, at 900", () => {
    expect(collapsedHeaderControls(rowFor(900), DM)).toEqual([]);
  });

  it("sheds nothing but those two across most of the compact tier", () => {
    for (const windowWidth of [800, 820, 860, 900, 940]) {
      const collapsed = collapsedHeaderControls(rowFor(windowWidth), DM);
      expect(collapsed.every((id) => id === "topic" || id === "clock")).toBe(
        true,
      );
    }
    // At the very bottom of compact the busiest row does start folding chips
    // — which is what the tier table asks of `compact` in the first place.
    expect(collapsedHeaderControls(rowFor(768), DM)).toContain("pin");
  });

  it("lets a channel keep its description further down than a DM does", () => {
    // The old rule was one number for both rows, so it had to be tuned to the
    // busier one. A channel header carries three fewer chips and no clock, and
    // measuring says so: its description survives the whole compact tier.
    for (const windowWidth of [768, 800, 820, 900, 940]) {
      expect(collapsedHeaderControls(rowFor(windowWidth), CHANNEL)).toEqual([]);
    }
  });

  it("still drops the clock first when a DM has no status to show", () => {
    const clockOnly = DM.filter((id) => id !== "topic");
    expect(collapsedHeaderControls(rowFor(800), clockOnly)).toEqual(["clock"]);
  });
});
