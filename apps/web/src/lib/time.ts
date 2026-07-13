// Timestamp formatting for the message log (COMPONENTS.md §6). Format
// preferences (12/24h, seconds, off) arrive with Preferences in M5; until
// then everything renders as 24-hour [HH:MM].

/** `[12:04]`-style clock time for a MessageLine. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
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
