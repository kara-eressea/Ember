// In-memory credential vault — bouncer-lite (decisions.md §3). F-List
// passwords live ONLY here: never persisted, logged, or serialized. A server
// restart empties it and affected identities show "re-enter password to
// reconnect" in the UI. Read exclusively by the TicketManager.

import { inspect } from "node:util";

export class CredentialVault {
  readonly #passwords = new Map<string, string>();

  set(accountId: string, password: string): void {
    this.#passwords.set(accountId, password);
  }

  get(accountId: string): string | undefined {
    return this.#passwords.get(accountId);
  }

  has(accountId: string): boolean {
    return this.#passwords.has(accountId);
  }

  delete(accountId: string): void {
    this.#passwords.delete(accountId);
  }

  clear(): void {
    this.#passwords.clear();
  }

  get size(): number {
    return this.#passwords.size;
  }

  // Belt and braces on top of #private fields: nothing readable comes out of
  // accidental JSON.stringify or console.log/util.inspect.
  toJSON(): Record<string, never> {
    return {};
  }

  [inspect.custom](): string {
    return `CredentialVault(${String(this.#passwords.size)} entries)`;
  }
}
