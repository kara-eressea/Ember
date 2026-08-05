// Typed REST client. Reads tokens from the auth store, refreshes once on a
// 401, and surfaces structured errors. Same-origin `/api` — the dev server
// proxies to the API server, production serves both from one Fastify.

import type {
  AdDto,
  RatingDto,
  GuestbookPage,
  HighlightRuleDto,
  HighlightRuleInput,
  NotificationDto,
  ProfileActivity,
  ProfileHistoryEntry,
  ProfileInsights,
  ProfileResponse,
} from "@emberchat/protocol";
import { useAuthStore } from "../stores/auth.js";

export interface UserDto {
  id: string;
  email: string;
  username: string;
}

export interface TokenResponse {
  user: UserDto;
  accessToken: string;
  refreshToken: string;
}

/** One in-log search hit (M9). */
export interface SearchResultDto {
  id: number;
  convId: string;
  conversationTitle: string;
  conversationKind: "channel" | "pm";
  senderCharacter: string;
  kind: "msg" | "lrp" | "rll" | "sys" | "pm";
  bbcode: string;
  createdAt: string;
}

export interface FlistAccountDto {
  id: string;
  accountName: string;
  unlocked: boolean;
  /** An encrypted at-rest credential is stored on the server (§15). */
  remembered: boolean;
  createdAt: string;
}

export interface IdentityDto {
  id: string;
  flistAccountId: string;
  characterName: string;
  autoConnect: boolean;
  sortOrder: number;
  createdAt: string;
  /** FchatSession status, "offline" when no session exists. */
  sessionStatus: string;
}

export interface HistoryMessageDto {
  id: number;
  senderCharacter: string;
  kind: "msg" | "lrp" | "rll" | "sys" | "pm";
  bbcode: string;
  sentByUs: boolean;
  /** Persist-time highlight verdict (M5) — same field as MessageDto. */
  mention: boolean;
  createdAt: string;
}

export interface DirectoryChannelDto {
  /** F-Chat channel name (official) or ADH- id (open room). */
  key: string;
  kind: "official" | "open";
  title: string;
  /** Member count as of refreshedAt — point-in-time by nature. */
  characters: number;
}

/** One friend or bookmark, presence-enriched by the server (M6 step 7). */
export interface SocialCharacterDto {
  name: string;
  online: boolean;
  status: string;
  statusmsg: string;
}

export interface MetaDto {
  version: string;
  updateAvailable: boolean;
  latestVersion?: string;
  releasesUrl: string;
}

export interface SocialDto {
  bookmarks: SocialCharacterDto[];
  friends: SocialCharacterDto[];
  /** Friend requests addressed to this character. */
  incoming: { id: number; name: string }[];
  /** Friend requests this character has sent. */
  outgoing: { id: number; name: string }[];
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  /** Attach the bearer token and retry once through a refresh on 401. */
  auth?: boolean;
}

async function rawRequest(
  path: string,
  options: RequestOptions,
  accessToken: string | undefined,
): Promise<Response> {
  return fetch(`/api${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
      ...(options.auth && accessToken
        ? { authorization: `Bearer ${accessToken}` }
        : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
}

async function toError(response: Response): Promise<ApiError> {
  let message = `Request failed (${String(response.status)})`;
  try {
    // Our routes put the text in `error`; fastify's own errors (validation,
    // rate limit) put the useful part in `message`.
    const body = (await response.json()) as {
      error?: string;
      message?: string;
    };
    message = body.error ?? body.message ?? message;
  } catch {
    // Non-JSON error body — keep the generic message.
  }
  return new ApiError(response.status, message);
}

/** Authenticated binary/text download (same 401-refresh flow as apiRequest,
 * but the response stays a Blob instead of being JSON-parsed). */
export async function apiDownload(path: string): Promise<Blob> {
  const auth = useAuthStore.getState();
  let response = await rawRequest(path, { auth: true }, auth.accessToken);
  if (response.status === 401) {
    const refreshed = await auth.refreshSession();
    if (refreshed !== "ok") {
      throw await toError(response);
    }
    response = await rawRequest(
      path,
      { auth: true },
      useAuthStore.getState().accessToken,
    );
  }
  if (!response.ok) {
    throw await toError(response);
  }
  return response.blob();
}

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const auth = useAuthStore.getState();
  let response = await rawRequest(path, options, auth.accessToken);
  if (response.status === 401 && options.auth) {
    const refreshed = await auth.refreshSession();
    if (refreshed !== "ok") {
      throw await toError(response);
    }
    response = await rawRequest(
      path,
      options,
      useAuthStore.getState().accessToken,
    );
  }
  if (!response.ok) {
    throw await toError(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const api = {
  login(input: { email: string; password: string }) {
    return apiRequest<TokenResponse>("/auth/login", {
      method: "POST",
      body: input,
    });
  },
  refresh(refreshToken: string) {
    return apiRequest<{ accessToken: string; refreshToken: string }>(
      "/auth/refresh",
      { method: "POST", body: { refreshToken } },
    );
  },
  logout(refreshToken: string) {
    // 204 — no body.
    return apiRequest<undefined>("/auth/logout", {
      method: "POST",
      body: { refreshToken },
    });
  },
  me() {
    return apiRequest<{ user: UserDto }>("/auth/me", { auth: true });
  },

  listFlistAccounts() {
    return apiRequest<{ accounts: FlistAccountDto[]; canRemember: boolean }>(
      "/flist-accounts",
      { auth: true },
    );
  },
  addFlistAccount(input: {
    accountName: string;
    password: string;
    remember?: boolean;
  }) {
    return apiRequest<{ account: FlistAccountDto }>("/flist-accounts", {
      method: "POST",
      body: input,
      auth: true,
    });
  },
  unlockFlistAccount(id: string, password: string, remember?: boolean) {
    return apiRequest<{ account: FlistAccountDto; reconnected: string[] }>(
      `/flist-accounts/${id}/unlock`,
      { method: "POST", body: { password, remember }, auth: true },
    );
  },
  setFlistAccountRemember(id: string, remember: boolean) {
    return apiRequest<{ account: FlistAccountDto }>(
      `/flist-accounts/${id}/remember`,
      { method: "PUT", body: { remember }, auth: true },
    );
  },
  deleteFlistAccount(id: string) {
    return apiRequest<undefined>(`/flist-accounts/${id}`, {
      method: "DELETE",
      auth: true,
    });
  },
  listCharacters(accountId: string) {
    return apiRequest<{ characters: string[] }>(
      `/flist-accounts/${accountId}/characters`,
      { auth: true },
    );
  },

  listIdentities() {
    return apiRequest<{ identities: IdentityDto[] }>("/identities", {
      auth: true,
    });
  },
  createIdentity(input: { flistAccountId: string; characterName: string }) {
    return apiRequest<{ identity: IdentityDto }>("/identities", {
      method: "POST",
      body: input,
      auth: true,
    });
  },
  deleteIdentity(id: string) {
    return apiRequest<undefined>(`/identities/${id}`, {
      method: "DELETE",
      auth: true,
    });
  },
  /** Full rail order — must list every identity exactly once. */
  reorderIdentities(ids: string[]) {
    return apiRequest<undefined>("/identities/order", {
      method: "PUT",
      body: { ids },
      auth: true,
    });
  },
  connectIdentity(id: string) {
    return apiRequest<{ identity: IdentityDto }>(`/identities/${id}/connect`, {
      method: "POST",
      auth: true,
    });
  },
  disconnectIdentity(id: string) {
    return apiRequest<{ identity: IdentityDto }>(
      `/identities/${id}/disconnect`,
      { method: "POST", auth: true },
    );
  },

  /** One page of history, ascending; `before` walks toward older messages. */
  searchMessages(
    identityId: string,
    q: string,
    options: { convId?: string; cursor?: number } = {},
  ) {
    const query = new URLSearchParams({ q });
    if (options.convId !== undefined) {
      query.set("convId", options.convId);
    }
    if (options.cursor !== undefined) {
      query.set("cursor", String(options.cursor));
    }
    return apiRequest<{ results: SearchResultDto[]; nextCursor?: number }>(
      `/identities/${identityId}/search?${query.toString()}`,
      { auth: true },
    );
  },
  listMessages(
    identityId: string,
    conversationId: string,
    options: { before?: number; limit?: number } = {},
  ) {
    const query = new URLSearchParams();
    if (options.before !== undefined) {
      query.set("before", String(options.before));
    }
    if (options.limit !== undefined) {
      query.set("limit", String(options.limit));
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return apiRequest<{ messages: HistoryMessageDto[]; hasMore: boolean }>(
      `/identities/${identityId}/conversations/${conversationId}/messages${suffix}`,
      { auth: true },
    );
  },

  /** One page of the notification inbox (#467), NEWEST FIRST; `before`
   * walks toward older entries. */
  listNotifications(
    identityId: string,
    options: { before?: number; limit?: number } = {},
  ) {
    const query = new URLSearchParams();
    if (options.before !== undefined) {
      query.set("before", String(options.before));
    }
    if (options.limit !== undefined) {
      query.set("limit", String(options.limit));
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return apiRequest<{
      notifications: NotificationDto[];
      hasMore: boolean;
      lastSeenId: number;
      unseen: number;
    }>(`/identities/${identityId}/notifications${suffix}`, { auth: true });
  },
  /** Advance the seen watermark (monotonic server-side). */
  putNotificationsSeen(identityId: string, lastSeenId: number) {
    return apiRequest<{ lastSeenId: number; unseen: number }>(
      `/identities/${identityId}/notifications/seen`,
      { method: "PUT", body: { lastSeenId }, auth: true },
    );
  },
  /** Drop one entry from the log (#506). Idempotent, and answers with the
   * server's recounted unseen total so the badge settles on the response
   * rather than on arithmetic. */
  deleteNotification(identityId: string, notificationId: number) {
    return apiRequest<{ removed: boolean; unseen: number }>(
      `/identities/${identityId}/notifications/${String(notificationId)}`,
      { method: "DELETE", auth: true },
    );
  },

  /** Whole-conversation log export (M5 Away & logs pane). */
  exportLog(
    identityId: string,
    conversationId: string,
    format: "txt" | "html" | "json",
  ) {
    return apiDownload(
      `/identities/${identityId}/conversations/${conversationId}/export?format=${format}`,
    );
  },

  /** Running version + update-check status (M7 about surface). */
  getMeta() {
    return apiRequest<MetaDto>("/meta", { auth: true });
  },

  /** Web Push feature detection and the instance's VAPID public key
   * (design/web-push.md §3). `enabled: false` means this instance was never
   * given a keypair — the whole control hides. */
  getPushVapidKey() {
    return apiRequest<{ enabled: boolean; key?: string }>("/push/vapid-key", {
      auth: true,
    });
  },
  /** Register or refresh this browser's push subscription. Upserts on the
   * endpoint, so re-PUTting an unchanged one is the intended self-heal. */
  putPushSubscription(subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }) {
    return apiRequest<{ ok: true }>("/push/subscription", {
      method: "PUT",
      auth: true,
      body: subscription,
    });
  },
  /** Drop one endpoint. Idempotent, and scoped server-side to the caller. */
  deletePushSubscription(endpoint: string) {
    return apiRequest<{ removed: boolean }>("/push/subscription", {
      method: "DELETE",
      auth: true,
      body: { endpoint },
    });
  },

  /** Bookmarks, friends and friend requests (M6 step 7), scoped to the
   * identity's character and presence-enriched by the server. Served from
   * the server-side cache while fresh (#194); refresh forces the four
   * upstream F-List calls (1 req/s budget) — use it sparingly. */
  getSocial(identityId: string, refresh = false) {
    const suffix = refresh ? "?refresh=1" : "";
    return apiRequest<SocialDto>(`/identities/${identityId}/social${suffix}`, {
      auth: true,
    });
  },

  postBookmark(identityId: string, action: "add" | "remove", name: string) {
    return apiRequest<{ ok: true }>(
      `/identities/${identityId}/social/bookmark`,
      { method: "POST", auth: true, body: { action, name } },
    );
  },

  postFriendRequest(
    identityId: string,
    body:
      | { action: "remove-friend" | "send"; character: string }
      | { action: "accept" | "cancel" | "deny"; requestId: number },
  ) {
    return apiRequest<{ ok: true }>(
      `/identities/${identityId}/social/request`,
      { method: "POST", auth: true, body },
    );
  },

  /** Shared channel listings (M6 channel browser). The server refreshes the
   * cache over the identity's live session when it is past the cooldown;
   * refreshedAt says how stale the point-in-time counts are. */
  getDirectory(identityId: string) {
    return apiRequest<{
      channels: DirectoryChannelDto[];
      refreshedAt: string | null;
    }>(`/identities/${identityId}/directory`, { auth: true });
  },

  // ── Profiles (M8) ─────────────────────────────────────────────────────────
  // getProfile can spend the server's 170/hour F-List budget (cache misses,
  // refresh) — the lib/profile.ts loader dedups; components never call raw.

  getProfile(identityId: string, name: string, refresh = false) {
    const suffix = refresh ? "?refresh=1" : "";
    return apiRequest<ProfileResponse>(
      `/identities/${identityId}/profile/${encodeURIComponent(name)}${suffix}`,
      { auth: true },
    );
  },
  getProfileHistory(identityId: string) {
    return apiRequest<{ history: ProfileHistoryEntry[] }>(
      `/identities/${identityId}/profile-history`,
      { auth: true },
    );
  },
  deleteProfileHistory(identityId: string, name: string) {
    return apiRequest<{ ok: true }>(
      `/identities/${identityId}/profile-history/${encodeURIComponent(name)}`,
      { method: "DELETE", auth: true },
    );
  },
  putProfileNote(identityId: string, name: string, note: string) {
    return apiRequest<{ ok: true }>(
      `/identities/${identityId}/profile/${encodeURIComponent(name)}/note`,
      { method: "PUT", auth: true, body: { note } },
    );
  },
  /** The timezone the user set for this character; null forgets it and falls
   * back to the offset F-List's own profile carries. */
  putProfileTimezone(
    identityId: string,
    name: string,
    timezone: string | null,
  ) {
    return apiRequest<{ ok: true }>(
      `/identities/${identityId}/profile/${encodeURIComponent(name)}/timezone`,
      { method: "PUT", auth: true, body: { timezone } },
    );
  },
  getProfileInsights(identityId: string, name: string) {
    return apiRequest<ProfileInsights>(
      `/identities/${identityId}/profile/${encodeURIComponent(name)}/insights`,
      { auth: true },
    );
  },
  /** Weekday × hour activity buckets. `tz` is the viewer's own zone — the
   * server buckets in it so the grid reads on the viewer's clock. */
  getProfileActivity(identityId: string, name: string, tz: string) {
    return apiRequest<ProfileActivity>(
      `/identities/${identityId}/profile/${encodeURIComponent(name)}/activity?tz=${encodeURIComponent(tz)}`,
      { auth: true },
    );
  },
  /** One guestbook page (0-based, pages of 10) — passthrough to F-List,
   * so it spends the character-data budget like a profile fetch. */
  getProfileGuestbook(identityId: string, name: string, page: number) {
    return apiRequest<GuestbookPage>(
      `/identities/${identityId}/profile/${encodeURIComponent(name)}/guestbook?page=${String(page)}`,
      { auth: true },
    );
  },
  /** The F-List memo — budget-free; feeds the one-way note import. */
  getProfileMemo(identityId: string, name: string) {
    return apiRequest<{ note: string | null }>(
      `/identities/${identityId}/profile/${encodeURIComponent(name)}/memo`,
      { auth: true },
    );
  },

  /** The F-List kink vocabulary (M10 search picker) — cached server-side
   * off the mapping list, no budget cost. */
  getKinks(identityId: string) {
    return apiRequest<{
      kinks: { id: string; name: string; group?: string }[];
    }>(`/identities/${identityId}/kinks`, { auth: true });
  },

  /** Server-local eicon index search (M8) — pref-gated (403 when off). */
  searchEicons(query: string) {
    return apiRequest<{ results: string[] }>(
      `/eicons/search?q=${encodeURIComponent(query)}`,
      { auth: true },
    );
  },

  /** A page of the full eicon index for the gallery browser (#239) —
   * same pref gate as search (403 when off). */
  browseEicons(offset: number, limit: number) {
    return apiRequest<{ names: string[]; total: number }>(
      `/eicons/browse?offset=${String(offset)}&limit=${String(limit)}`,
      { auth: true },
    );
  },

  /** The identity's ad library, in display order (M10). */
  getAds(identityId: string) {
    return apiRequest<{ ads: AdDto[] }>(`/identities/${identityId}/ads`, {
      auth: true,
    });
  },
  /** Idempotent full-list replacement (the highlight-rules pattern);
   * 409 = `knownIds` no longer match — the library changed on another
   * device since it was loaded. */
  putAds(
    identityId: string,
    ads: { content: string; tags: string[]; disabled: boolean }[],
    knownIds?: string[],
  ) {
    return apiRequest<{ ads: AdDto[] }>(`/identities/${identityId}/ads`, {
      method: "PUT",
      body: { ads, ...(knownIds !== undefined ? { knownIds } : {}) },
      auth: true,
    });
  },

  /** The user's local ad ratings (M11) — shared across identities. */
  getRatings() {
    return apiRequest<{ ratings: RatingDto[] }>("/ad-ratings/", {
      auth: true,
    });
  },
  putRating(character: string, score: number, note?: string) {
    return apiRequest<{ rating: RatingDto }>(
      `/ad-ratings/${encodeURIComponent(character)}`,
      {
        method: "PUT",
        body: { score, ...(note !== undefined && note !== "" ? { note } : {}) },
        auth: true,
      },
    );
  },
  deleteRating(character: string) {
    return apiRequest<void>(`/ad-ratings/${encodeURIComponent(character)}`, {
      method: "DELETE",
      auth: true,
    });
  },

  listHighlightRules() {
    return apiRequest<{ rules: HighlightRuleDto[] }>("/highlight-rules", {
      auth: true,
    });
  },
  /** Idempotent full-list replacement; 422 = a rule the server refused
   * (e.g. a regex RE2 can't compile); 409 = `knownIds` no longer match —
   * another device edited the list since it was loaded. */
  putHighlightRules(rules: HighlightRuleInput[], knownIds?: string[]) {
    return apiRequest<{ rules: HighlightRuleDto[] }>("/highlight-rules", {
      method: "PUT",
      body: { rules, ...(knownIds !== undefined ? { knownIds } : {}) },
      auth: true,
    });
  },
};
