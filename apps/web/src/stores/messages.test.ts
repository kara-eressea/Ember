// Buffer mechanics: id-dedupe merge, the window cap marking trimmed history
// as re-loadable, and resume cursors.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageDto } from "@emberchat/protocol";
import { gateway } from "../gateway/socket.js";
import { api } from "../lib/api.js";
import {
  BUFFER_WINDOW,
  PAGE_SIZE,
  resumeCursorsFor,
  SCROLLBACK_CEILING,
  useMessagesStore,
} from "./messages.js";

vi.mock("../gateway/socket.js", () => ({
  gateway: { cmd: vi.fn() },
}));
vi.mock("../lib/api.js", () => ({
  api: { listMessages: vi.fn() },
}));
// eslint-disable-next-line @typescript-eslint/unbound-method -- vitest mock fn, never reads `this`
const cmd = vi.mocked(gateway.cmd);
// eslint-disable-next-line @typescript-eslint/unbound-method -- vitest mock fn, never reads `this`
const listMessages = vi.mocked(api.listMessages);

const CONV = "22222222-2222-7222-8222-222222222222";

function message(id: number): MessageDto {
  return {
    id,
    senderCharacter: "Nyx Firemane",
    kind: "msg",
    bbcode: `message ${String(id)}`,
    sentByUs: false,
    mention: false,
    createdAt: "2026-07-13T12:00:00.000Z",
  };
}

beforeEach(() => {
  useMessagesStore.getState().reset();
  cmd.mockReset();
  listMessages.mockReset();
});

describe("message buffers", () => {
  it("dedupes by id and keeps ascending order", () => {
    const store = useMessagesStore.getState();
    store.appendMany(CONV, [message(3), message(1)]);
    store.appendLive(CONV, message(2));
    store.appendLive(CONV, message(2)); // replayed live event
    expect(
      useMessagesStore.getState().buffers[CONV]?.messages.map((m) => m.id),
    ).toEqual([1, 2, 3]);
  });

  it("trims to the window and flags the trimmed rows as loadable history", () => {
    const store = useMessagesStore.getState();
    store.appendMany(
      CONV,
      Array.from({ length: BUFFER_WINDOW + 10 }, (_, i) => message(i + 1)),
    );
    const buffer = useMessagesStore.getState().buffers[CONV];
    expect(buffer?.messages).toHaveLength(BUFFER_WINDOW);
    expect(buffer?.messages[0]?.id).toBe(11);
    expect(buffer?.hasMoreBefore).toBe(true);
  });

  it("resume cursors are the newest buffered id per conversation", () => {
    const store = useMessagesStore.getState();
    store.appendMany(CONV, [message(5), message(9)]);
    expect(resumeCursorsFor([CONV, "unknown-conv"])).toEqual({ [CONV]: 9 });
  });
});

describe("scroll-back paging (history.page, #254)", () => {
  const IDENTITY = "11111111-1111-7111-8111-111111111111";

  it("stitches an older page before the buffer and keeps paging state", async () => {
    const store = useMessagesStore.getState();
    store.resetTo(CONV, [message(101), message(102)]);
    cmd.mockResolvedValueOnce({
      ok: true,
      messages: [message(99), message(100)],
      hasMore: true,
    });
    const loaded = await store.loadOlder(IDENTITY, CONV);
    expect(loaded).toBe(2);
    expect(cmd).toHaveBeenCalledWith({
      identityId: IDENTITY,
      action: "history.page",
      d: { convId: CONV, beforeId: 101, limit: PAGE_SIZE },
    });
    const buffer = useMessagesStore.getState().buffers[CONV];
    expect(buffer?.messages.map((m) => m.id)).toEqual([99, 100, 101, 102]);
    expect(buffer?.hasMoreBefore).toBe(true);
    expect(buffer?.loadingOlder).toBe(false);
  });

  it("stops requesting once history is exhausted", async () => {
    const store = useMessagesStore.getState();
    store.resetTo(CONV, [message(10)]);
    cmd.mockResolvedValueOnce({
      ok: true,
      messages: [message(9)],
      hasMore: false,
    });
    await store.loadOlder(IDENTITY, CONV);
    expect(useMessagesStore.getState().buffers[CONV]?.hasMoreBefore).toBe(
      false,
    );
    // Exhausted: further scroll-to-top loads never hit the gateway.
    expect(await store.loadOlder(IDENTITY, CONV)).toBe(0);
    expect(cmd).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed page and clears the loading flag", async () => {
    const store = useMessagesStore.getState();
    store.resetTo(CONV, [message(10)]);
    cmd.mockResolvedValueOnce({ ok: false, error: "not connected" });
    await expect(store.loadOlder(IDENTITY, CONV)).rejects.toThrow(
      "not connected",
    );
    const buffer = useMessagesStore.getState().buffers[CONV];
    expect(buffer?.messages.map((m) => m.id)).toEqual([10]);
    expect(buffer?.loadingOlder).toBe(false);
    expect(buffer?.hasMoreBefore).toBe(true);
  });

  it("caps the buffer under a deep back-scroll and detaches the tail (#356)", async () => {
    const store = useMessagesStore.getState();
    // Seed a full live window; ids ascending, newest at the tail.
    store.resetTo(
      CONV,
      Array.from({ length: BUFFER_WINDOW }, (_, i) => message(10_000 + i)),
    );
    let oldest =
      useMessagesStore.getState().buffers[CONV]?.messages[0]?.id ?? 0;
    // Page backwards far past the ceiling.
    for (let step = 0; step < 200; step += 1) {
      const page = Array.from({ length: PAGE_SIZE }, (_, i) =>
        message(oldest - PAGE_SIZE + i),
      );
      cmd.mockResolvedValueOnce({ ok: true, messages: page, hasMore: true });
      await store.loadOlder(IDENTITY, CONV);
      const buffer = useMessagesStore.getState().buffers[CONV];
      expect(buffer?.messages.length).toBeLessThanOrEqual(SCROLLBACK_CEILING);
      oldest = buffer?.messages[0]?.id ?? oldest;
    }
    const buffer = useMessagesStore.getState().buffers[CONV];
    expect(buffer?.messages).toHaveLength(SCROLLBACK_CEILING);
    // Trim keeps the oldest rows (where the reader is) and detaches the tail.
    expect(buffer?.detachedTail).toBe(true);
    // A live append is dropped while detached — no unreachable hole.
    store.appendLive(CONV, message(99_999));
    expect(
      useMessagesStore
        .getState()
        .buffers[CONV]?.messages.some((m) => m.id === 99_999),
    ).toBe(false);
  });

  it("leaves the live view untouched for a normal back-scroll", async () => {
    const store = useMessagesStore.getState();
    store.resetTo(CONV, [message(101), message(102)]);
    cmd.mockResolvedValueOnce({
      ok: true,
      messages: [message(99), message(100)],
      hasMore: true,
    });
    await store.loadOlder(IDENTITY, CONV);
    expect(useMessagesStore.getState().buffers[CONV]?.detachedTail).toBe(false);
  });

  it("leaving a jumped conversation drops the detached window and target (#411)", async () => {
    const store = useMessagesStore.getState();
    listMessages.mockResolvedValueOnce({
      messages: [message(1), message(2)],
      hasMore: false,
    });
    await store.jumpTo(IDENTITY, CONV, 2);
    expect(useMessagesStore.getState().jumpTarget?.messageId).toBe(2);
    expect(useMessagesStore.getState().buffers[CONV]?.detachedTail).toBe(true);

    store.leaveConversation(CONV);
    const buffer = useMessagesStore.getState().buffers[CONV];
    // Nothing left to strand the next open: no jump to re-run, no detached
    // buffer suppressing the open-at-tail stick, and backfilled=false so the
    // next mount fetches the live tail.
    expect(useMessagesStore.getState().jumpTarget).toBeUndefined();
    expect(buffer?.detachedTail).toBe(false);
    expect(buffer?.backfilled).toBe(false);
    expect(buffer?.messages).toEqual([]);
  });

  it("leaving an ordinary conversation keeps its buffer", () => {
    const store = useMessagesStore.getState();
    store.resetTo(CONV, [message(1), message(2)]);
    store.leaveConversation(CONV);
    expect(useMessagesStore.getState().buffers[CONV]?.messages).toHaveLength(2);
  });

  it("shares one initial page between concurrent backfills", async () => {
    const store = useMessagesStore.getState();
    listMessages.mockResolvedValue({ messages: [message(1)], hasMore: false });
    // The log asks on mount and again the moment `backfilled` clears under it.
    await Promise.all([
      store.backfill(IDENTITY, CONV),
      store.backfill(IDENTITY, CONV),
    ]);
    expect(listMessages).toHaveBeenCalledTimes(1);
  });

  it("back-to-present lands on the live tail after a capped scroll-back", async () => {
    const store = useMessagesStore.getState();
    store.resetTo(
      CONV,
      Array.from({ length: BUFFER_WINDOW }, (_, i) => message(10_000 + i)),
    );
    let oldest =
      useMessagesStore.getState().buffers[CONV]?.messages[0]?.id ?? 0;
    for (let step = 0; step < 200; step += 1) {
      const page = Array.from({ length: PAGE_SIZE }, (_, i) =>
        message(oldest - PAGE_SIZE + i),
      );
      cmd.mockResolvedValueOnce({ ok: true, messages: page, hasMore: true });
      await store.loadOlder(IDENTITY, CONV);
      oldest = useMessagesStore.getState().buffers[CONV]?.messages[0]?.id ?? 0;
    }
    expect(useMessagesStore.getState().buffers[CONV]?.detachedTail).toBe(true);
    const tail = [message(11_498), message(11_499)];
    listMessages.mockResolvedValueOnce({ messages: tail, hasMore: true });
    await store.backToPresent(IDENTITY, CONV);
    const buffer = useMessagesStore.getState().buffers[CONV];
    expect(buffer?.detachedTail).toBe(false);
    expect(buffer?.messages.map((m) => m.id)).toEqual([11_498, 11_499]);
  });
});

// Sleep → wake → reconnect (#432): the catch-up replay outran the budget, so
// the server flags a gap and the client's prefix is non-contiguous with it.
describe("catch-up gaps", () => {
  const IDENTITY = "11111111-1111-7111-8111-111111111111";

  it("keeps the reset buffer readable and the missed span one page away", async () => {
    const store = useMessagesStore.getState();
    listMessages.mockResolvedValueOnce({
      messages: [message(1), message(2)],
      hasMore: false,
    });
    await store.backfill(IDENTITY, CONV);

    store.resetTo(CONV, [message(101), message(102)]);
    const buffer = useMessagesStore.getState().buffers[CONV];
    // The replayed window IS renderable. Clearing `backfilled` here dropped
    // the mounted log to "Loading…" and disabled scroll-back and auto-fill
    // with it, stranding the conversation until the user navigated away.
    expect(buffer?.backfilled).toBe(true);
    expect(buffer?.hasMoreBefore).toBe(true);
    expect(buffer?.messages.map((m) => m.id)).toEqual([101, 102]);

    cmd.mockResolvedValueOnce({
      ok: true,
      messages: [message(99), message(100)],
      hasMore: true,
    });
    await store.loadOlder(IDENTITY, CONV);
    expect(
      useMessagesStore.getState().buffers[CONV]?.messages.map((m) => m.id),
    ).toEqual([99, 100, 101, 102]);
  });

  it("still asks for a page when the replay is empty", () => {
    useMessagesStore.getState().resetTo(CONV, []);
    expect(useMessagesStore.getState().buffers[CONV]?.backfilled).toBe(false);
  });

  it("drops a replay that would hole a detached history view", async () => {
    const store = useMessagesStore.getState();
    listMessages.mockResolvedValueOnce({
      messages: [message(10), message(11)],
      hasMore: true,
    });
    await store.jumpTo(IDENTITY, CONV, 11);
    expect(useMessagesStore.getState().buffers[CONV]?.detachedTail).toBe(true);
    // A detached conversation advertises no cursor, so the server replays
    // from the read cursor — a span nowhere near this window.
    expect(resumeCursorsFor([CONV])).toEqual({});

    store.appendMany(CONV, [message(900), message(901)]);
    expect(
      useMessagesStore.getState().buffers[CONV]?.messages.map((m) => m.id),
    ).toEqual([10, 11]);
  });
});
