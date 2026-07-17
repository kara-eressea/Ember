// F-List JSON API client. Operational budget (developer policy): at most one
// request per second globally — every call funnels through the throttle
// below. Character-data-class calls (character-data, guestbook) are
// additionally metered by CharacterDataBudget, which callers consult BEFORE
// invoking these methods (this client stays a pure transport).

import {
  API_TICKET_PATH,
  CHARACTER_API_PATHS,
  SOCIAL_API_PATHS,
  apiEnvelopeSchema,
  apiTicketResponseSchema,
  bookmarkListSchema,
  characterDataSchema,
  friendListSchema,
  friendRequestListSchema,
  guestbookSchema,
  infoListSchema,
  kinkListSchema,
  mappingListSchema,
  memoGetSchema,
  type ApiEnvelope,
  type ApiTicketResponse,
  type BookmarkList,
  type CharacterData,
  type FriendList,
  type FriendRequestList,
  type Guestbook,
  type InfoList,
  type KinkList,
  type MappingList,
  type MemoGet,
} from "@emberchat/fchat-protocol";

/** Every social endpoint authenticates with the account's current ticket. */
export interface SocialAuth {
  account: string;
  ticket: string;
}

export interface GetApiTicketParams {
  account: string;
  password: string;
  noCharacters?: boolean;
  noFriends?: boolean;
  noBookmarks?: boolean;
}

export interface FlistApiClientOptions {
  /** F-List base URL — or fchat-sim's httpUrl in dev/tests. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Minimum ms between request starts. Defaults to the 1 req/s budget. */
  minRequestIntervalMs?: number;
  /** Queue-depth cap. The throttle serializes ALL tenants' calls at 1 req/s
   * — without a cap one busy user inflates everyone's latency without
   * bound; past the cap new work sheds fast with FlistApiBusyError (M6
   * audit). */
  maxPendingRequests?: number;
}

/** The shared F-List budget is saturated; retry shortly. */
export class FlistApiBusyError extends Error {
  constructor() {
    super("The F-List API budget is saturated — try again shortly");
    this.name = "FlistApiBusyError";
  }
}

const MAX_PENDING_REQUESTS = 32;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FlistApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #minIntervalMs: number;
  readonly #maxPending: number;
  #pending = 0;
  #lastRequestStart = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: FlistApiClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#minIntervalMs = options.minRequestIntervalMs ?? 1000;
    this.#maxPending = options.maxPendingRequests ?? MAX_PENDING_REQUESTS;
  }

  async getApiTicket(params: GetApiTicketParams): Promise<ApiTicketResponse> {
    return this.#throttled(async () => {
      const form = new URLSearchParams({
        account: params.account,
        password: params.password,
      });
      if (params.noCharacters) form.set("no_characters", "true");
      if (params.noFriends) form.set("no_friends", "true");
      if (params.noBookmarks) form.set("no_bookmarks", "true");
      const response = await this.#fetch(
        new URL(API_TICKET_PATH, this.#baseUrl),
        {
          method: "POST",
          body: form,
        },
      );
      if (!response.ok) {
        throw new Error(`getApiTicket: HTTP ${String(response.status)}`);
      }
      return apiTicketResponseSchema.parse(await response.json());
    });
  }

  // ── Social endpoints (M6 step 7) — all through the same 1 req/s budget ──

  bookmarkList(auth: SocialAuth): Promise<BookmarkList> {
    return this.#post(
      SOCIAL_API_PATHS.bookmarkList,
      auth,
      {},
      bookmarkListSchema,
    );
  }

  bookmarkAdd(auth: SocialAuth, name: string): Promise<ApiEnvelope> {
    return this.#post(
      SOCIAL_API_PATHS.bookmarkAdd,
      auth,
      { name },
      apiEnvelopeSchema,
    );
  }

  bookmarkRemove(auth: SocialAuth, name: string): Promise<ApiEnvelope> {
    return this.#post(
      SOCIAL_API_PATHS.bookmarkRemove,
      auth,
      { name },
      apiEnvelopeSchema,
    );
  }

  friendList(auth: SocialAuth): Promise<FriendList> {
    return this.#post(SOCIAL_API_PATHS.friendList, auth, {}, friendListSchema);
  }

  /** source = OUR character, dest = the friend being removed. */
  friendRemove(
    auth: SocialAuth,
    source: string,
    dest: string,
  ): Promise<ApiEnvelope> {
    return this.#post(
      SOCIAL_API_PATHS.friendRemove,
      auth,
      { source_name: source, dest_name: dest },
      apiEnvelopeSchema,
    );
  }

  /** Incoming friend requests (account-wide). */
  requestList(auth: SocialAuth): Promise<FriendRequestList> {
    return this.#post(
      SOCIAL_API_PATHS.requestList,
      auth,
      {},
      friendRequestListSchema,
    );
  }

  /** Outgoing friend requests (account-wide). */
  requestPending(auth: SocialAuth): Promise<FriendRequestList> {
    return this.#post(
      SOCIAL_API_PATHS.requestPending,
      auth,
      {},
      friendRequestListSchema,
    );
  }

  requestSend(
    auth: SocialAuth,
    source: string,
    dest: string,
  ): Promise<ApiEnvelope> {
    return this.#post(
      SOCIAL_API_PATHS.requestSend,
      auth,
      { source_name: source, dest_name: dest },
      apiEnvelopeSchema,
    );
  }

  requestAccept(auth: SocialAuth, requestId: number): Promise<ApiEnvelope> {
    return this.#post(
      SOCIAL_API_PATHS.requestAccept,
      auth,
      { request_id: String(requestId) },
      apiEnvelopeSchema,
    );
  }

  requestDeny(auth: SocialAuth, requestId: number): Promise<ApiEnvelope> {
    return this.#post(
      SOCIAL_API_PATHS.requestDeny,
      auth,
      { request_id: String(requestId) },
      apiEnvelopeSchema,
    );
  }

  requestCancel(auth: SocialAuth, requestId: number): Promise<ApiEnvelope> {
    return this.#post(
      SOCIAL_API_PATHS.requestCancel,
      auth,
      { request_id: String(requestId) },
      apiEnvelopeSchema,
    );
  }

  // ── Character endpoints (M8 step 2) — shapes verified 2026-07-17 ────────
  // characterData/guestbook count against the 170/hour CharacterDataBudget
  // (enforced by callers); the mapping lists and memo reads don't.

  characterData(auth: SocialAuth, name: string): Promise<CharacterData> {
    return this.#post(
      CHARACTER_API_PATHS.characterData,
      auth,
      { name },
      characterDataSchema,
    );
  }

  /** page is 0-based, pages of 10. Gate on character-data's
   * `settings.guestbook` before spending budget here. */
  guestbook(auth: SocialAuth, id: number, page: number): Promise<Guestbook> {
    return this.#post(
      CHARACTER_API_PATHS.guestbook,
      auth,
      { id: String(id), page: String(page) },
      guestbookSchema,
    );
  }

  /** target is the character NAME (not id). */
  memoGet(auth: SocialAuth, target: string): Promise<MemoGet> {
    return this.#post(
      CHARACTER_API_PATHS.memoGet,
      auth,
      { target },
      memoGetSchema,
    );
  }

  mappingList(): Promise<MappingList> {
    return this.#postPublic(CHARACTER_API_PATHS.mappingList, mappingListSchema);
  }

  kinkList(): Promise<KinkList> {
    return this.#postPublic(CHARACTER_API_PATHS.kinkList, kinkListSchema);
  }

  infoList(): Promise<InfoList> {
    return this.#postPublic(CHARACTER_API_PATHS.infoList, infoListSchema);
  }

  /** Ticketless endpoints — still POST, still through the 1 req/s gate. */
  async #postPublic<T>(
    path: string,
    schema: { parse: (value: unknown) => T },
  ): Promise<T> {
    return this.#throttled(async () => {
      const response = await this.#fetch(new URL(path, this.#baseUrl), {
        method: "POST",
        body: new URLSearchParams(),
      });
      if (!response.ok) {
        throw new Error(`${path}: HTTP ${String(response.status)}`);
      }
      return schema.parse(await response.json());
    });
  }

  async #post<T>(
    path: string,
    auth: SocialAuth,
    fields: Record<string, string>,
    schema: { parse: (value: unknown) => T },
  ): Promise<T> {
    return this.#throttled(async () => {
      const form = new URLSearchParams({
        account: auth.account,
        ticket: auth.ticket,
        ...fields,
      });
      const response = await this.#fetch(new URL(path, this.#baseUrl), {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        throw new Error(`${path}: HTTP ${String(response.status)}`);
      }
      return schema.parse(await response.json());
    });
  }

  /** Serializes requests and enforces the minimum interval between starts. */
  #throttled<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#pending >= this.#maxPending) {
      return Promise.reject(new FlistApiBusyError());
    }
    this.#pending += 1;
    const run = this.#queue.then(async () => {
      const waitMs = this.#lastRequestStart + this.#minIntervalMs - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      this.#lastRequestStart = Date.now();
      return fn();
    });
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    void settled.then(() => {
      this.#pending -= 1;
    });
    this.#queue = settled;
    return run;
  }
}
