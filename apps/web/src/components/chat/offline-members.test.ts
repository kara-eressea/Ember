// "Seen recently" helpers (#200): relative-time formatting, the shared
// filter matcher, group derivation ordering, and the per-channel collapse
// memory (localStorage-backed, default collapsed).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SeenMemberDto } from "@emberchat/protocol";
import {
  isOfflineExpanded,
  matchesMemberFilter,
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

describe("matchesMemberFilter (#497)", () => {
  const member = {
    character: "Vesna Kohl",
    gender: "Female",
    status: "looking",
    statusmsg: "[color=green]open for [b]dragon[/b] RP[/color]",
  };

  it("still matches nicks by substring", () => {
    expect(matchesMemberFilter(member, "kohl")).toBe(true);
    expect(matchesMemberFilter(member, " ESNA ")).toBe(true);
    expect(matchesMemberFilter(member, "quill")).toBe(false);
  });

  it("matches everything on a blank query", () => {
    expect(matchesMemberFilter(member, "")).toBe(true);
    expect(matchesMemberFilter(member, "   ")).toBe(true);
  });

  it("matches gender, the request that opened the issue", () => {
    expect(matchesMemberFilter(member, "female")).toBe(true);
    expect(matchesMemberFilter(member, "FEMALE")).toBe(true);
    expect(matchesMemberFilter(member, "fem")).toBe(true);
  });

  // The trap: "male" is a substring of "female" and "shemale", so a
  // substring rule would make the most obvious gender query match everyone
  // it was meant to exclude. Word-PREFIX matching is what makes it useful.
  it("does not let a 'male' query match female or shemale", () => {
    expect(
      matchesMemberFilter({ character: "A", gender: "Female" }, "male"),
    ).toBe(false);
    expect(
      matchesMemberFilter({ character: "A", gender: "Shemale" }, "male"),
    ).toBe(false);
    expect(
      matchesMemberFilter({ character: "A", gender: "Male" }, "male"),
    ).toBe(true);
  });

  it("matches either word of a hyphenated gender, and the whole value", () => {
    const hermes = { character: "A", gender: "Male-Herm" };
    expect(matchesMemberFilter(hermes, "male")).toBe(true);
    expect(matchesMemberFilter(hermes, "herm")).toBe(true);
    expect(matchesMemberFilter(hermes, "male-h")).toBe(true);
    expect(
      matchesMemberFilter({ character: "A", gender: "Cunt-boy" }, "boy"),
    ).toBe(true);
    // A prefix of a word, not a substring of one.
    expect(matchesMemberFilter(hermes, "erm")).toBe(false);
  });

  it("matches a chosen status by word prefix", () => {
    expect(matchesMemberFilter(member, "looking")).toBe(true);
    expect(matchesMemberFilter(member, "look")).toBe(true);
    expect(
      matchesMemberFilter(
        { character: "A", gender: "None", status: "dnd" },
        "dnd",
      ),
    ).toBe(true);
  });

  // "online" is every member's default — matching it would turn "o" into
  // "show the whole roster", which is the opposite of filtering.
  it("ignores the default online status", () => {
    const plain = { character: "A", gender: "None", status: "online" };
    expect(matchesMemberFilter(plain, "online")).toBe(false);
    expect(matchesMemberFilter(plain, "on")).toBe(false);
  });

  it("matches the visible text of a status message, not its BBCode", () => {
    expect(matchesMemberFilter(member, "dragon")).toBe(true);
    expect(matchesMemberFilter(member, "open for")).toBe(true);
    // Tag syntax the row never shows must never match.
    expect(matchesMemberFilter(member, "color=green")).toBe(false);
    expect(matchesMemberFilter(member, "[b]")).toBe(false);
  });

  it("matches a status message through the server's wire escaping", () => {
    expect(
      matchesMemberFilter(
        { character: "A", gender: "None", statusmsg: "canons &amp; vibes" },
        "canons & vibes",
      ),
    ).toBe(true);
  });

  it("works on a seen entry, which carries only a nick and a gender", () => {
    const seenEntry = { character: "Dell Marsh", gender: "Male" };
    expect(matchesMemberFilter(seenEntry, "male")).toBe(true);
    expect(matchesMemberFilter(seenEntry, "looking")).toBe(false);
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
