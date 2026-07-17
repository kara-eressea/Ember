// Profile viewer state (M8): which character the modal shows, the client
// cache of fetched profiles, the view-history rail, and the viewer's own
// profile (memoized per identity for kink tinting and, in step 9, the
// matcher). The server holds the durable cache + budget; this layer only
// dedups in-flight loads and keeps what the session already saw.

import { create } from "zustand";
import type { ProfileInsights, ProfileResponse } from "@emberchat/protocol";
import { api, ApiError } from "../lib/api.js";

export type ProfileLoadState = "loading" | "ok" | "notfound" | "budget";

export interface LoadedProfile {
  state: ProfileLoadState;
  response?: ProfileResponse;
  /** 404 reason / budget retry hint for the error states. */
  error?: string;
  retryAfterSeconds?: number;
}

export interface HistoryEntry {
  name: string;
  lastViewedAt: number;
}

/** Trigger bounding rect the mini card anchors to (§13: anchor to the
 * trigger, not the cursor, so repeated opens are stable). */
export interface CardAnchor {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

interface ProfileState {
  /** Character the viewer modal shows; undefined = closed. */
  viewing: string | undefined;
  activeTab:
    | "overview"
    | "details"
    | "kinks"
    | "compare"
    | "insights"
    | "images"
    | "guestbook";
  /** The mini profile card popover; undefined = closed. Only one at a time. */
  card: { name: string; anchor: CardAnchor } | undefined;
  /** Keyed by lowercased name — session-lifetime client cache. */
  profiles: Record<string, LoadedProfile>;
  /** Recently-viewed rail, most recent first (server is source of truth). */
  history: HistoryEntry[];
  insights: Record<string, ProfileInsights>;
  /** The viewing identity's own profile, for kink tints + the matcher. */
  ownProfile: ProfileResponse | undefined;

  open: (name: string) => void;
  close: () => void;
  setTab: (tab: ProfileState["activeTab"]) => void;
  openCard: (name: string, anchor: CardAnchor) => void;
  closeCard: () => void;
}

export const useProfileStore = create<ProfileState>()((set) => ({
  viewing: undefined,
  activeTab: "overview",
  card: undefined,
  profiles: {},
  history: [],
  insights: {},
  ownProfile: undefined,

  open(name) {
    // Opening the full viewer dismisses the popover (§13 hand-off).
    set({ viewing: name, activeTab: "overview", card: undefined });
  },
  close() {
    set({ viewing: undefined });
  },
  setTab(tab) {
    set({ activeTab: tab });
  },
  openCard(name, anchor) {
    set({ card: { name, anchor } });
  },
  closeCard() {
    set({ card: undefined });
  },
}));

/** Open the mini card anchored to a trigger element's bounding rect. */
export function openCardFrom(element: Element, name: string): void {
  const rect = element.getBoundingClientRect();
  useProfileStore.getState().openCard(name, {
    top: rect.top,
    left: rect.left,
    bottom: rect.bottom,
    right: rect.right,
  });
}

const inflight = new Map<string, Promise<void>>();

/** Fetch-through-cache with in-flight dedup. `refresh` forces the server to
 * bypass its TTL (still budget-gated there). */
export function loadProfile(
  identityId: string,
  name: string,
  refresh = false,
): Promise<void> {
  const lower = name.toLowerCase();
  const cached = useProfileStore.getState().profiles[lower];
  if (cached && cached.state !== "loading" && !refresh) {
    // Still bump the rail — the server records the view on its own GET, but
    // a client-cache hit never reaches it, so mirror locally.
    touchHistory(name);
    return Promise.resolve();
  }
  const key = `${identityId}:${lower}`;
  const running = inflight.get(key);
  if (running && !refresh) {
    return running;
  }
  setProfile(lower, { state: "loading", response: cached?.response });
  const load = api
    .getProfile(identityId, name, refresh)
    .then((response) => {
      setProfile(lower, { state: "ok", response });
      touchHistory(response.profile.name);
    })
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) {
        setProfile(lower, { state: "notfound", error: error.message });
        return;
      }
      if (error instanceof ApiError && error.status === 429) {
        setProfile(lower, {
          state: "budget",
          error: error.message,
          response: cached?.response,
        });
        return;
      }
      setProfile(lower, {
        state: "notfound",
        error: error instanceof Error ? error.message : "Profile fetch failed",
        response: cached?.response,
      });
    })
    .finally(() => {
      if (inflight.get(key) === load) {
        inflight.delete(key);
      }
    });
  inflight.set(key, load);
  return load;
}

function setProfile(lower: string, loaded: LoadedProfile): void {
  useProfileStore.setState((state) => ({
    profiles: { ...state.profiles, [lower]: loaded },
  }));
}

function touchHistory(name: string): void {
  useProfileStore.setState((state) => ({
    history: [
      { name, lastViewedAt: Date.now() },
      ...state.history.filter(
        (entry) => entry.name.toLowerCase() !== name.toLowerCase(),
      ),
    ],
  }));
}

export async function loadHistory(identityId: string): Promise<void> {
  const { history } = await api.getProfileHistory(identityId);
  useProfileStore.setState({
    history: history.map((entry) => ({
      name: entry.name,
      lastViewedAt: entry.lastViewedAt,
    })),
  });
}

export async function removeHistoryEntry(
  identityId: string,
  name: string,
): Promise<void> {
  useProfileStore.setState((state) => ({
    history: state.history.filter(
      (entry) => entry.name.toLowerCase() !== name.toLowerCase(),
    ),
  }));
  await api.deleteProfileHistory(identityId, name).catch(() => {
    // Rail deletion is cosmetic; a failed delete resurfaces on next load.
  });
}

export async function loadInsights(
  identityId: string,
  name: string,
): Promise<void> {
  const insights = await api.getProfileInsights(identityId, name);
  useProfileStore.setState((state) => ({
    insights: { ...state.insights, [name.toLowerCase()]: insights },
  }));
}

const ownInflight = new Map<string, Promise<void>>();

/** The identity's own profile, once per identity per session. */
export function loadOwnProfile(
  identityId: string,
  character: string,
): Promise<void> {
  const existing = useProfileStore.getState().ownProfile;
  if (existing && existing.profile.name === character) {
    return Promise.resolve();
  }
  const running = ownInflight.get(identityId);
  if (running) {
    return running;
  }
  const load = api
    .getProfile(identityId, character)
    .then((response) => {
      useProfileStore.setState({ ownProfile: response });
    })
    .catch(() => {
      // Absent own profile only means no kink tints / no compare — fine.
    })
    .finally(() => {
      ownInflight.delete(identityId);
    });
  ownInflight.set(identityId, load);
  return load;
}

/** Debounced note autosave (design: no save button). */
const noteTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function saveNoteDebounced(
  identityId: string,
  name: string,
  note: string,
  onSaved: () => void,
): void {
  const key = `${identityId}:${name.toLowerCase()}`;
  const existing = noteTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  noteTimers.set(
    key,
    setTimeout(() => {
      noteTimers.delete(key);
      api
        .putProfileNote(identityId, name, note)
        .then(onSaved)
        .catch(() => {
          // Autosave failure: the editor keeps the text; next edit retries.
        });
    }, 600),
  );
}
