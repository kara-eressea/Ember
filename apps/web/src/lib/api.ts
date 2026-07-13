// Typed REST client. Reads tokens from the auth store, refreshes once on a
// 401, and surfaces structured errors. Same-origin `/api` — the dev server
// proxies to the API server, production serves both from one Fastify.

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

export interface FlistAccountDto {
  id: string;
  accountName: string;
  unlocked: boolean;
  createdAt: string;
}

export interface IdentityDto {
  id: string;
  flistAccountId: string;
  characterName: string;
  autoConnect: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface HistoryMessageDto {
  id: number;
  senderCharacter: string;
  kind: "msg" | "lrp" | "rll" | "sys" | "pm";
  bbcode: string;
  sentByUs: boolean;
  createdAt: string;
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
  method?: "GET" | "POST" | "DELETE";
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

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const auth = useAuthStore.getState();
  let response = await rawRequest(path, options, auth.accessToken);
  if (response.status === 401 && options.auth) {
    const refreshed = await auth.refreshSession();
    if (!refreshed) {
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
  register(input: { email: string; username: string; password: string }) {
    return apiRequest<TokenResponse>("/auth/register", {
      method: "POST",
      body: input,
    });
  },
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
    return apiRequest<{ accounts: FlistAccountDto[] }>("/flist-accounts", {
      auth: true,
    });
  },
  addFlistAccount(input: { accountName: string; password: string }) {
    return apiRequest<{ account: FlistAccountDto }>("/flist-accounts", {
      method: "POST",
      body: input,
      auth: true,
    });
  },
  unlockFlistAccount(id: string, password: string) {
    return apiRequest<{ account: FlistAccountDto }>(
      `/flist-accounts/${id}/unlock`,
      { method: "POST", body: { password }, auth: true },
    );
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

  /** One page of history, ascending; `before` walks toward older messages. */
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
};
