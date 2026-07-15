// F-List JSON API client. Operational budget (developer policy): at most one
// request per second globally — every call funnels through the throttle
// below. The character-data endpoint (<200/hour budget) arrives with M6.

import {
  API_TICKET_PATH,
  SOCIAL_API_PATHS,
  apiEnvelopeSchema,
  apiTicketResponseSchema,
  bookmarkListSchema,
  friendListSchema,
  friendRequestListSchema,
  type ApiEnvelope,
  type ApiTicketResponse,
  type BookmarkList,
  type FriendList,
  type FriendRequestList,
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FlistApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #minIntervalMs: number;
  #lastRequestStart = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: FlistApiClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#minIntervalMs = options.minRequestIntervalMs ?? 1000;
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
    return this.#post(SOCIAL_API_PATHS.bookmarkList, auth, {}, bookmarkListSchema);
  }

  bookmarkAdd(auth: SocialAuth, name: string): Promise<ApiEnvelope> {
    return this.#post(SOCIAL_API_PATHS.bookmarkAdd, auth, { name }, apiEnvelopeSchema);
  }

  bookmarkRemove(auth: SocialAuth, name: string): Promise<ApiEnvelope> {
    return this.#post(SOCIAL_API_PATHS.bookmarkRemove, auth, { name }, apiEnvelopeSchema);
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
    return this.#post(SOCIAL_API_PATHS.requestList, auth, {}, friendRequestListSchema);
  }

  /** Outgoing friend requests (account-wide). */
  requestPending(auth: SocialAuth): Promise<FriendRequestList> {
    return this.#post(SOCIAL_API_PATHS.requestPending, auth, {}, friendRequestListSchema);
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
    const run = this.#queue.then(async () => {
      const waitMs = this.#lastRequestStart + this.#minIntervalMs - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      this.#lastRequestStart = Date.now();
      return fn();
    });
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
