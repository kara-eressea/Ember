// Fake ticket issuing with the real invalidation rule: issuing a ticket
// invalidates all previous tickets for the account (the behavior the
// TicketManager exists to manage).

import { randomBytes } from "node:crypto";
import type { SimAccount } from "./world.js";

export class TicketService {
  readonly #accounts: Readonly<Record<string, SimAccount>>;
  readonly #latestTicketByAccount = new Map<string, string>();

  constructor(accounts: Readonly<Record<string, SimAccount>>) {
    this.#accounts = accounts;
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
    this.#latestTicketByAccount.set(account, ticket);
    return ticket;
  }

  /** Only the most recently issued ticket for an account is valid. */
  validate(account: string, ticket: string): boolean {
    return (
      ticket.length > 0 && this.#latestTicketByAccount.get(account) === ticket
    );
  }
}
