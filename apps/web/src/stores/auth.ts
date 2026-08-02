// App-account session (Zustand). Access token lives in memory; the refresh
// token (and user) persist to localStorage only when "keep me signed in" was
// checked, so a shared machine can stay clean.
//
// Refresh tokens are single-use server-side (rotation), so refreshing is
// guarded three ways: a single-flight promise (concurrent 401s from parallel
// requests must not race each other), re-reading localStorage first (another
// tab may have rotated already — adopt its token instead of burning it), and
// only destroying local state when the server actually rejected the token —
// a network blip must never log out a persisted session.

import { create } from "zustand";
import { api, ApiError, type UserDto } from "../lib/api.js";

const STORAGE_KEY = "eb.auth";

interface PersistedAuth {
  user: UserDto;
  refreshToken: string;
}

/**
 * Why a refresh ended, because "false" was never one answer: only `rejected`
 * (the server refused the token) means the session is gone. `unavailable` —
 * network down, 5xx, a proxy blip — is a verdict we never got, and callers
 * must treat it as "try again later" rather than as a sign-out.
 */
export type RefreshOutcome = "ok" | "rejected" | "unavailable";

interface AuthState {
  user: UserDto | undefined;
  accessToken: string | undefined;
  refreshToken: string | undefined;
  remember: boolean;
  /** "restoring" while a persisted session revalidates on boot. */
  status: "restoring" | "anonymous" | "authenticated";

  login: (input: {
    email: string;
    password: string;
    remember: boolean;
  }) => Promise<void>;
  logout: () => Promise<void>;
  /** Rotates the refresh token. */
  refreshSession: () => Promise<RefreshOutcome>;
  /** Boot: revalidate a persisted session, if any. */
  restore: () => Promise<void>;
}

function loadPersisted(): PersistedAuth | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? undefined : (JSON.parse(raw) as PersistedAuth);
  } catch {
    return undefined;
  }
}

function persist(state: {
  user: UserDto | undefined;
  refreshToken: string | undefined;
  remember: boolean;
}): void {
  if (state.remember && state.user && state.refreshToken) {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ user: state.user, refreshToken: state.refreshToken }),
    );
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/** Single-flight guard: all concurrent callers await one rotation. */
let refreshInFlight: Promise<RefreshOutcome> | undefined;

export const useAuthStore = create<AuthState>()((set, get) => ({
  user: undefined,
  accessToken: undefined,
  refreshToken: undefined,
  remember: false,
  status: loadPersisted() ? "restoring" : "anonymous",

  async login({ email, password, remember }) {
    const session = await api.login({ email, password });
    set({
      user: session.user,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      remember,
      status: "authenticated",
    });
    persist(get());
  },

  async logout() {
    const { refreshToken } = get();
    set({
      user: undefined,
      accessToken: undefined,
      refreshToken: undefined,
      status: "anonymous",
    });
    localStorage.removeItem(STORAGE_KEY);
    if (refreshToken) {
      try {
        await api.logout(refreshToken);
      } catch {
        // Session may already be gone server-side; local state is cleared.
      }
    }
  },

  async refreshSession() {
    refreshInFlight ??= (async () => {
      // Another tab may have rotated the token since we loaded ours — using
      // the stale one would burn the session, so adopt the persisted one.
      const persisted = loadPersisted();
      const refreshToken = persisted?.refreshToken ?? get().refreshToken;
      if (!refreshToken) {
        return "rejected"; // nothing to rotate — as final as a refusal
      }
      try {
        const rotated = await api.refresh(refreshToken);
        set({
          accessToken: rotated.accessToken,
          refreshToken: rotated.refreshToken,
          status: "authenticated",
        });
        persist(get());
        return "ok";
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 401) {
          // Only a 401 means the session is really gone. Any other failure —
          // network, 5xx, a proxy blip — must keep the persisted session so
          // a later call retries (E2E hang diagnosis: destroying it here is
          // a logout over a transient).
          set({
            user: undefined,
            accessToken: undefined,
            refreshToken: undefined,
            status: "anonymous",
          });
          localStorage.removeItem(STORAGE_KEY);
          return "rejected";
        }
        return "unavailable";
      }
    })().finally(() => {
      refreshInFlight = undefined;
    });
    return refreshInFlight;
  },

  async restore() {
    const persisted = loadPersisted();
    if (!persisted) {
      set({ status: "anonymous" });
      return;
    }
    set({
      user: persisted.user,
      refreshToken: persisted.refreshToken,
      remember: true,
    });
    // Boot has to reach a verdict either way: an unreachable server leaves
    // the login form, but keeps the persisted token, so the next boot picks
    // the session back up without a password.
    if ((await get().refreshSession()) !== "ok") {
      set({ status: "anonymous" });
    }
  },
}));

// A rotation done in another tab replaces the persisted token; adopt it so
// this tab's next refresh doesn't burn the session with the stale one.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) {
      return;
    }
    const persisted = loadPersisted();
    if (persisted && useAuthStore.getState().status === "authenticated") {
      useAuthStore.setState({ refreshToken: persisted.refreshToken });
    }
  });
}
