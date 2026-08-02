// IANA zone validation. Two callers rely on it: the per-character timezone we
// store, and the activity heatmap's `AT TIME ZONE` bucketing — that one takes
// the zone as a bind parameter, so this is a correctness gate (Postgres
// errors on an unknown zone), not an injection guard.

/** True for a zone id the runtime — and therefore, tzdata being shared, also
 * Postgres — knows. `Intl.supportedValuesOf` is deliberately not used: it
 * omits aliases like "Asia/Calcutta" and "UTC" that are perfectly valid. */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
