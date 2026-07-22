// Buffer mechanics: id-dedupe merge, the window cap marking trimmed history
// as re-loadable, and resume cursors.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageDto } from "@emberchat/protocol";
import { gateway } from "../gateway/socket.js";
import {
  BUFFER_WINDOW,
  PAGE_SIZE,
  resumeCursorsFor,
  useMessagesStore,
} from "./messages.js";

vi.mock("../gateway/socket.js", () => ({
  gateway: { cmd: vi.fn() },
}));
// eslint-disable-next-line @typescript-eslint/unbound-method -- vitest mock fn, never reads `this`
const cmd = vi.mocked(gateway.cmd);

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
});
