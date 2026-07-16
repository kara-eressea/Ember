// Per-account login lockout (M7 exposure hardening). The per-IP rate limit
// already throttles raw request volume, but a distributed guesser rotating
// IPs would still get unlimited tries at one account — this counts
// consecutive failures per email and locks the account out for a growing
// window. In-memory on purpose: the server is single-process (decisions.md),
// and a restart forgiving lockouts is acceptable for an admin-only instance.

/** Consecutive failures before the account locks. */
export const LOCKOUT_THRESHOLD = 5;
/** First lockout window; doubles with each further failure once locked. */
export const LOCKOUT_BASE_MS = 60_000;
/** Ceiling for the doubling window (15 minutes). */
export const LOCKOUT_MAX_MS = 15 * 60_000;
/** A quiet spell longer than this clears the failure count. */
export const FAILURE_WINDOW_MS = 15 * 60_000;
/** Lazy-prune bound — far beyond anything an admin-only instance sees. */
const MAX_TRACKED = 10_000;

interface Entry {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
}

export class LoginLockout {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Milliseconds until this account may try again; 0 when unlocked. */
  lockedForMs(email: string): number {
    const entry = this.#entries.get(email.toLowerCase());
    if (!entry) {
      return 0;
    }
    return Math.max(0, entry.lockedUntil - this.#now());
  }

  /** Records a failed login; returns the lockout applied (0 = none yet). */
  recordFailure(email: string): number {
    this.#prune();
    const key = email.toLowerCase();
    const now = this.#now();
    let entry = this.#entries.get(key);
    if (!entry || now - entry.lastFailureAt > FAILURE_WINDOW_MS) {
      entry = { failures: 0, lastFailureAt: now, lockedUntil: 0 };
      this.#entries.set(key, entry);
    }
    entry.failures += 1;
    entry.lastFailureAt = now;
    if (entry.failures >= LOCKOUT_THRESHOLD) {
      const doublings = entry.failures - LOCKOUT_THRESHOLD;
      const window = Math.min(
        LOCKOUT_BASE_MS * 2 ** doublings,
        LOCKOUT_MAX_MS,
      );
      entry.lockedUntil = now + window;
      return window;
    }
    return 0;
  }

  /** A successful login clears the slate. */
  recordSuccess(email: string): void {
    this.#entries.delete(email.toLowerCase());
  }

  #prune(): void {
    if (this.#entries.size < MAX_TRACKED) {
      return;
    }
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (
        now - entry.lastFailureAt > FAILURE_WINDOW_MS &&
        entry.lockedUntil <= now
      ) {
        this.#entries.delete(key);
      }
    }
  }
}
