// ChannelBrowser data helpers: filter matches name OR topic, the join button
// derives its state from the store's channel rows, staleness stays honest.

import { describe, expect, it } from "vitest";
import type { DirectoryChannelDto } from "../../lib/api.js";
import {
  filterDirectory,
  joinStateFor,
  sortByMembers,
  stalenessLabel,
} from "./browser-data.js";

const DIRECTORY: DirectoryChannelDto[] = [
  { key: "Frontpage", kind: "official", title: "Frontpage", characters: 12 },
  {
    key: "ADH-1a2b",
    kind: "open",
    title: "Ember Lounge",
    characters: 3,
  },
  { key: "Gardening", kind: "official", title: "Gardening", characters: 1 },
];

describe("filterDirectory", () => {
  it("matches name or topic, case-insensitively", () => {
    expect(filterDirectory(DIRECTORY, "front").map((c) => c.key)).toEqual([
      "Frontpage",
    ]);
    // "lounge" only appears in the open room's title, not its ADH- key.
    expect(filterDirectory(DIRECTORY, "LOUNGE").map((c) => c.key)).toEqual([
      "ADH-1a2b",
    ]);
    // ADH- ids are searchable too.
    expect(filterDirectory(DIRECTORY, "adh-").map((c) => c.key)).toEqual([
      "ADH-1a2b",
    ]);
  });

  it("returns everything for a blank query", () => {
    expect(filterDirectory(DIRECTORY, "  ")).toHaveLength(3);
  });
});

describe("sortByMembers", () => {
  it("orders busiest rooms first, without mutating the input", () => {
    const shuffled = [DIRECTORY[2]!, DIRECTORY[0]!, DIRECTORY[1]!];
    expect(sortByMembers(shuffled).map((c) => c.key)).toEqual([
      "Frontpage",
      "ADH-1a2b",
      "Gardening",
    ]);
    expect(shuffled.map((c) => c.key)).toEqual([
      "Gardening",
      "Frontpage",
      "ADH-1a2b",
    ]);
  });

  it("keeps the incoming order for tied counts (stable sort)", () => {
    const tied: DirectoryChannelDto[] = [
      { key: "A", kind: "official", title: "A", characters: 5 },
      { key: "B", kind: "official", title: "B", characters: 5 },
    ];
    expect(sortByMembers(tied).map((c) => c.key)).toEqual(["A", "B"]);
  });
});

describe("joinStateFor", () => {
  const channels = {
    Frontpage: { joined: true, pinned: false },
    Gardening: { joined: true, pinned: true },
    // A channel we hold history for but left: the pin may linger on the
    // conversation row, but the button must offer Join again.
    Orchard: { joined: false, pinned: true },
  };

  it("derives join / joined / pinned", () => {
    expect(joinStateFor("Frontpage", channels)).toBe("joined");
    expect(joinStateFor("Gardening", channels)).toBe("pinned");
    expect(joinStateFor("Orchard", channels)).toBe("join");
    expect(joinStateFor("ADH-1a2b", channels)).toBe("join");
  });
});

describe("stalenessLabel", () => {
  const now = Date.parse("2026-07-15T12:00:00Z");

  it("is honest about age", () => {
    expect(stalenessLabel(null, now)).toBe("never refreshed");
    expect(stalenessLabel("2026-07-15T11:59:30Z", now)).toBe(
      "updated just now",
    );
    expect(stalenessLabel("2026-07-15T11:55:00Z", now)).toBe("updated 5m ago");
    expect(stalenessLabel("2026-07-15T09:00:00Z", now)).toBe("updated 3h ago");
  });
});
