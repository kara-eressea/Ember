// App-account session (Zustand). Access token lives in memory; the refresh
// token (and user) persist to localStorage only when "keep me signed in" was
// checked, so a shared machine can stay clean.
//
// Refresh tokens are single-use server-side (rotation), so refreshing is
// guarded four ways: a single-flight promise (concurrent 401s from parallel
// requests must not race each other), re-reading localStorage first (another
// tab may have rotated already — adopt its token instead of burning it), a
// BroadcastChannel that keeps two tabs from rotating at once at all (see
// below), and only destroying local state when the server actually rejected
// the token — a network blip must never log out a persisted session.

import { create } from "zustand";
import { api, ApiError, type UserDto } from "../lib/api.js";
import { forgetPushOnLogout } from "../lib/push.js";

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

// ── Cross-tab coordination ────────────────────────────────────────────────
// The single-flight guard above is per tab, and two tabs of the same profile
// refresh on their own schedules — both on boot, both when the access token
// expires. The server's 30 s rotation grace (#456) means the loser of such a
// race is not logged out on the spot, but it does NOT make the collision
// harmless: the grace path issues its own new token, so after A rotates
// T0→T1 and B redeems T0→T2, A is holding a token the server has already
// replaced. Whichever tab wrote localStorage last decides what the storage
// listener then hands the other one, and that can be the dead half of the
// pair — one shared 401 later, both tabs are on the login screen.
//
// So: don't collide. A tab about to rotate says so; a tab that hears it waits
// for the outcome instead of starting its own; every completed rotation is
// broadcast so peers adopt the live pair — including the access token, which
// the localStorage mirror does not carry. The grace window stays what it was
// meant to be, the net for a lost response, rather than load-bearing.
//
// Two tabs that reach for the token in the same tick can still both go: the
// channel delivers asynchronously, so neither hears the other's claim before
// it commits. That residue is what the grace window is for, and it is why the
// last-writer rule below (a rotation older than the one this tab already took
// is dropped) matters — the pair converges on the newer token either way.
//
// Only successes are broadcast. A rejection is deliberately kept local: the
// one tab that has to refuse a token is exactly the tab whose token was
// superseded, and telling a peer holding the live token to sign out would
// turn one tab's bad luck into everyone's logout.
//
// Where BroadcastChannel is absent — SSR, jsdom, an old engine — nothing here
// runs and the store behaves exactly as it did before.

const CHANNEL_NAME = "eb.auth";
/** How long to wait on a peer's announced rotation before rotating anyway.
 * Well inside ROTATION_GRACE_MS, so a peer that dies mid-request still leaves
 * this tab time to redeem the token it already has. */
const PEER_WAIT_MS = 5_000;

type AuthMessage =
  | { type: "refresh-started"; at: number; userId: string }
  | {
      type: "refresh-ok";
      at: number;
      userId: string;
      accessToken: string;
      refreshToken: string;
    };

const channel: BroadcastChannel | undefined =
  typeof BroadcastChannel === "undefined"
    ? undefined
    : new BroadcastChannel(CHANNEL_NAME);

/** When this tab last took a rotation (its own or a peer's). Out-of-order
 * deliveries are dropped against it, so two tabs that did collide still
 * converge on the newer of the two tokens rather than on the last message to
 * arrive. */
let lastRotationAt = 0;
/** The peer rotation this tab is deferring to, armed by "refresh-started". */
let peerRotation:
  | {
      settle: (message?: AuthMessage) => void;
      waited: Promise<AuthMessage | undefined>;
    }
  | undefined;

function adopt(message: Extract<AuthMessage, { type: "refresh-ok" }>): void {
  lastRotationAt = message.at;
  useAuthStore.setState({
    accessToken: message.accessToken,
    refreshToken: message.refreshToken,
    status: "authenticated",
  });
  persist(useAuthStore.getState());
}

function armPeerRotation(): void {
  peerRotation?.settle();
  let settle: (message?: AuthMessage) => void = () => {};
  const waited = new Promise<AuthMessage | undefined>((resolve) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, PEER_WAIT_MS);
    settle = (message) => {
      clearTimeout(timer);
      resolve(message);
    };
  });
  const armed = { settle, waited };
  peerRotation = armed;
  void waited.finally(() => {
    if (peerRotation === armed) {
      peerRotation = undefined;
    }
  });
}

/** Await a peer's in-flight rotation, if one was announced. Resolves to its
 * result — already adopted by the listener — or to undefined, which means
 * "nobody else is doing this, go ahead". */
async function peerRotated(): Promise<boolean> {
  const pending = peerRotation;
  if (!pending) {
    return false;
  }
  return (await pending.waited)?.type === "refresh-ok";
}

channel?.addEventListener("message", (event) => {
  const message = (event as MessageEvent<AuthMessage>).data;
  const state = useAuthStore.getState();
  // A tab that isn't signed in (or is signed in as somebody else, which the
  // shared localStorage makes unlikely but not impossible mid-switch) has no
  // business adopting a token.
  if (state.status === "anonymous" || message.userId !== state.user?.id) {
    return;
  }
  if (message.type === "refresh-started") {
    armPeerRotation();
    return;
  }
  peerRotation?.settle(message);
  if (message.at > lastRotationAt) {
    adopt(message);
  }
});

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
    // Take this browser's push registration down with the session. The row is
    // already gone server-side (it cascades off the auth session), so this is
    // purely local hygiene — and it is deliberately not awaited: a signed-out
    // user is signed out now, whatever the service worker is doing about it.
    void forgetPushOnLogout();
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
      // A peer tab is already rotating: its result is this tab's result too,
      // and the listener adopts the pair as it lands. Waiting beats racing —
      // see the cross-tab section above for what a race actually costs.
      if (await peerRotated()) {
        return "ok";
      }
      // Another tab may have rotated the token since we loaded ours — using
      // the stale one would burn the session, so adopt the persisted one.
      const persisted = loadPersisted();
      const refreshToken = persisted?.refreshToken ?? get().refreshToken;
      if (!refreshToken) {
        return "rejected"; // nothing to rotate — as final as a refusal
      }
      const userId = get().user?.id;
      if (userId !== undefined) {
        channel?.postMessage({
          type: "refresh-started",
          at: Date.now(),
          userId,
        } satisfies AuthMessage);
      }
      try {
        const rotated = await api.refresh(refreshToken);
        lastRotationAt = Date.now();
        set({
          accessToken: rotated.accessToken,
          refreshToken: rotated.refreshToken,
          status: "authenticated",
        });
        persist(get());
        if (userId !== undefined) {
          channel?.postMessage({
            type: "refresh-ok",
            at: lastRotationAt,
            userId,
            accessToken: rotated.accessToken,
            refreshToken: rotated.refreshToken,
          } satisfies AuthMessage);
        }
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
