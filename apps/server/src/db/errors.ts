const PG_UNIQUE_VIOLATION = "23505";

// Drizzle wraps driver errors (DrizzleQueryError), so the Postgres error
// code sits on `cause` — walk the chain.
export function isUniqueViolation(error: unknown): boolean {
  for (
    let current = error;
    typeof current === "object" && current !== null;
    current = (current as { cause?: unknown }).cause
  ) {
    if ((current as { code?: unknown }).code === PG_UNIQUE_VIOLATION) {
      return true;
    }
  }
  return false;
}
