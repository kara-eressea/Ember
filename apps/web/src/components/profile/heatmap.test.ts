// Heatmap bucketing helpers: intensity ramp, hour labels, busiest cell.

import { describe, expect, it } from "vitest";
import { busiestSlot, cellLevel, hourRangeLabel } from "./heatmap.js";

describe("cellLevel", () => {
  it("keeps empty cells empty and the peak at full strength", () => {
    expect(cellLevel(0, 40)).toBe(0);
    expect(cellLevel(40, 40)).toBe(4);
  });

  it("square-roots the ramp so a single busy hour doesn't flatten the rest", () => {
    // Linear would put 4/64 at level 1; the sqrt ramp lifts it clear of empty.
    expect(cellLevel(4, 64)).toBe(1);
    expect(cellLevel(16, 64)).toBe(2);
    expect(cellLevel(36, 64)).toBe(3);
  });

  it("never dims a real message down to the empty look", () => {
    expect(cellLevel(1, 10_000)).toBe(1);
  });

  it("is defensive about an all-zero grid", () => {
    expect(cellLevel(0, 0)).toBe(0);
  });
});

describe("hourRangeLabel", () => {
  it("pads and wraps midnight", () => {
    expect(hourRangeLabel(9)).toBe("09:00–10:00");
    expect(hourRangeLabel(23)).toBe("23:00–00:00");
  });
});

describe("busiestSlot", () => {
  const empty = () =>
    Array.from({ length: 7 }, () => Array<number>(24).fill(0));

  it("finds the single busiest cell", () => {
    const grid = empty();
    grid[2]![14] = 3;
    grid[5]![21] = 9;
    expect(busiestSlot(grid)).toEqual({ dow: 5, hour: 21, count: 9 });
  });

  it("has no answer for a silent grid", () => {
    expect(busiestSlot(empty())).toBeUndefined();
  });
});
