// Per-(account, IP) login lockout (M7 exposure hardening). The per-IP rate
// limit throttles raw request volume; this adds a growing backoff on
// repeated failures so a slow guesser can't grind one account. Keyed by
// email AND source IP on purpose: keying by email alone would let anyone
// who knows a victim's email lock the victim out of their own account from
// a single IP (the lock is checked before the password, so even the correct
// password would be refused). Per-IP keying means an attacker only locks
// their own IP; the real owner, on a different IP, is unaffected. In-memory:
// the server is single-process, and a restart forgiving lockouts is fine for
// an admin-only instance.

/** Consecutive failures before the (account, IP) locks. */
export const LOCKOUT_THRESHOLD = 5;
/** First lockout window; doubles with each further failure once locked. */
export const LOCKOUT_BASE_MS = 60_000;
/** Ceiling for the doubling window (15 minutes). */
export const LOCKOUT_MAX_MS = 15 * 60_000;
/** A quiet spell longer than this clears the failure count. Kept strictly
 * greater than LOCKOUT_MAX_MS so a maxed-out lock never expires into an
 * already-reset counter (which would hand back a full threshold of fresh
 * guesses each window instead of continuing the backoff). */
export const FAILURE_WINDOW_MS = 20 * 60_000;
/** Hard cap on tracked keys — evicted oldest-first past this. */
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

  #key(email: string, ip: string): string {
    return `${email.toLowerCase()}\n${ip}`;
  }

  /** Milliseconds until this (account, IP) may try again; 0 when unlocked. */
  lockedForMs(email: string, ip: string): number {
    const entry = this.#entries.get(this.#key(email, ip));
    if (!entry) {
      return 0;
    }
    return Math.max(0, entry.lockedUntil - this.#now());
  }

  /** Records a failed login; returns the lockout applied (0 = none yet). */
  recordFailure(email: string, ip: string): number {
    this.#prune();
    const key = this.#key(email, ip);
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
      const window = Math.min(LOCKOUT_BASE_MS * 2 ** doublings, LOCKOUT_MAX_MS);
      entry.lockedUntil = now + window;
      return window;
    }
    return 0;
  }

  /** A successful login clears that (account, IP)'s slate. */
  recordSuccess(email: string, ip: string): void {
    this.#entries.delete(this.#key(email, ip));
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
    // Hard cap: if a burst outran the opportunistic prune, evict oldest
    // (Map preserves insertion order) until back under the bound.
    while (this.#entries.size >= MAX_TRACKED) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#entries.delete(oldest);
    }
  }
}
