// F-List JSON API client. Operational budget (developer policy): at most one
// request per second globally — every call funnels through the throttle
// below. The character-data endpoint (<200/hour budget) arrives with M6.

import {
  API_TICKET_PATH,
  apiTicketResponseSchema,
  type ApiTicketResponse,
} from "@emberline/fchat-protocol";

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
