// The partner clock: which source wins, and how a bare UTC offset is drawn
// when there is no zone id to hand Intl.

import { describe, expect, it } from "vitest";
import { clockTitle, localClock, offsetLabel } from "./local-time.js";

// 2026-08-01T12:00:00Z — a Saturday noon in UTC.
const NOON_UTC = Date.UTC(2026, 7, 1, 12, 0);

function hhmm(value: string): string {
  // Normalize away locale hour-cycle noise ("2:00 PM" vs "14:00").
  return value.replace(/\s/g, "");
}

describe("localClock", () => {
  it("prefers the user-set zone over F-List's offset", () => {
    const clock = localClock(NOON_UTC, "Europe/Berlin", -8);
    expect(clock?.source).toBe("user");
    expect(clock?.zone).toBe("Europe/Berlin");
    // CEST in August: UTC+2.
    expect(hhmm(clock?.time ?? "")).toMatch(/^0?2:00PM$|^14:00$/);
  });

  it("falls back to the profile offset when no zone was set", () => {
    const clock = localClock(NOON_UTC, null, -5);
    expect(clock?.source).toBe("flist");
    expect(clock?.zone).toBe("UTC-5");
    expect(hhmm(clock?.time ?? "")).toMatch(/^0?7:00AM$|^07:00$/);
  });

  it("handles a half-hour offset", () => {
    const clock = localClock(NOON_UTC, null, 5.5);
    expect(clock?.zone).toBe("UTC+5:30");
    expect(hhmm(clock?.time ?? "")).toMatch(/^0?5:30PM$|^17:30$/);
  });

  it("falls back when the stored zone is unknown to the runtime", () => {
    const clock = localClock(NOON_UTC, "Mars/Olympus_Mons", 1);
    expect(clock?.source).toBe("flist");
  });

  it("shows nothing when neither source knows", () => {
    expect(localClock(NOON_UTC, null, null)).toBeUndefined();
  });
});

describe("offsetLabel", () => {
  it("names whole, fractional and zero offsets", () => {
    expect(offsetLabel(0)).toBe("UTC");
    expect(offsetLabel(2)).toBe("UTC+2");
    expect(offsetLabel(-3.5)).toBe("UTC-3:30");
  });
});

describe("clockTitle", () => {
  it("says which source the zone came from", () => {
    expect(
      clockTitle(localClock(NOON_UTC, "Europe/Berlin", null)!, "Nyx"),
    ).toContain("set by you");
    expect(clockTitle(localClock(NOON_UTC, null, 1)!, "Nyx")).toContain(
      "F-List profile",
    );
  });
});
