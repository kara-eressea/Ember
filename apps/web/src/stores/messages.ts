// Per-conversation message buffers (architecture.md §Client): windowed so
// neither the store nor the DOM grows unbounded. Live messages append via
// gateway events (exactly-once, deduped by messages.id); history loads via
// REST cursor pagination and prepends. The highest buffered id per
// conversation doubles as the gateway resume cursor.

import { create } from "zustand";
import type { MessageDto } from "@emberline/protocol";
import { api } from "../lib/api.js";

/** Keep at most this many rows per conversation; older rows re-load via REST. */
export const BUFFER_WINDOW = 1500;
/** REST page size for backfill and scroll-up. */
export const PAGE_SIZE = 50;

export interface ConvBuffer {
  /** Ascending by id. */
  messages: MessageDto[];
  /** Older history exists beyond the buffer's start. */
  hasMoreBefore: boolean;
  /** Initial REST page loaded — the log can render. */
  backfilled: boolean;
  loadingOlder: boolean;
}

interface MessagesState {
  buffers: Record<string, ConvBuffer>;

  appendLive(convId: string, message: MessageDto): void;
  appendMany(convId: string, messages: MessageDto[]): void;
  /** Initial page for a conversation (latest PAGE_SIZE via REST). */
  backfill(identityId: string, convId: string): Promise<void>;
  /** Scroll-up: one older page before the current buffer start. */
  loadOlder(identityId: string, convId: string): Promise<number>;
  reset(): void;
}

const EMPTY_BUFFER: ConvBuffer = {
  messages: [],
  hasMoreBefore: false,
  backfilled: false,
  loadingOlder: false,
};

/** Merge ascending & dedupe by id, then trim to the window from the front. */
function merge(existing: MessageDto[], incoming: MessageDto[]): MessageDto[] {
  const byId = new Map<number, MessageDto>();
  for (const message of existing) {
    byId.set(message.id, message);
  }
  for (const message of incoming) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
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

    appendLive(convId, message) {
      put(convId, [message]);
    },

    appendMany(convId, messages) {
      put(convId, messages);
    },

    async backfill(identityId, convId) {
      const buffer = get().buffers[convId];
      if (buffer?.backfilled) {
        return;
      }
      const page = await api.listMessages(identityId, convId, {
        limit: PAGE_SIZE,
      });
      patch(convId, (current) => ({
        ...current,
        // Live events may have raced the fetch — merge, don't replace.
        messages: merge(current.messages, page.messages),
        hasMoreBefore: page.hasMore,
        backfilled: true,
      }));
    },

    async loadOlder(identityId, convId) {
      const buffer = get().buffers[convId] ?? EMPTY_BUFFER;
      const oldest = buffer.messages[0];
      if (!buffer.hasMoreBefore || buffer.loadingOlder || !oldest) {
        return 0;
      }
      patch(convId, (current) => ({ ...current, loadingOlder: true }));
      try {
        const page = await api.listMessages(identityId, convId, {
          before: oldest.id,
          limit: PAGE_SIZE,
        });
        patch(convId, (current) => ({
          ...current,
          messages: merge(current.messages, page.messages),
          hasMoreBefore: page.hasMore,
        }));
        return page.messages.length;
      } finally {
        patch(convId, (current) => ({ ...current, loadingOlder: false }));
      }
    },

    reset() {
      set({ buffers: {} });
    },
  };
});

/** Per-conversation resume cursors for the gateway hello of a reconnect. */
export function resumeCursorsFor(convIds: string[]): Record<string, number> {
  const { buffers } = useMessagesStore.getState();
  const cursors: Record<string, number> = {};
  for (const convId of convIds) {
    const newest = buffers[convId]?.messages.at(-1);
    if (newest) {
      cursors[convId] = newest.id;
    }
  }
  return cursors;
}
