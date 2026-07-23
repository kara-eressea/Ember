import { describe, expect, it } from "vitest";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import type {
  ChannelView,
  DmView,
  IdentitySession,
  IdentitySummary,
} from "../stores/sessions.js";
import { unreadBadgeCount } from "./favicon-badge.js";

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

function channel(unread: number, mentions: number): ChannelView {
  return {
    convId: "c",
    key: "c",
    title: "c",
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

function dm(unread: number): DmView {
  return {
    convId: "d",
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

describe("unreadBadgeCount", () => {
  it("is zero with no identities", () => {
    expect(unreadBadgeCount(undefined, {})).toBe(0);
    expect(unreadBadgeCount([], {})).toBe(0);
  });

  it("counts DM unreads plus channel mentions for a synced slice", () => {
    const sessions = {
      "id-1": slice({
        channels: { a: channel(5, 2), b: channel(3, 1) },
        dms: { d1: dm(4), d2: dm(1) },
      }),
    };
    // 4 + 1 DM unreads, 2 + 1 channel mentions; plain channel unreads ignored.
    expect(unreadBadgeCount([summary("id-1")], sessions)).toBe(8);
  });

  it("excludes channel unreads that never named the user", () => {
    const sessions = {
      "id-1": slice({ channels: { a: channel(9, 0) }, dms: {} }),
    };
    expect(unreadBadgeCount([summary("id-1")], sessions)).toBe(0);
  });

  it("falls back to the ready-frame mentions while a slice is unsynced", () => {
    expect(
      unreadBadgeCount([summary("id-1", { mentions: 3, unread: 12 })], {}),
    ).toBe(3);
    expect(
      unreadBadgeCount([summary("id-1", { mentions: 3 })], {
        "id-1": slice({ synced: false }),
      }),
    ).toBe(3);
  });

  it("sums across multiple identities", () => {
    const sessions = {
      "id-1": slice({ dms: { d: dm(2) }, channels: { a: channel(0, 1) } }),
    };
    const identities = [
      summary("id-1"),
      summary("id-2", { mentions: 5 }), // unsynced
    ];
    expect(unreadBadgeCount(identities, sessions)).toBe(2 + 1 + 5);
  });
});
