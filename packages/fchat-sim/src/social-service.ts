// Fake account-wide social graph behind the JSON API's bookmark/friend/
// request endpoints and the FRL login frame. Seeded from world fixtures,
// mutable at runtime like the real thing. Friendships are symmetric: an
// accepted request lands on both accounts (when both exist in the world).

import type { SimAccount } from "./world.js";

export interface FriendPair {
  readonly own: string;
  readonly friend: string;
}

export interface FriendRequest {
  readonly id: number;
  /** The sender character. */
  readonly source: string;
  /** The recipient character. */
  readonly dest: string;
}

interface AccountSocial {
  readonly bookmarks: Set<string>;
  friends: FriendPair[];
}

export class SocialService {
  readonly #accounts: Readonly<Record<string, SimAccount>>;
  readonly #byAccount = new Map<string, AccountSocial>();
  #requests: FriendRequest[] = [];
  #nextRequestId = 1;

  constructor(accounts: Readonly<Record<string, SimAccount>>) {
    this.#accounts = accounts;
    for (const [name, account] of Object.entries(accounts)) {
      this.#byAccount.set(name, {
        bookmarks: new Set(account.bookmarks ?? []),
        friends: [...(account.friends ?? [])],
      });
      for (const request of account.incomingRequests ?? []) {
        this.#requests.push({
          id: this.#nextRequestId++,
          source: request.from,
          dest: request.to,
        });
      }
    }
  }

  #social(account: string): AccountSocial | undefined {
    return this.#byAccount.get(account);
  }

  /** Which account owns a character (for symmetric friendship updates). */
  #accountOf(character: string): string | undefined {
    for (const [name, account] of Object.entries(this.#accounts)) {
      if (account.characters.includes(character)) {
        return name;
      }
    }
    return undefined;
  }

  /** FRL payload: the union of the account's bookmarks and friend names. */
  frlFor(account: string): string[] {
    const social = this.#social(account);
    if (!social) {
      return [];
    }
    const names = new Set(social.bookmarks);
    for (const pair of social.friends) {
      names.add(pair.friend);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  bookmarks(account: string): string[] {
    return [...(this.#social(account)?.bookmarks ?? [])].sort((a, b) =>
      a.localeCompare(b),
    );
  }

  friends(account: string): FriendPair[] {
    return [...(this.#social(account)?.friends ?? [])];
  }

  /** Error string ("" = success), mirroring the JSON API envelope. */
  bookmarkAdd(account: string, name: string): string {
    const social = this.#social(account);
    if (!social) {
      return "Invalid account.";
    }
    if (social.bookmarks.has(name)) {
      return "You already have this character bookmarked.";
    }
    social.bookmarks.add(name);
    return "";
  }

  bookmarkRemove(account: string, name: string): string {
    const social = this.#social(account);
    if (!social) {
      return "Invalid account.";
    }
    if (!social.bookmarks.delete(name)) {
      return "You do not have this character bookmarked.";
    }
    return "";
  }

  /** Incoming requests: those addressed to the account's characters. */
  incoming(account: string): FriendRequest[] {
    const characters = this.#accounts[account]?.characters ?? [];
    return this.#requests.filter((request) =>
      characters.includes(request.dest),
    );
  }

  /** Outgoing requests: those sent by the account's characters. */
  outgoing(account: string): FriendRequest[] {
    const characters = this.#accounts[account]?.characters ?? [];
    return this.#requests.filter((request) =>
      characters.includes(request.source),
    );
  }

  requestSend(account: string, source: string, dest: string): string {
    const characters = this.#accounts[account]?.characters ?? [];
    if (!characters.includes(source)) {
      return "That character does not belong to this account.";
    }
    const social = this.#social(account);
    if (social?.friends.some((pair) => pair.own === source && pair.friend === dest)) {
      return "You are already friends with this character.";
    }
    if (
      this.#requests.some(
        (request) => request.source === source && request.dest === dest,
      )
    ) {
      return "There is already a pending request for this character.";
    }
    this.#requests.push({ id: this.#nextRequestId++, source, dest });
    return "";
  }

  requestAccept(account: string, id: number): string {
    const request = this.incoming(account).find((entry) => entry.id === id);
    if (!request) {
      return "Invalid request.";
    }
    this.#requests = this.#requests.filter((entry) => entry.id !== id);
    this.#social(account)?.friends.push({
      own: request.dest,
      friend: request.source,
    });
    const senderAccount = this.#accountOf(request.source);
    if (senderAccount !== undefined) {
      this.#social(senderAccount)?.friends.push({
        own: request.source,
        friend: request.dest,
      });
    }
    return "";
  }

  requestDeny(account: string, id: number): string {
    if (!this.incoming(account).some((entry) => entry.id === id)) {
      return "Invalid request.";
    }
    this.#requests = this.#requests.filter((entry) => entry.id !== id);
    return "";
  }

  requestCancel(account: string, id: number): string {
    if (!this.outgoing(account).some((entry) => entry.id === id)) {
      return "Invalid request.";
    }
    this.#requests = this.#requests.filter((entry) => entry.id !== id);
    return "";
  }

  /** friend-remove: source is OUR character, dest the friend. Symmetric. */
  friendRemove(account: string, source: string, dest: string): string {
    const social = this.#social(account);
    const had = social?.friends.some(
      (pair) => pair.own === source && pair.friend === dest,
    );
    if (!social || had !== true) {
      return "You are not friends with this character.";
    }
    social.friends = social.friends.filter(
      (pair) => !(pair.own === source && pair.friend === dest),
    );
    const otherAccount = this.#accountOf(dest);
    const other =
      otherAccount === undefined ? undefined : this.#social(otherAccount);
    if (other) {
      other.friends = other.friends.filter(
        (pair) => !(pair.own === dest && pair.friend === source),
      );
    }
    return "";
  }
}
