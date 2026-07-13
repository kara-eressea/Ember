// Buffer mechanics: id-dedupe merge, the window cap marking trimmed history
// as re-loadable, and resume cursors.

import { beforeEach, describe, expect, it } from "vitest";
import type { MessageDto } from "@emberchat/protocol";
import {
  BUFFER_WINDOW,
  resumeCursorsFor,
  useMessagesStore,
} from "./messages.js";

const CONV = "22222222-2222-7222-8222-222222222222";

function message(id: number): MessageDto {
  return {
    id,
    senderCharacter: "Nyx Firemane",
    kind: "msg",
    bbcode: `message ${String(id)}`,
    sentByUs: false,
    createdAt: "2026-07-13T12:00:00.000Z",
  };
}

beforeEach(() => {
  useMessagesStore.getState().reset();
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
