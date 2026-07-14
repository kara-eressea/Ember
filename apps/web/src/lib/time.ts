// Timestamp formatting for the message log (COMPONENTS.md §6), driven by
// the Appearance preferences (M5).

export interface TimeFormat {
  /** `[12:04]` · `[12:04:33]` · hidden (caller renders nothing). */
  timestampFormat: "time" | "seconds" | "off";
  use24HourClock: boolean;
}

const DEFAULT_FORMAT: TimeFormat = {
  timestampFormat: "time",
  use24HourClock: true,
};

/** Clock time for a MessageLine; "" when timestamps are off. */
export function formatTime(
  iso: string,
  format: TimeFormat = DEFAULT_FORMAT,
): string {
  if (format.timestampFormat === "off") {
    return "";
  }
  const date = new Date(iso);
  const hours24 = date.getHours();
  const hours = format.use24HourClock ? hours24 : hours24 % 12 || 12;
  const hh = String(hours).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  if (format.timestampFormat === "seconds") {
    const ss = String(date.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }
  return `${hh}:${mm}`;
}

/** Local-date bucket key — a DateDivider goes between two different keys. */
export function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getFullYear())}-${String(date.getMonth())}-${String(date.getDate())}`;
}

/** DateDivider label, e.g. "Sunday, July 12 2026". */
export function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
