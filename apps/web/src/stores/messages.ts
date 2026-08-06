// Per-conversation message buffers (architecture.md §Client): windowed so
// neither the store nor the DOM grows unbounded. Live messages append via
// gateway events (exactly-once, deduped by messages.id); the initial page
// loads via REST, scroll-back pages ride the gateway (history.page, #254)
// and prepend. The highest buffered id per conversation doubles as the
// gateway resume cursor.

import { create } from "zustand";
import type { MessageDto } from "@emberchat/protocol";
// Circular with socket.ts (it imports resumeCursorsFor) — safe: both sides
// only touch the other's exports at call time, never at module eval.
import { gateway } from "../gateway/socket.js";
import { api } from "../lib/api.js";

/** Keep at most this many rows per conversation; older rows re-load via REST. */
export const BUFFER_WINDOW = 1500;
/**
 * Hard ceiling for a back-scrolled buffer. `loadOlder` prepends pages with no
 * front-trim (the newest rows must stay live-appendable), so a deep scroll-back
 * would otherwise inflate the array without bound — and every live append then
 * re-renders the whole thing (#356). When a merged page crosses this, drop the
 * newest rows (the ones the user has scrolled away from) and detach the tail so
 * the existing "Back to present" affordance restores the live view.
 */
export const SCROLLBACK_CEILING = BUFFER_WINDOW * 4;
/** REST page size for backfill and scroll-up. */
export const PAGE_SIZE = 50;
/** Keep at most this many join/part/quit lines per conversation. */
export const PRESENCE_WINDOW = 200;

/**
 * A live-only join/part/quit line (M5): synthesized client-side from the
 * member events, never persisted — a reload starts clean. Timestamps are
 * the client clock, which is exactly what "it just happened" means here.
 */
export interface PresenceLine {
  key: string;
  kind: "join" | "part" | "quit";
  character: string;
  /** ISO timestamp. */
  createdAt: string;
}

export interface ConvBuffer {
  /** Ascending by id. */
  messages: MessageDto[];
  /** Live-only join/part/quit lines, ascending by time. */
  presence: PresenceLine[];
  /** Older history exists beyond the buffer's start. */
  hasMoreBefore: boolean;
  /** Initial REST page loaded — the log can render. */
  backfilled: boolean;
  loadingOlder: boolean;
  /** Viewing history after a search jump (M9): the live tail is NOT in
   * this buffer, so live appends are skipped (they would leave a hole) —
   * "Back to present" reloads the tail. */
  detachedTail: boolean;
}

interface MessagesState {
  buffers: Record<string, ConvBuffer>;
  /** Search hit awaiting scroll-to-and-flash in the log (M9). */
  jumpTarget: { convId: string; messageId: number } | undefined;
  /**
   * A composer send the log has not yet treated as a catch-up gesture (#415
   * family). Sending is the user saying "I don't care about the old history,
   * I want to be in the new one", so the log lands at the tail and clears the
   * unread state exactly like Esc / scrolling down does. The composer and the
   * log are siblings — this is their seam, the same species of view intent as
   * `jumpTarget` above.
   *
   * Only immediate sends raise it, on the gateway ack rather than the server
   * echo: the gesture is the SUBMIT, and the echo can lag. Deliberately NOT
   * raised by a delayed send releasing from the outbox later (nor by a recall,
   * a preview, or typing) — a message scheduled hours ago is not a
   * present-tense gesture and must not silently eat unread the user never saw.
   */
  sendCatchUp: { convId: string } | undefined;

  appendLive(convId: string, message: MessageDto): void;
  appendMany(convId: string, messages: MessageDto[]): void;
  /**
   * An already-buffered row changed server-side (#491: a DM the server
   * refused, or its failure clearing on a retry). Replaces in place, keyed
   * by id — never inserts, so a row scrolled out of the window (or in a
   * detached view) is simply not there to update, and the next load brings
   * the current state anyway.
   */
  applyUpdate(convId: string, message: MessageDto): void;
  /**
   * Replace a conversation's buffer with a fresh window (catchup gap): the
   * old prefix is non-contiguous with the replay and would be an unreachable
   * hole, so drop it and mark the missed span as scroll-back-reachable.
   */
  resetTo(convId: string, messages: MessageDto[]): void;
  appendPresence(
    convId: string,
    kind: PresenceLine["kind"],
    character: string,
  ): void;
  /** Initial page for a conversation (latest PAGE_SIZE via REST). */
  backfill(identityId: string, convId: string): Promise<void>;
  /** Scroll-up: one older page before the current buffer start. */
  loadOlder(identityId: string, convId: string): Promise<number>;
  /** Land the log on the page containing a search hit (M9). */
  jumpTo(identityId: string, convId: string, messageId: number): Promise<void>;
  /** The composer handed an immediate send off — see `sendCatchUp`. */
  noteSendCatchUp(convId: string): void;
  /** The log has acted on the send gesture; it must not fire again. */
  clearSendCatchUp(): void;
  /** Leave the detached history view: reload the live tail. */
  backToPresent(identityId: string, convId: string): Promise<void>;
  /**
   * The user navigated away from this conversation (#411). A search jump
   * leaves the buffer detached with a `jumpTarget` still set — both are
   * *view* state for a reading position the user has now left. Kept, they
   * strand the NEXT open of this conversation in old history: the log
   * remounts with a fresh scrolled-target ref and re-runs the old jump, and
   * the stale `detachedTail` disables the open-at-tail bottom-stick, so a
   * channel with a couple of unreads opens nowhere near its latest message.
   * Dropping the detached window makes the next open backfill the live tail.
   */
  leaveConversation(convId: string): void;
  reset(): void;
}

const EMPTY_BUFFER: ConvBuffer = {
  messages: [],
  presence: [],
  hasMoreBefore: false,
  backfilled: false,
  loadingOlder: false,
  detachedTail: false,
};

let presenceCounter = 0;

/** Per-conversation buffer epochs (M9 audit): every wholesale buffer
 * transition (jump, back-to-present, catch-up reset) bumps the epoch, and
 * every async load captures it at start and refuses to patch a buffer
 * whose epoch moved — a stale response landing after a transition would
 * otherwise stitch disjoint history pages into one buffer with a silent,
 * unreachable hole. */
const epochs = new Map<string, number>();

/** In-flight initial backfills by conversation. The log asks on mount AND
 * whenever `backfilled` clears under it, and back-to-present asks directly —
 * they must share one REST page instead of racing two. */
const backfilling = new Map<string, Promise<void>>();

function epochOf(convId: string): number {
  return epochs.get(convId) ?? 0;
}

function bumpEpoch(convId: string): number {
  const next = epochOf(convId) + 1;
  epochs.set(convId, next);
  return next;
}

/** Merge ascending & dedupe by id, then trim to the window from the front. */
function merge(existing: MessageDto[], incoming: MessageDto[]): MessageDto[] {
  const appended = appendIfNewer(existing, incoming);
  if (appended !== undefined) {
    return appended;
  }
  const byId = new Map<number, MessageDto>();
  for (const message of existing) {
    byId.set(message.id, message);
  }
  for (const message of incoming) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * The append case, which is what a live message almost always is: `incoming`
 * is itself ascending and starts after the last row we hold, so the result is
 * a concatenation — no dedupe to do and nothing out of order to sort (#560).
 *
 * `merge` is otherwise the only way into the buffer, and the buffer holds up
 * to `BUFFER_WINDOW` rows: one arriving message was costing 1500 Map
 * insertions and a full 1500-element sort. Undefined means "not an append" —
 * a prepended history page, a catch-up batch that overlaps, a re-delivery of
 * a row we already have — and the general path above handles those unchanged.
 */
function appendIfNewer(
  existing: MessageDto[],
  incoming: MessageDto[],
): MessageDto[] | undefined {
  if (incoming.length === 0) {
    return existing;
  }
  let previous = existing.at(-1)?.id ?? Number.NEGATIVE_INFINITY;
  for (const message of incoming) {
    if (message.id <= previous) {
      return undefined;
    }
    previous = message.id;
  }
  return existing.length === 0 ? [...incoming] : [...existing, ...incoming];
}

export const useMessagesStore = create<MessagesState>()((set, get) => {
  function patch(
    convId: string,
    update: (buffer: ConvBuffer) => ConvBuffer,
  ): void {
    set((state) => ({
      buffers: {
        ...state.buffers,
        [convId]: update(state.buffers[convId] ?? EMPTY_BUFFER),
      },
    }));
  }

  function put(convId: string, incoming: MessageDto[]): void {
    patch(convId, (buffer) => {
      let messages = merge(buffer.messages, incoming);
      let { hasMoreBefore } = buffer;
      if (messages.length > BUFFER_WINDOW) {
        messages = messages.slice(messages.length - BUFFER_WINDOW);
        hasMoreBefore = true; // the trimmed rows are still on the server
      }
      return { ...buffer, messages, hasMoreBefore };
    });
  }

  return {
    buffers: {},
    jumpTarget: undefined,
    sendCatchUp: undefined,

    appendLive(convId, message) {
      // Detached history view: a live append would leave an unreachable
      // hole between the old page and the new row. The message is safe on
      // the server; Back to present reloads it.
      if (get().buffers[convId]?.detachedTail) {
        return;
      }
      put(convId, [message]);
    },

    appendMany(convId, messages) {
      // Same reasoning as appendLive, and it bites here too (#432): a
      // detached conversation advertises no resume cursor, so the server
      // replays from the read cursor — a span that need not touch this
      // window at all. Merging it would stitch an unreachable interior hole
      // into the history the user is reading; Back to present reloads it.
      if (get().buffers[convId]?.detachedTail) {
        return;
      }
      put(convId, messages);
    },

    applyUpdate(convId, message) {
      const buffer = get().buffers[convId];
      if (!buffer?.messages.some((row) => row.id === message.id)) {
        return;
      }
      patch(convId, (current) => ({
        ...current,
        messages: current.messages.map((row) =>
          row.id === message.id ? message : row,
        ),
      }));
    },

    resetTo(convId, messages) {
      bumpEpoch(convId);
      patch(convId, (buffer) => ({
        ...buffer,
        messages: messages.slice(-BUFFER_WINDOW),
        // Older history is on the server but not in this window — scroll-up
        // walks the missed span contiguously from the oldest replayed id.
        hasMoreBefore: true,
        // The replay IS a usable window, so keep the buffer readable rather
        // than dropping the log back to "Loading…" (#432): `backfilled`
        // gates rendering AND every scroll-back path, and the log's initial
        // fetch is keyed by conversation — clearing this under a MOUNTED log
        // left the missed span unreachable until the user navigated away and
        // back. An empty replay has nothing to render, so it still asks.
        backfilled: messages.length > 0,
        // A catch-up replay IS the live tail — any detached view is over,
        // and a jump target pointing into the destroyed window with it.
        detachedTail: false,
      }));
      if (get().jumpTarget?.convId === convId) {
        set({ jumpTarget: undefined });
      }
    },

    appendPresence(convId, kind, character) {
      presenceCounter += 1;
      const line: PresenceLine = {
        key: `p:${String(presenceCounter)}`,
        kind,
        character,
        createdAt: new Date().toISOString(),
      };
      patch(convId, (buffer) => ({
        ...buffer,
        presence: [...buffer.presence, line].slice(-PRESENCE_WINDOW),
      }));
    },

    async backfill(identityId, convId) {
      if (get().buffers[convId]?.backfilled) {
        return;
      }
      const inFlight = backfilling.get(convId);
      if (inFlight) {
        return inFlight;
      }
      const epoch = epochOf(convId);
      const load = api
        .listMessages(identityId, convId, { limit: PAGE_SIZE })
        .then((page) => {
          if (epochOf(convId) !== epoch) {
            return; // the buffer transitioned while we fetched — stale page
          }
          patch(convId, (current) => ({
            ...current,
            // Live events may have raced the fetch — merge, don't replace.
            messages: merge(current.messages, page.messages),
            hasMoreBefore: page.hasMore,
            backfilled: true,
          }));
        });
      backfilling.set(convId, load);
      try {
        await load;
      } finally {
        backfilling.delete(convId);
      }
    },

    async loadOlder(identityId, convId) {
      const buffer = get().buffers[convId] ?? EMPTY_BUFFER;
      const oldest = buffer.messages[0];
      if (!buffer.hasMoreBefore || buffer.loadingOlder || !oldest) {
        return 0;
      }
      patch(convId, (current) => ({ ...current, loadingOlder: true }));
      const epoch = epochOf(convId);
      try {
        // Scroll-back pages ride the gateway (#254) and walk the FULL
        // stored history — there is no age cap; hasMore=false is the
        // exhaustion signal that stops further requests.
        const page = await gateway.cmd({
          identityId,
          action: "history.page",
          d: { convId, beforeId: oldest.id, limit: PAGE_SIZE },
        });
        if (!page.ok || page.messages === undefined) {
          throw new Error(page.error ?? "history page failed");
        }
        if (epochOf(convId) !== epoch) {
          return 0; // the window this page extends no longer exists
        }
        patch(convId, (current) => {
          let messages = merge(current.messages, page.messages ?? []);
          let { detachedTail } = current;
          if (messages.length > SCROLLBACK_CEILING) {
            // Keep the oldest rows (where the reader is) and drop the newest —
            // the live tail is now out of the buffer, so stop live appends and
            // let Back to present rebuild the window.
            messages = messages.slice(0, SCROLLBACK_CEILING);
            detachedTail = true;
          }
          return {
            ...current,
            messages,
            hasMoreBefore: page.hasMore ?? false,
            detachedTail,
          };
        });
        return page.messages.length;
      } finally {
        patch(convId, (current) => ({ ...current, loadingOlder: false }));
      }
    },

    async jumpTo(identityId, convId, messageId) {
      // Mark first, synchronously: a concurrent mount backfill must see
      // backfilled=true and skip; the epoch bump invalidates any load
      // already awaiting its response (audit HIGH — a stale page landing
      // after a later transition would stitch an unreachable hole).
      const epoch = bumpEpoch(convId);
      patch(convId, (buffer) => ({
        ...buffer,
        messages: [],
        hasMoreBefore: false,
        backfilled: true,
        detachedTail: true,
      }));
      set({ jumpTarget: { convId, messageId } });
      // `before` is exclusive — +1 keeps the target as the page's last row.
      const page = await api.listMessages(identityId, convId, {
        before: messageId + 1,
        limit: PAGE_SIZE,
      });
      if (epochOf(convId) !== epoch) {
        return; // superseded by back-to-present / another jump / a reset
      }
      patch(convId, (buffer) => ({
        ...buffer,
        messages: page.messages,
        hasMoreBefore: page.hasMore,
      }));
    },

    noteSendCatchUp(convId) {
      set({ sendCatchUp: { convId } });
    },

    clearSendCatchUp() {
      set({ sendCatchUp: undefined });
    },

    async backToPresent(identityId, convId) {
      bumpEpoch(convId);
      patch(convId, (buffer) => ({
        ...buffer,
        messages: [],
        hasMoreBefore: false,
        backfilled: false,
        detachedTail: false,
      }));
      set({ jumpTarget: undefined });
      await get().backfill(identityId, convId);
    },

    leaveConversation(convId) {
      if (get().jumpTarget?.convId === convId) {
        set({ jumpTarget: undefined });
      }
      // A send gesture the log never got to consume (a send followed
      // immediately by a switch) is spent — it must not fire on the next visit.
      if (get().sendCatchUp?.convId === convId) {
        set({ sendCatchUp: undefined });
      }
      if (get().buffers[convId]?.detachedTail !== true) {
        return;
      }
      // Same shape as backToPresent, minus the fetch: the next mount's
      // backfill effect loads the live tail. Bumping the epoch retires any
      // page still in flight for the abandoned window.
      bumpEpoch(convId);
      patch(convId, (buffer) => ({
        ...buffer,
        messages: [],
        hasMoreBefore: false,
        backfilled: false,
        detachedTail: false,
      }));
    },

    reset() {
      epochs.clear();
      backfilling.clear();
      set({ buffers: {}, jumpTarget: undefined, sendCatchUp: undefined });
    },
  };
});

/** Per-conversation resume cursors for the gateway hello of a reconnect. */
export function resumeCursorsFor(convIds: string[]): Record<string, number> {
  const { buffers } = useMessagesStore.getState();
  const cursors: Record<string, number> = {};
  for (const convId of convIds) {
    const buffer = buffers[convId];
    // A detached history view's newest row is an OLD message — advertising
    // it would trigger a huge replay or a gap reset mid-read (audit).
    // No cursor = the server treats the conv as fresh, which is truthful.
    if (buffer?.detachedTail) {
      continue;
    }
    const newest = buffer?.messages.at(-1);
    if (newest) {
      cursors[convId] = newest.id;
    }
  }
  return cursors;
}
