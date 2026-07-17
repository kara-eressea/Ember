// Sliding one-hour window over character-data-class requests — everything
// F-List counts against its 200/hour limit (character-data, guestbook pages).
// Tickets and the ticketless mapping lists don't count. The soft cap of 170
// keeps headroom under the policy limit; the budget is global per instance
// because the policy risk attaches to the egress IP, and it sits IN FRONT of
// FlistApiClient's 1 req/s throttle (two orthogonal gates). In-memory: a
// restart resets the window (accepted LOW — the cap's headroom absorbs it).

export interface CharacterDataBudgetOptions {
  /** Requests allowed per window. Defaults to the 170/hour soft cap. */
  limit?: number;
  windowMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

const DEFAULT_LIMIT = 170;
const HOUR_MS = 60 * 60 * 1000;

export class CharacterDataBudget {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  /** Start timestamps of counted requests, oldest first. */
  #stamps: number[] = [];

  constructor(options: CharacterDataBudgetOptions = {}) {
    this.#limit = options.limit ?? DEFAULT_LIMIT;
    this.#windowMs = options.windowMs ?? HOUR_MS;
    this.#now = options.now ?? Date.now;
  }

  /** Consume one request if the window has room. Callers that get `false`
   * serve stale (with `budgetExhausted`) or 429 — they never bypass. */
  tryConsume(): boolean {
    this.#prune();
    if (this.#stamps.length >= this.#limit) {
      return false;
    }
    this.#stamps.push(this.#now());
    return true;
  }

  get used(): number {
    this.#prune();
    return this.#stamps.length;
  }

  get remaining(): number {
    this.#prune();
    return this.#limit - this.#stamps.length;
  }

  /** Ms until the next slot frees (0 when one is free now). */
  retryAfterMs(): number {
    this.#prune();
    if (this.#stamps.length < this.#limit) {
      return 0;
    }
    return Math.max(0, this.#stamps[0]! + this.#windowMs - this.#now());
  }

  #prune(): void {
    const cutoff = this.#now() - this.#windowMs;
    let drop = 0;
    while (drop < this.#stamps.length && this.#stamps[drop]! <= cutoff) {
      drop += 1;
    }
    if (drop > 0) {
      this.#stamps = this.#stamps.slice(drop);
    }
  }
}
