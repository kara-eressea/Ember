// Per-F-List-account ticket manager (design/architecture.md §TicketManager).
// Tickets invalidate account-wide on issue and cost API budget, so ALL ticket
// acquisition goes through here: a fresh cached ticket is reused (~25 min of
// the 30-minute validity), and concurrent callers coalesce into one fetch.
// Tickets are never persisted — they are re-acquired from the in-memory
// credential vault via getPassword.

import type { FlistApiClient, GetApiTicketParams } from "./api-client.js";
import type { ApiTicketResponse } from "@emberline/fchat-protocol";
import type { CredentialVault } from "../flist-accounts/vault.js";

/** The slice of FlistApiClient the manager needs (stubbed in unit tests). */
export interface TicketApi {
  getApiTicket(params: GetApiTicketParams): Promise<ApiTicketResponse>;
}

/** F-List rejected the credentials — the vaulted password is wrong or stale. */
export class FlistAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlistAuthError";
  }
}

/** No password in the vault — the user must unlock the account first. */
export class AccountLockedError extends Error {
  constructor(accountName: string) {
    super(`No credentials in the vault for ${accountName}`);
    this.name = "AccountLockedError";
  }
}

const TICKET_TTL_MS = 25 * 60 * 1000;

export interface TicketManagerOptions {
  accountName: string;
  getPassword: () => string | undefined;
  apiClient: TicketApi;
  ttlMs?: number;
}

export class TicketManager {
  readonly #accountName: string;
  readonly #getPassword: () => string | undefined;
  readonly #api: TicketApi;
  readonly #ttlMs: number;
  #cached: { ticket: string; issuedAt: number } | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: TicketManagerOptions) {
    this.#accountName = options.accountName;
    this.#getPassword = options.getPassword;
    this.#api = options.apiClient;
    this.#ttlMs = options.ttlMs ?? TICKET_TTL_MS;
  }

  /** Cached-if-fresh; otherwise one coalesced fetch for all concurrent callers. */
  async getTicket(): Promise<string> {
    return this.#withLock(async () => {
      const fresh = this.#freshTicket();
      if (fresh !== undefined) {
        return fresh;
      }
      const response = await this.#fetchTicket({ withCharacters: false });
      return response.ticket;
    });
  }

  /**
   * Character data only comes with ticket issuance, so this always fetches —
   * still through the lock, and the new ticket replaces the cache.
   */
  async getTicketWithCharacters(): Promise<{
    ticket: string;
    characters: string[];
  }> {
    return this.#withLock(async () => {
      const response = await this.#fetchTicket({ withCharacters: true });
      return { ticket: response.ticket, characters: response.characters ?? [] };
    });
  }

  /** Drop the cached ticket (e.g. after the chat server rejects an IDN). */
  invalidate(): void {
    this.#cached = undefined;
  }

  #freshTicket(): string | undefined {
    if (this.#cached && Date.now() - this.#cached.issuedAt < this.#ttlMs) {
      return this.#cached.ticket;
    }
    return undefined;
  }

  async #fetchTicket(options: { withCharacters: boolean }) {
    const password = this.#getPassword();
    if (password === undefined) {
      throw new AccountLockedError(this.#accountName);
    }
    const response = await this.#api.getApiTicket({
      account: this.#accountName,
      password,
      noCharacters: !options.withCharacters,
      noFriends: true,
      noBookmarks: true,
    });
    if (!("ticket" in response)) {
      throw new FlistAuthError(response.error);
    }
    this.#cached = { ticket: response.ticket, issuedAt: Date.now() };
    return response;
  }

  /** Mutex: callers queue; whoever runs first fills the cache for the rest. */
  #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** One TicketManager per flist_accounts row, created lazily. */
export class TicketManagerRegistry {
  readonly #managers = new Map<string, TicketManager>();
  readonly #api: FlistApiClient;
  readonly #vault: CredentialVault;

  constructor(apiClient: FlistApiClient, vault: CredentialVault) {
    this.#api = apiClient;
    this.#vault = vault;
  }

  managerFor(accountId: string, accountName: string): TicketManager {
    let manager = this.#managers.get(accountId);
    if (!manager) {
      manager = new TicketManager({
        accountName,
        getPassword: () => this.#vault.get(accountId),
        apiClient: this.#api,
      });
      this.#managers.set(accountId, manager);
    }
    return manager;
  }

  drop(accountId: string): void {
    this.#managers.delete(accountId);
  }
}
