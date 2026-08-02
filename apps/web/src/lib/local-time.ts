// "What time is it where they are" — the clock the DM header and the DM
// sidebar show for a conversation partner.
//
// Two sources, in order: the IANA zone the user set for that character (they
// asked, or they know), else the numeric UTC offset F-List carries on the
// profile. The offset path is deliberately dumber — a fixed offset can't know
// about that region's DST — which is exactly why the user-set zone wins and
// why the tooltip names the source.

export interface LocalClock {
  /** Formatted in the viewer's locale, e.g. "14:32" or "2:32 PM". */
  time: string;
  /** Zone as we know it: an IANA id, or "UTC+5:30" for the offset path. */
  zone: string;
  source: "user" | "flist";
}

/** 24-hour locales want the leading zero ("06:00"); 12-hour ones read badly
 * with it ("06:00 AM"), so the hour field follows the viewer's cycle. */
const HOUR_MINUTE: Intl.DateTimeFormatOptions = {
  hour: new Intl.DateTimeFormat([], { hour: "numeric" }).resolvedOptions()
    .hour12
    ? "numeric"
    : "2-digit",
  minute: "2-digit",
};

export function localClock(
  now: number,
  timezone: string | null | undefined,
  offsetHours: number | null | undefined,
): LocalClock | undefined {
  if (timezone) {
    try {
      return {
        time: new Date(now).toLocaleTimeString([], {
          ...HOUR_MINUTE,
          timeZone: timezone,
        }),
        zone: timezone,
        source: "user",
      };
    } catch {
      // A zone the runtime doesn't know (stale tzdata, hand-edited row):
      // fall through rather than break the header.
    }
  }
  if (offsetHours === null || offsetHours === undefined) {
    return undefined;
  }
  // Shift the instant and read it back in UTC: a fixed offset has no zone id
  // to hand Intl.
  return {
    time: new Date(now + offsetHours * 3_600_000).toLocaleTimeString([], {
      ...HOUR_MINUTE,
      timeZone: "UTC",
    }),
    zone: offsetLabel(offsetHours),
    source: "flist",
  };
}

/** "UTC+2", "UTC-5:30", "UTC". */
export function offsetLabel(offsetHours: number): string {
  if (offsetHours === 0) {
    return "UTC";
  }
  const sign = offsetHours < 0 ? "-" : "+";
  const total = Math.round(Math.abs(offsetHours) * 60);
  const minutes = total % 60;
  const hours = (total - minutes) / 60;
  return `UTC${sign}${String(hours)}${minutes === 0 ? "" : `:${String(minutes).padStart(2, "0")}`}`;
}

/** Tooltip copy — terse, and honest about where the zone came from. */
export function clockTitle(clock: LocalClock, name: string): string {
  return clock.source === "user"
    ? `${name}'s local time · ${clock.zone} (set by you)`
    : `${name}'s local time · ${clock.zone} (from their F-List profile)`;
}
