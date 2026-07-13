import { describe, expect, it } from "vitest";
import type {
  ChannelView,
  DmView,
  IdentitySession,
  IdentitySummary,
} from "../../stores/sessions.js";
import { railBadge, railDot } from "./rail-data.js";

const SUMMARY: IdentitySummary = {
  id: "id-1",
  name: "Amber Vale",
  autoConnect: true,
  unread: 7,
  mentions: 2,
};

function slice(overrides: Partial<IdentitySession>): IdentitySession {
  return {
    identityId: "id-1",
    character: "Amber Vale",
    sessionStatus: "online",
    limits: { chatMax: 4096, privMax: 50000 },
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
    joined: true,
    pinned: false,
    unread,
    mentions,
    lastReadMessageId: null,
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
    lastReadMessageId: null,
  };
}

describe("railBadge", () => {
  it("falls back to the ready-frame totals while the slice is not synced", () => {
    expect(railBadge(SUMMARY, undefined)).toEqual({ unread: 7, mentions: 2 });
    expect(railBadge(SUMMARY, slice({ synced: false }))).toEqual({
      unread: 7,
      mentions: 2,
    });
  });

  it("aggregates the live per-conversation counters of a synced slice", () => {
    const live = slice({
      channels: { a: channel(3, 1), b: channel(2, 0) },
      dms: { d1: dm(4) },
    });
    // Live counters win over the (stale) ready totals.
    expect(railBadge(SUMMARY, live)).toEqual({ unread: 9, mentions: 1 });
  });

  it("a synced slice with everything read shows no badge", () => {
    expect(railBadge(SUMMARY, slice({}))).toEqual({ unread: 0, mentions: 0 });
  });
});

describe("railDot", () => {
  it("maps our session lifecycle onto the three dot kinds", () => {
    expect(railDot("online")).toBe("ok");
    expect(railDot("offline")).toBe("faint");
    expect(railDot("stopped")).toBe("faint");
    for (const inFlight of [
      "idle",
      "acquiring_ticket",
      "connecting",
      "identifying",
      "backoff",
    ] as const) {
      expect(railDot(inFlight)).toBe("warn");
    }
  });
});
