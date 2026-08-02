// Profile viewer state (M8): which character the modal shows, the client
// cache of fetched profiles, the view-history rail, and the viewer's own
// profile (memoized per identity for kink tinting and, in step 9, the
// matcher). The server holds the durable cache + budget; this layer only
// dedups in-flight loads and keeps what the session already saw.

import { create } from "zustand";
import type {
  ProfileActivity,
  ProfileInsights,
  ProfileResponse,
} from "@emberchat/protocol";
import { api, ApiError } from "../lib/api.js";

/** "error" = network/server trouble, distinct from a genuine 404 — a
 * transient outage must not read as "this character doesn't exist". */
export type ProfileLoadState =
  "loading" | "ok" | "notfound" | "budget" | "error";

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
 * trigger, not the cursor, so repeated opens are stable). Client-rect
 * coordinates — visual pixels, see popover.ts on the zoom correction. */
export interface CardAnchor {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** The open mini card: the trigger's rect at open time plus the trigger
 * itself, so the card can re-measure while the log scrolls underneath it
 * (the rect alone goes stale the moment anything moves). */
export interface OpenCard {
  name: string;
  anchor: CardAnchor;
  /** Undefined when opened without a live element (tests, future call
   * sites) — the card then keeps using the snapshot rect. */
  element?: Element;
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
  card: OpenCard | undefined;
  /** Keyed by lowercased name — session-lifetime client cache. */
  profiles: Record<string, LoadedProfile>;
  /** Recently-viewed rail, most recent first (server is source of truth). */
  history: HistoryEntry[];
  /** "error" = the fetch failed; the tab offers a Retry (audit M2). */
  insights: Record<string, ProfileInsights | "error">;
  /** Activity heatmap buckets, same keying and "error" sentinel as insights. */
  activity: Record<string, ProfileActivity | "error">;
  /** The viewing identity's own profile, for kink tints + the matcher. */
  ownProfile: ProfileResponse | undefined;
  /** Why the last own-profile load failed — the Compare tab surfaces this
   * instead of claiming forever that the profile "hasn't loaded yet". */
  ownProfileError: string | undefined;

  open: (name: string) => void;
  close: () => void;
  setTab: (tab: ProfileState["activeTab"]) => void;
  openCard: (name: string, anchor: CardAnchor, element?: Element) => void;
  closeCard: () => void;
  /** Close from an outside pointerdown; `target` is what was pressed. */
  dismissCard: (target: Node | undefined) => void;
}

export const useProfileStore = create<ProfileState>()((set, get) => ({
  viewing: undefined,
  activeTab: "overview",
  card: undefined,
  profiles: {},
  history: [],
  insights: {},
  activity: {},
  ownProfile: undefined,
  ownProfileError: undefined,

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
  openCard(name, anchor, element) {
    set({ card: { name, anchor, element } });
  },
  closeCard() {
    dismissedTrigger = undefined;
    set({ card: undefined });
  },
  dismissCard(target) {
    const open = get().card;
    // Remember only a dismissal that landed on the card's OWN trigger: the
    // click that follows this pointerdown then re-opens nothing, so a second
    // click on the same name toggles the card shut. A press on any other
    // name still closes this card and opens that one in the one gesture
    // (there is no click-eating overlay any more).
    dismissedTrigger =
      open?.element && target && open.element.contains(target)
        ? open.element
        : undefined;
    set({ card: undefined });
  },
}));

/** Trigger whose own pointerdown just dismissed the card, consumed by the
 * click that follows in the same gesture. */
let dismissedTrigger: Element | undefined;

/** Open the mini card anchored to a trigger element (§13: the trigger, not
 * the cursor, so repeated opens are stable). */
export function openCardFrom(element: Element, name: string): void {
  const dismissed = dismissedTrigger;
  dismissedTrigger = undefined;
  if (dismissed === element) {
    return;
  }
  const rect = element.getBoundingClientRect();
  useProfileStore.getState().openCard(
    name,
    {
      top: rect.top,
      left: rect.left,
      bottom: rect.bottom,
      right: rect.right,
    },
    element,
  );
}

/** The trigger's live rect, or undefined once it has left the document
 * (virtualized away, conversation switched) — the card closes then rather
 * than floating at stale coordinates. */
export function liveAnchor(
  element: Element | undefined,
): CardAnchor | undefined {
  if (!element?.isConnected) {
    return undefined;
  }
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    bottom: rect.bottom,
    right: rect.right,
  };
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
  // Handlers write only while still the request of record: a refresh
  // replaces the inflight entry, and a superseded response landing late
  // must not clobber the fresher one (audit M4).
  const load: Promise<void> = api
    .getProfile(identityId, name, refresh)
    .then((response) => {
      if (inflight.get(key) !== load) {
        return;
      }
      setProfile(lower, { state: "ok", response });
      touchHistory(response.profile.name);
    })
    .catch((error: unknown) => {
      if (inflight.get(key) !== load) {
        return;
      }
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
        state: "error",
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
  try {
    const { history } = await api.getProfileHistory(identityId);
    useProfileStore.setState({
      history: history.map((entry) => ({
        name: entry.name,
        lastViewedAt: entry.lastViewedAt,
      })),
    });
  } catch {
    // The rail keeps its local mirror; the next viewer open retries.
  }
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
  const lower = name.toLowerCase();
  try {
    const insights = await api.getProfileInsights(identityId, name);
    useProfileStore.setState((state) => ({
      insights: { ...state.insights, [lower]: insights },
    }));
  } catch {
    useProfileStore.setState((state) => ({
      insights: { ...state.insights, [lower]: "error" },
    }));
  }
}

/** Clear a failed insights entry so the tab shows the shimmer again. */
export function resetInsights(name: string): void {
  useProfileStore.setState((state) => {
    const next = { ...state.insights };
    delete next[name.toLowerCase()];
    return { insights: next };
  });
}

/** The viewer's own zone — the axis the heatmap is drawn on, so the server
 * buckets in it rather than the client re-bucketing UTC counts. */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export async function loadActivity(
  identityId: string,
  name: string,
): Promise<void> {
  const lower = name.toLowerCase();
  try {
    const activity = await api.getProfileActivity(
      identityId,
      name,
      viewerTimeZone(),
    );
    useProfileStore.setState((state) => ({
      activity: { ...state.activity, [lower]: activity },
    }));
  } catch {
    useProfileStore.setState((state) => ({
      activity: { ...state.activity, [lower]: "error" },
    }));
  }
}

/** Clear a failed activity entry so the grid retries from the shimmer. */
export function resetActivity(name: string): void {
  useProfileStore.setState((state) => {
    const next = { ...state.activity };
    delete next[name.toLowerCase()];
    return { activity: next };
  });
}

/** Save (or clear, with null) the timezone the user set for a character.
 * Mirrors the note's write-through so every surface repaints without a
 * refetch (#170). */
export async function saveTimezone(
  identityId: string,
  name: string,
  timezone: string | null,
): Promise<void> {
  await api.putProfileTimezone(identityId, name, timezone);
  const lower = name.toLowerCase();
  const cached = useProfileStore.getState().profiles[lower];
  if (cached?.response) {
    setProfile(lower, {
      ...cached,
      response: { ...cached.response, timezone },
    });
  }
}

const ownInflight = new Map<string, Promise<void>>();

/** The identity's own profile, once per identity per session. `retry`
 * forces a new attempt after a failure (Compare tab's Retry). */
export function loadOwnProfile(
  identityId: string,
  character: string,
  retry = false,
): Promise<void> {
  const existing = useProfileStore.getState().ownProfile;
  if (
    existing &&
    existing.profile.name.toLowerCase() === character.toLowerCase()
  ) {
    return Promise.resolve();
  }
  const running = ownInflight.get(identityId);
  if (running && !retry) {
    return running;
  }
  const load = api
    .getProfile(identityId, character)
    .then((response) => {
      if (ownInflight.get(identityId) !== load) {
        return;
      }
      useProfileStore.setState({
        ownProfile: response,
        ownProfileError: undefined,
      });
    })
    .catch((error: unknown) => {
      if (ownInflight.get(identityId) !== load) {
        return;
      }
      // No own profile only means no kink tints and no compare — record
      // why so the Compare tab can say so instead of "loading" forever.
      useProfileStore.setState({
        ownProfileError:
          error instanceof Error
            ? error.message
            : "Your own profile could not be loaded",
      });
    })
    .finally(() => {
      if (ownInflight.get(identityId) === load) {
        ownInflight.delete(identityId);
      }
    });
  ownInflight.set(identityId, load);
  return load;
}

/** Note autosave (design: no save button). `onSaved`/`onError` drive the
 * editor's ✓ Saved / ⚠ Not saved chip. A failed write never drops the text —
 * the editor keeps it and the next edit (or blur flush) retries. */
export interface NoteSaveCallbacks {
  onSaved?: () => void;
  onError?: () => void;
}

const noteTimers = new Map<string, ReturnType<typeof setTimeout>>();

function noteKey(identityId: string, name: string): string {
  return `${identityId}:${name.toLowerCase()}`;
}

function putNote(
  identityId: string,
  name: string,
  note: string,
  callbacks: NoteSaveCallbacks,
): void {
  api
    .putProfileNote(identityId, name, note)
    .then(() => {
      // Keep the cached profile response in step so reopening the surface
      // (or the other surface) shows the saved note without a refetch — the
      // one-source-of-truth guarantee (#170).
      const lower = name.toLowerCase();
      const cached = useProfileStore.getState().profiles[lower];
      if (cached?.response) {
        setProfile(lower, {
          ...cached,
          response: { ...cached.response, note: note === "" ? null : note },
        });
      }
      callbacks.onSaved?.();
    })
    .catch(() => {
      callbacks.onError?.();
    });
}

/** Debounced save while typing (≈600ms idle). */
export function saveNoteDebounced(
  identityId: string,
  name: string,
  note: string,
  callbacks: NoteSaveCallbacks = {},
): void {
  const key = noteKey(identityId, name);
  const existing = noteTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  noteTimers.set(
    key,
    setTimeout(() => {
      noteTimers.delete(key);
      putNote(identityId, name, note, callbacks);
    }, 600),
  );
}

/** Immediate save (on blur / Escape): cancels any pending debounce and
 * commits now, so an empty-on-blur note deletes the record without waiting. */
export function saveNoteNow(
  identityId: string,
  name: string,
  note: string,
  callbacks: NoteSaveCallbacks = {},
): void {
  const key = noteKey(identityId, name);
  const existing = noteTimers.get(key);
  if (existing) {
    clearTimeout(existing);
    noteTimers.delete(key);
  }
  putNote(identityId, name, note, callbacks);
}
