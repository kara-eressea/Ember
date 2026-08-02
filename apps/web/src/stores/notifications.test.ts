// Notification-inbox store (#466): the bounded newest-first buffer, downward
// paging, the live prepend, and what is (and is not) allowed to badge.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationDto } from "@emberchat/protocol";
import { api } from "../lib/api.js";
import {
  EMPTY_INBOX,
  INBOX_WINDOW,
  mergeNewestFirst,
  useNotificationsStore,
} from "./notifications.js";

vi.mock("../lib/api.js", () => ({
  api: {
    listNotifications: vi.fn(),
    putNotificationsSeen: vi.fn(),
  },
}));

const mocked = vi.mocked(api);
const IDENTITY = "id-1";

function entry(
  id: number,
  patch: Partial<NotificationDto> = {},
): NotificationDto {
  return {
    id,
    kind: "mention",
    convId: "conv-1",
    messageId: id * 10,
    character: "Nyx Firemane",
    excerpt: `line ${String(id)}`,
    muted: false,
    createdAt: new Date(id * 1000).toISOString(),
    ...patch,
  };
}

function inbox() {
  return useNotificationsStore.getState().byIdentity[IDENTITY] ?? EMPTY_INBOX;
}

describe("mergeNewestFirst", () => {
  it("sorts newest first, dedupes by id and trims the OLDEST past the window", () => {
    const merged = mergeNewestFirst(
      [entry(3), entry(1)],
      [entry(2), entry(3, { excerpt: "updated" })],
    );
    expect(merged.map((e) => e.id)).toEqual([3, 2, 1]);
    expect(merged[0]?.excerpt).toBe("updated");

    // The window keeps the newest: a deep scroll-down must not let the buffer
    // grow without bound, and the dropped rows re-page on demand.
    const many = mergeNewestFirst(
      [],
      Array.from({ length: INBOX_WINDOW + 5 }, (_, i) => entry(i + 1)),
    );
    expect(many).toHaveLength(INBOX_WINDOW);
    expect(many[0]?.id).toBe(INBOX_WINDOW + 5);
  });
});

describe("useNotificationsStore", () => {
  beforeEach(() => {
    useNotificationsStore.getState().reset();
    vi.clearAllMocks();
  });

  it("loads the first page and carries the watermark and unseen count", async () => {
    mocked.listNotifications.mockResolvedValue({
      notifications: [entry(9), entry(8)],
      hasMore: true,
      lastSeenId: 7,
      unseen: 2,
    });
    await useNotificationsStore.getState().load(IDENTITY);
    expect(inbox()).toMatchObject({
      hasMore: true,
      lastSeenId: 7,
      unseen: 2,
      loaded: true,
      loading: false,
    });
    expect(inbox().items.map((e) => e.id)).toEqual([9, 8]);
  });

  it("pages DOWNWARD for older entries, from the current tail", async () => {
    mocked.listNotifications.mockResolvedValueOnce({
      notifications: [entry(9), entry(8)],
      hasMore: true,
      lastSeenId: 0,
      unseen: 2,
    });
    await useNotificationsStore.getState().load(IDENTITY);
    mocked.listNotifications.mockResolvedValueOnce({
      notifications: [entry(7), entry(6)],
      hasMore: false,
      lastSeenId: 0,
      unseen: 2,
    });
    await useNotificationsStore.getState().loadOlder(IDENTITY);

    expect(mocked.listNotifications.mock.calls.at(-1)).toEqual([
      IDENTITY,
      { before: 8, limit: 50 },
    ]);
    expect(inbox().items.map((e) => e.id)).toEqual([9, 8, 7, 6]);
    expect(inbox().hasMore).toBe(false);

    // Exhausted: no further request, however hard the panel scrolls.
    await useNotificationsStore.getState().loadOlder(IDENTITY);
    expect(mocked.listNotifications.mock.calls).toHaveLength(2);
  });

  it("prepends a live entry and counts only what may alert", async () => {
    mocked.listNotifications.mockResolvedValue({
      notifications: [entry(5)],
      hasMore: false,
      lastSeenId: 5,
      unseen: 0,
    });
    await useNotificationsStore.getState().load(IDENTITY);

    useNotificationsStore.getState().applyLive(IDENTITY, entry(6));
    expect(inbox().items.map((e) => e.id)).toEqual([6, 5]);
    expect(inbox().unseen).toBe(1);

    // A muted mention IS logged — the inbox is a log — but never badges
    // (decisions.md §10, the favicon indicator's rule).
    useNotificationsStore
      .getState()
      .applyLive(IDENTITY, entry(7, { muted: true }));
    expect(inbox().items.map((e) => e.id)).toEqual([7, 6, 5]);
    expect(inbox().unseen).toBe(1);

    // A replayed duplicate must not double-count.
    useNotificationsStore.getState().applyLive(IDENTITY, entry(6));
    expect(inbox().unseen).toBe(1);
  });

  it("badges from the ready frame before the inbox is ever opened", () => {
    useNotificationsStore.getState().applyUnseen(IDENTITY, 4);
    expect(inbox().unseen).toBe(4);
    // Nothing is buffered yet, so an open that failed to load must not clear
    // the badge by marking an id nobody has seen.
    expect(inbox().items).toHaveLength(0);
  });

  it("marks everything seen on open and converges on the server's answer", async () => {
    mocked.listNotifications.mockResolvedValue({
      notifications: [entry(9), entry(8)],
      hasMore: false,
      lastSeenId: 0,
      unseen: 2,
    });
    await useNotificationsStore.getState().load(IDENTITY);
    mocked.putNotificationsSeen.mockResolvedValue({
      lastSeenId: 9,
      unseen: 0,
    });
    await useNotificationsStore.getState().markSeen(IDENTITY);
    expect(mocked.putNotificationsSeen.mock.calls).toEqual([[IDENTITY, 9]]);
    expect(inbox()).toMatchObject({ unseen: 0, lastSeenId: 9 });

    // Already at the watermark: no second write.
    await useNotificationsStore.getState().markSeen(IDENTITY);
    expect(mocked.putNotificationsSeen.mock.calls).toHaveLength(1);
  });

  it("never marks an empty buffer seen", async () => {
    useNotificationsStore.getState().applyUnseen(IDENTITY, 3);
    await useNotificationsStore.getState().markSeen(IDENTITY);
    expect(mocked.putNotificationsSeen.mock.calls).toHaveLength(0);
    expect(inbox().unseen).toBe(3);
  });
});
