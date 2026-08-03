// Fake ticket issuing with the real invalidation rules: issuing a ticket
// invalidates all previous tickets for the account, and a ticket goes stale
// 30 minutes after issuance (the behaviors the TicketManager exists to
// manage — it re-issues at ~25 min, so the TTL should never bite it).

import { randomBytes } from "node:crypto";
import type { SimAccount } from "./world.js";

/** Live tickets last 30 minutes. */
const DEFAULT_TICKET_TTL_MS = 30 * 60 * 1000;

export interface TicketServiceOptions {
  /** Tests shorten this to exercise expiry without waiting. */
  readonly ttlMs?: number;
}

export class TicketService {
  readonly #accounts: Readonly<Record<string, SimAccount>>;
  readonly #ttlMs: number;
  readonly #latestTicketByAccount = new Map<
    string,
    { ticket: string; issuedAt: number }
  >();

  constructor(
    accounts: Readonly<Record<string, SimAccount>>,
    options: TicketServiceOptions = {},
  ) {
    this.#accounts = accounts;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TICKET_TTL_MS;
  }

  account(name: string): SimAccount | undefined {
    return this.#accounts[name];
  }

  /** Returns a fresh ticket, or undefined for bad credentials. */
  issue(account: string, password: string): string | undefined {
    const known = this.#accounts[account];
    if (!known || known.password !== password) {
      return undefined;
    }
    const ticket = `fct_${randomBytes(16).toString("hex")}`;
    this.#latestTicketByAccount.set(account, { ticket, issuedAt: Date.now() });
    return ticket;
  }

  /**
   * Only the most recently issued ticket for an account is valid, and only
   * until it expires. Callers map a false here to their own stale-ticket
   * envelope ("Invalid ticket." over JSON, ERR 4 on IDN) — the live API
   * makes no distinction between a superseded ticket and an expired one.
   */
  validate(account: string, ticket: string): boolean {
    const latest = this.#latestTicketByAccount.get(account);
    return (
      ticket.length > 0 &&
      latest?.ticket === ticket &&
      Date.now() - latest.issuedAt < this.#ttlMs
    );
  }
}
