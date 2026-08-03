// The remembered-heights store (#460): what it hands back, and — the part that
// actually bit — what it must NOT throw away.

import { beforeEach, describe, expect, it } from "vitest";
import type { VirtualItem } from "@tanstack/react-virtual";
import {
  measuredRows,
  noteLogWidth,
  rememberMeasuredRows,
  resetMeasuredRows,
} from "./row-measurements.js";

const SIG = "m|cozy|false|false|time";

function snapshot(keys: string[]): VirtualItem[] {
  return keys.map((key, index) => ({
    index,
    key,
    start: index * 100,
    size: 100,
    end: index * 100 + 100,
    lane: 0,
  }));
}

describe("row measurements", () => {
  beforeEach(() => {
    resetMeasuredRows();
    noteLogWidth(800);
  });

  it("hands a conversation's snapshot back on the next visit", () => {
    rememberMeasuredRows("a", SIG, snapshot(["m:1", "m:2"]));
    expect(measuredRows("a", SIG).map((item) => item.key)).toEqual([
      "m:1",
      "m:2",
    ]);
  });

  it("has nothing for a conversation it has never seen", () => {
    rememberMeasuredRows("a", SIG, snapshot(["m:1"]));
    expect(measuredRows("b", SIG)).toEqual([]);
  });

  it("drops everything when the type or density prefs change", () => {
    rememberMeasuredRows("a", SIG, snapshot(["m:1"]));
    expect(measuredRows("a", "l|cozy|false|false|time")).toEqual([]);
    expect(measuredRows("a", SIG)).toEqual([]);
  });

  // The unmounting log files its heights after the incoming one has read the
  // store, so a pref change mid-visit arrives in that order: read under the new
  // layout, then a save carrying the old one.
  it("drops a save measured under a layout the app has already left", () => {
    const grown = "l|cozy|false|false|time";
    rememberMeasuredRows("a", SIG, snapshot(["m:1"]));
    expect(measuredRows("a", grown)).toEqual([]);
    rememberMeasuredRows("a", SIG, snapshot(["m:1"]));
    expect(measuredRows("a", grown)).toEqual([]);
  });

  it("drops everything when the log's width changes", () => {
    rememberMeasuredRows("a", SIG, snapshot(["m:1"]));
    noteLogWidth(640);
    expect(measuredRows("a", SIG)).toEqual([]);
  });

  // The zero is what a log reports while it is unmounting, and it arrives
  // between the outgoing conversation saving its heights and the incoming one
  // asking for them — so treating it as a resize emptied the store on every
  // single switch, and the feature silently did nothing.
  it("ignores a zero width from a log that is not laid out", () => {
    rememberMeasuredRows("a", SIG, snapshot(["m:1"]));
    noteLogWidth(0);
    expect(measuredRows("a", SIG).map((item) => item.key)).toEqual(["m:1"]);
  });

  it("keeps a bounded number of conversations, evicting the least recent", () => {
    for (let i = 0; i < 20; i += 1) {
      rememberMeasuredRows(`c${String(i)}`, SIG, snapshot([`m:${String(i)}`]));
    }
    expect(measuredRows("c0", SIG)).toEqual([]);
    expect(measuredRows("c19", SIG)).toHaveLength(1);
  });

  it("keeps a conversation alive by visiting it", () => {
    rememberMeasuredRows("keep", SIG, snapshot(["m:1"]));
    for (let i = 0; i < 20; i += 1) {
      rememberMeasuredRows(`c${String(i)}`, SIG, snapshot([`m:${String(i)}`]));
      // Reading is a visit: it moves the entry back to the front of the queue.
      expect(measuredRows("keep", SIG)).toHaveLength(1);
    }
  });

  it("ignores an empty snapshot rather than forgetting the good one", () => {
    rememberMeasuredRows("a", SIG, snapshot(["m:1"]));
    rememberMeasuredRows("a", SIG, []);
    expect(measuredRows("a", SIG)).toHaveLength(1);
  });
});

// The phone stack (#375) moves the log between two very different widths, and
// it does so without a conversation switch — so the store meets width changes
// in an order it never saw on the desktop grid. These are the two sequences
// that matter.
describe("row measurements across a pane switch (#375)", () => {
  beforeEach(() => {
    resetMeasuredRows();
  });

  // wide → phone with a conversation open: the sidebar leaves and the log
  // takes the whole viewport. Every remembered height was measured against the
  // old wrap width and is now wrong — the tier flip must invalidate them, or
  // the log paints its rows on top of one another (#460).
  it("drops heights when a tier flip widens the log", () => {
    noteLogWidth(1000); // desktop: viewport minus rail, sidebar, members
    rememberMeasuredRows("a", SIG, snapshot(["m:1", "m:2"]));

    noteLogWidth(390); // phone: the conversation pane is the whole width
    expect(measuredRows("a", SIG)).toEqual([]);
  });

  // Leaving the conversation pane unmounts the log; nothing else on the phone
  // stack owns a log, so the store must not be disturbed by the teardown —
  // the zero-width guard is what keeps the heights for the way back.
  it("keeps them across a back-and-return that never changes the width", () => {
    noteLogWidth(390);
    rememberMeasuredRows("a", SIG, snapshot(["m:1", "m:2"]));

    // Back to the list: the unmounting log reports its no-longer-laid-out box.
    noteLogWidth(0);
    // …and the same conversation is re-opened at the same phone width.
    noteLogWidth(390);
    expect(measuredRows("a", SIG).map((item) => item.key)).toEqual([
      "m:1",
      "m:2",
    ]);
  });
});
