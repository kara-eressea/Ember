import { describe, expect, it } from "vitest";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import type {
  ChannelView,
  DmView,
  IdentitySession,
  IdentitySummary,
} from "../stores/sessions.js";
import { unreadIndicator } from "./favicon-badge.js";

function summary(
  id: string,
  overrides: Partial<IdentitySummary> = {},
): IdentitySummary {
  return {
    id,
    name: id,
    autoConnect: true,
    unread: 0,
    mentions: 0,
    ...overrides,
  };
}

function slice(overrides: Partial<IdentitySession>): IdentitySession {
  return {
    identityId: "id-1",
    character: "Amber Vale",
    sessionStatus: "online",
    ownStatus: "online",
    ownStatusmsg: "",
    ignores: [],
    invites: [],
    limits: { chatMax: 4096, privMax: 50000, lfrpMax: 50000, lfrpFlood: 600 },
    iconBlacklist: [],
    chatop: false,
    sendDelaySeconds: 0,
    prefs: PREFS_DEFAULTS,
    outbox: [],
    campaign: null,
    channels: {},
    dms: {},
    channelByConvId: {},
    synced: true,
    ...overrides,
  };
}

function muted(
  convIds: string[] = [],
  identityIds: string[] = [],
): IdentitySession["prefs"] {
  return {
    ...PREFS_DEFAULTS,
    mutedConvIds: convIds,
    mutedIdentityIds: identityIds,
  };
}

function channel(unread: number, mentions: number, convId = "c"): ChannelView {
  return {
    convId,
    key: convId,
    title: convId,
    description: "",
    mode: "both",
    oplist: [],
    members: [],
    seen: [],
    joined: true,
    pinned: false,
    unread,
    mentions,
    highlightedAt: 0,
    lastReadMessageId: null,
    newestMessageId: null,
  };
}

function dm(unread: number, convId = "d"): DmView {
  return {
    convId,
    partner: "Nyx",
    title: "Nyx",
    online: true,
    status: "online",
    statusmsg: "",
    pinned: false,
    typing: "clear",
    unread,
    highlightedAt: 0,
    lastReadMessageId: null,
    newestMessageId: null,
  };
}

describe("unreadIndicator", () => {
  it("is clear with no identities", () => {
    expect(unreadIndicator(undefined, {})).toEqual({ count: 0, dot: false });
    expect(unreadIndicator([], {})).toEqual({ count: 0, dot: false });
  });

  it("counts DM unreads plus channel mentions for a synced slice", () => {
    const sessions = {
      "id-1": slice({
        channels: { a: channel(5, 2, "a"), b: channel(3, 1, "b") },
        dms: { d1: dm(4, "d1"), d2: dm(1, "d2") },
      }),
    };
    // 4 + 1 DM unreads, 2 + 1 channel mentions; plain channel unreads only
    // matter when nothing is directed at the user.
    expect(unreadIndicator([summary("id-1")], sessions)).toEqual({
      count: 8,
      dot: false,
    });
  });

  it("falls back to the dot for channel unreads that never named the user", () => {
    const sessions = {
      "id-1": slice({ channels: { a: channel(9, 0, "a") }, dms: {} }),
    };
    expect(unreadIndicator([summary("id-1")], sessions)).toEqual({
      count: 0,
      dot: true,
    });
  });

  it("shows nothing when every conversation is read", () => {
    const sessions = {
      "id-1": slice({ channels: { a: channel(0, 0, "a") }, dms: { d: dm(0) } }),
    };
    expect(unreadIndicator([summary("id-1")], sessions)).toEqual({
      count: 0,
      dot: false,
    });
  });

  it("drops a muted conversation from both tiers", () => {
    const sessions = {
      "id-1": slice({
        prefs: muted(["a", "d1"]),
        channels: { a: channel(9, 4, "a"), b: channel(2, 0, "b") },
        dms: { d1: dm(3, "d1") },
      }),
    };
    // The muted channel's 4 mentions and the muted DM's 3 unreads are gone;
    // the unmuted channel's plain unread still earns the dot.
    expect(unreadIndicator([summary("id-1")], sessions)).toEqual({
      count: 0,
      dot: true,
    });
  });

  it("keeps unmuted conversations counting alongside muted ones", () => {
    const sessions = {
      "id-1": slice({
        prefs: muted(["a"]),
        channels: { a: channel(9, 4, "a"), b: channel(1, 2, "b") },
        dms: { d1: dm(3, "d1") },
      }),
    };
    expect(unreadIndicator([summary("id-1")], sessions)).toEqual({
      count: 5,
      dot: false,
    });
  });

  it("drops a muted identity wholesale", () => {
    const sessions = {
      "id-1": slice({
        prefs: muted([], ["id-1"]),
        channels: { a: channel(9, 4, "a") },
        dms: { d1: dm(3, "d1") },
      }),
    };
    expect(unreadIndicator([summary("id-1")], sessions)).toEqual({
      count: 0,
      dot: false,
    });
  });

  it("drops a muted identity that is still unsynced", () => {
    const sessions = {
      "id-1": slice({ prefs: muted([], ["id-2"]) }),
      "id-2": slice({ identityId: "id-2", synced: false }),
    };
    const identities = [
      summary("id-1"),
      summary("id-2", { mentions: 7, unread: 9 }),
    ];
    expect(unreadIndicator(identities, sessions)).toEqual({
      count: 0,
      dot: false,
    });
  });

  it("falls back to the ready-frame totals while a slice is unsynced", () => {
    // Those totals arrive mute-aware: the server drops muted conversations
    // before aggregating them (#430 follow-up), so there is no leak left to
    // compensate for here — the fallback is simply trusted.
    expect(
      unreadIndicator([summary("id-1", { mentions: 3, unread: 12 })], {}),
    ).toEqual({ count: 3, dot: false });
    expect(
      unreadIndicator([summary("id-1", { mentions: 0, unread: 12 })], {
        "id-1": slice({ synced: false }),
      }),
    ).toEqual({ count: 0, dot: true });
  });

  it("sums across multiple identities", () => {
    const sessions = {
      "id-1": slice({
        dms: { d: dm(2) },
        channels: { a: channel(0, 1, "a") },
      }),
    };
    const identities = [
      summary("id-1"),
      summary("id-2", { mentions: 5 }), // unsynced
    ];
    expect(unreadIndicator(identities, sessions)).toEqual({
      count: 2 + 1 + 5,
      dot: false,
    });
  });

  it("reads the mute lists from any synced slice", () => {
    // Prefs are per app account; the identity carrying the muted conversation
    // need not be the one whose slice we happened to read them from.
    const sessions = {
      "id-1": slice({ prefs: muted(["a"]) }),
      "id-2": slice({
        identityId: "id-2",
        prefs: muted(["a"]),
        channels: { a: channel(4, 2, "a") },
      }),
    };
    expect(
      unreadIndicator([summary("id-1"), summary("id-2")], sessions),
    ).toEqual({ count: 0, dot: false });
  });
});
