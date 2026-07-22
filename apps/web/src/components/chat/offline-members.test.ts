// "Seen recently" helpers (#200): relative-time formatting, the shared
// filter matcher, group derivation ordering, and the per-channel collapse
// memory (localStorage-backed, default collapsed).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SeenMemberDto } from "@emberchat/protocol";
import {
  isOfflineExpanded,
  matchesMemberQuery,
  offlineRows,
  relativeSeen,
  setOfflineExpanded,
} from "./offline-members.js";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

describe("relativeSeen", () => {
  it.each([
    [0, "just now"],
    [90_000, "just now"], // under two minutes — a member who just parted
    [2 * MINUTE, "2 min ago"],
    [5 * MINUTE, "5 min ago"],
    [40 * MINUTE, "40 min ago"],
    [59 * MINUTE + 59_000, "59 min ago"],
    [HOUR, "1 hr ago"],
    [2 * HOUR, "2 hr ago"],
    [9 * HOUR + 30 * MINUTE, "9 hr ago"],
    [DAY, "yesterday"],
    [DAY + 23 * HOUR, "yesterday"],
    [2 * DAY, "2 days ago"],
    [3 * DAY + HOUR, "3 days ago"],
    [6 * DAY, "6 days ago"],
  ])("formats an age of %d ms as %s", (age, expected) => {
    expect(relativeSeen(NOW - age, NOW)).toBe(expected);
  });

  it("clamps a slightly-future stamp to just now (clock skew)", () => {
    expect(relativeSeen(NOW + 5_000, NOW)).toBe("just now");
  });
});

describe("matchesMemberQuery", () => {
  it("matches nick substrings case-insensitively", () => {
    expect(matchesMemberQuery("Vesna Kohl", "kohl")).toBe(true);
    expect(matchesMemberQuery("Vesna Kohl", "  VESNA ")).toBe(true);
    expect(matchesMemberQuery("Vesna Kohl", "quill")).toBe(false);
  });
});

describe("offlineRows", () => {
  const seen: SeenMemberDto[] = [
    { character: "Mara Quill", gender: "Female", lastSeen: NOW - 3 * DAY },
    { character: "Vesna Kohl", gender: "Female", lastSeen: NOW - DAY },
    { character: "Dell Marsh", gender: "Male", lastSeen: NOW - MINUTE },
  ];

  it("sorts most-recently-seen first", () => {
    expect(offlineRows(seen, "").map((r) => r.character)).toEqual([
      "Dell Marsh",
      "Vesna Kohl",
      "Mara Quill",
    ]);
  });

  it("filters by the query while keeping the sort", () => {
    expect(offlineRows(seen, "ma").map((r) => r.character)).toEqual([
      "Dell Marsh",
      "Mara Quill",
    ]);
  });

  it("does not mutate the input", () => {
    const before = [...seen];
    offlineRows(seen, "");
    expect(seen).toEqual(before);
  });
});

describe("collapse memory", () => {
  const stored = new Map<string, string>();
  beforeEach(() => {
    stored.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to collapsed", () => {
    expect(isOfflineExpanded("Frontpage")).toBe(false);
  });

  it("remembers the fold per channel", () => {
    setOfflineExpanded("Frontpage", true);
    expect(isOfflineExpanded("Frontpage")).toBe(true);
    expect(isOfflineExpanded("Development")).toBe(false);
    setOfflineExpanded("Frontpage", false);
    expect(isOfflineExpanded("Frontpage")).toBe(false);
  });

  it("survives corrupt storage by falling back to the default", () => {
    stored.set("eb.seenRecentlyExpanded", "{not json");
    expect(isOfflineExpanded("Frontpage")).toBe(false);
  });
});
