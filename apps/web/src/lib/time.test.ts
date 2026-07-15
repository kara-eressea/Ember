import { describe, expect, it } from "vitest";
import { formatTime } from "./time.js";

// Local-time construction so the assertions don't depend on the runner's TZ.
function iso(hours: number, minutes: number, seconds = 0): string {
  return new Date(2026, 6, 14, hours, minutes, seconds).toISOString();
}

describe("formatTime", () => {
  it("defaults to 24-hour [HH:MM]", () => {
    expect(formatTime(iso(9, 4))).toBe("09:04");
    expect(formatTime(iso(21, 30))).toBe("21:30");
  });

  it("renders 12-hour hours when the clock pref says so", () => {
    const f = { timestampFormat: "time", use24HourClock: false } as const;
    expect(formatTime(iso(21, 30), f)).toBe("09:30");
    expect(formatTime(iso(0, 5), f)).toBe("12:05"); // midnight is 12, not 0
    expect(formatTime(iso(12, 0), f)).toBe("12:00");
  });

  it("appends seconds for the long format", () => {
    const f = { timestampFormat: "seconds", use24HourClock: true } as const;
    expect(formatTime(iso(9, 4, 33), f)).toBe("09:04:33");
  });

  it("returns empty when timestamps are off", () => {
    const f = { timestampFormat: "off", use24HourClock: true } as const;
    expect(formatTime(iso(9, 4), f)).toBe("");
  });
});
