// Pure helpers behind the Insights activity grid — kept out of the component
// so the bucketing/labelling is unit-testable without a DOM.

/** Row order matches the DTO: row 0 = Monday. */
export const DAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export const DAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"] as const;

/** Hours that get a printed label — every 6th, so the axis stays legible at
 * cell sizes where 24 numbers would collide. */
export const LABELLED_HOURS = [0, 6, 12, 18] as const;

/** Intensity bucket 0–4. Square-rooted: chat activity is heavily skewed, and
 * a linear ramp would leave everything but the single peak hour invisible. */
export function cellLevel(count: number, peak: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || peak <= 0) {
    return 0;
  }
  const ratio = Math.sqrt(count) / Math.sqrt(peak);
  return Math.min(4, Math.max(1, Math.ceil(ratio * 4))) as 1 | 2 | 3 | 4;
}

/** "14:00–15:00" (23 wraps to 00:00). */
export function hourRangeLabel(hour: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(hour)}:00–${pad((hour + 1) % 24)}:00`;
}

export interface Slot {
  dow: number;
  hour: number;
  count: number;
}

/** The single busiest cell — the one-line summary above the grid. */
export function busiestSlot(grid: number[][]): Slot | undefined {
  let best: Slot | undefined;
  grid.forEach((row, dow) => {
    row.forEach((count, hour) => {
      if (count > 0 && (!best || count > best.count)) {
        best = { dow, hour, count };
      }
    });
  });
  return best;
}
