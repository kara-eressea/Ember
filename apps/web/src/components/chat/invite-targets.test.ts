import { describe, expect, it } from "vitest";
import type { ChannelView } from "../../stores/sessions.js";
import { inviteTargets, isPrivateRoom } from "./invite-targets.js";

function channel(over: Partial<ChannelView> & { key: string }): ChannelView {
  return {
    convId: over.key,
    title: over.key,
    description: "",
    mode: "both",
    oplist: [],
    members: [],
    seen: [],
    joined: true,
    pinned: false,
    unread: 0,
    mentions: 0,
    highlightedAt: 0,
    lastReadMessageId: null,
    newestMessageId: null,
    ...over,
  };
}

function map(...rooms: ChannelView[]): Record<string, ChannelView> {
  return Object.fromEntries(rooms.map((r) => [r.key, r]));
}

describe("isPrivateRoom", () => {
  it("treats ADH- keys as private, plain names as public", () => {
    expect(isPrivateRoom("ADH-1a2b")).toBe(true);
    expect(isPrivateRoom("adh-1a2b")).toBe(true);
    expect(isPrivateRoom("Frontpage")).toBe(false);
  });
});

describe("inviteTargets", () => {
  it("offers private rooms where the viewer is owner", () => {
    const rooms = map(
      channel({ key: "ADH-lounge", title: "The Lounge", oplist: ["Kara"] }),
    );
    expect(inviteTargets(rooms, "Kara")).toEqual([
      { key: "ADH-lounge", title: "The Lounge" },
    ]);
  });

  it("offers private rooms where the viewer is a non-owner op", () => {
    const rooms = map(
      channel({ key: "ADH-den", title: "Den", oplist: ["Owner", "Kara"] }),
    );
    expect(inviteTargets(rooms, "Kara")).toEqual([
      { key: "ADH-den", title: "Den" },
    ]);
  });

  it("matches the viewer case-insensitively", () => {
    const rooms = map(
      channel({ key: "ADH-den", title: "Den", oplist: ["kara"] }),
    );
    expect(inviteTargets(rooms, "Kara")).toHaveLength(1);
  });

  it("excludes rooms where the viewer is a plain member", () => {
    const rooms = map(
      channel({ key: "ADH-den", title: "Den", oplist: ["Owner", "Someone"] }),
    );
    expect(inviteTargets(rooms, "Kara")).toEqual([]);
  });

  it("excludes public official channels even when the viewer is an op", () => {
    const rooms = map(
      channel({ key: "Frontpage", title: "Frontpage", oplist: ["Kara"] }),
    );
    expect(inviteTargets(rooms, "Kara")).toEqual([]);
  });

  it("excludes rooms the viewer is not live in", () => {
    const rooms = map(
      channel({
        key: "ADH-den",
        title: "Den",
        oplist: ["Kara"],
        joined: false,
      }),
    );
    expect(inviteTargets(rooms, "Kara")).toEqual([]);
  });

  it("sorts eligible rooms by title", () => {
    const rooms = map(
      channel({ key: "ADH-z", title: "Zed", oplist: ["Kara"] }),
      channel({ key: "ADH-a", title: "Alpha", oplist: ["Kara"] }),
    );
    expect(inviteTargets(rooms, "Kara").map((t) => t.title)).toEqual([
      "Alpha",
      "Zed",
    ]);
  });
});
