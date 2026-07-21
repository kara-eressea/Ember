// SocialCache + enrichment unit tests (#194/#218). The route/gateway
// integration lives in social.test.ts and gateway.test.ts; this covers the
// cache's TTL/patch semantics and the case-insensitive presence join.

import { describe, expect, it } from "vitest";
import type { CharacterPresence } from "../session-engine/session-state.js";
import { enrichSocial, SocialCache, type SocialLists } from "./cache.js";

const LISTS: SocialLists = {
  bookmarks: ["Old Greywhisker"],
  friends: ["Nyx Firemane"],
  incoming: [{ id: 1, name: "Tally Marsh" }],
  outgoing: [],
};

describe("SocialCache", () => {
  it("is fresh inside the TTL and stale past it", () => {
    let now = 1_000;
    const cache = new SocialCache({ ttlMs: 60_000, now: () => now });
    expect(cache.fresh("id")).toBe(false);
    cache.set("id", LISTS);
    expect(cache.fresh("id")).toBe(true);
    now += 59_999;
    expect(cache.fresh("id")).toBe(true);
    now += 2;
    expect(cache.fresh("id")).toBe(false);
    // Stale entries are still served (the snapshot path) until invalidated.
    expect(cache.get("id")?.bookmarks).toEqual(["Old Greywhisker"]);
    cache.invalidate("id");
    expect(cache.get("id")).toBeUndefined();
  });

  it("patches bookmarks case-insensitively and dedupes", () => {
    const cache = new SocialCache();
    // No entry yet: nothing to patch, first GET fetches the truth.
    expect(cache.patchBookmark("id", "add", "Tally Marsh")).toBeUndefined();
    cache.set("id", LISTS);
    const added = cache.patchBookmark("id", "add", "Tally Marsh");
    expect(added?.bookmarks).toEqual(["Old Greywhisker", "Tally Marsh"]);
    // A duplicate add (different casing) must not double the row.
    expect(cache.patchBookmark("id", "add", "tally marsh")?.bookmarks).toEqual([
      "Old Greywhisker",
      "Tally Marsh",
    ]);
    expect(
      cache.patchBookmark("id", "remove", "TALLY MARSH")?.bookmarks,
    ).toEqual(["Old Greywhisker"]);
  });
});

describe("enrichSocial", () => {
  it("joins presence case-insensitively (#218)", () => {
    const roster = new Map<string, CharacterPresence>([
      // Roster casing disagrees with the JSON API's casing on purpose.
      ["old greywhisker", { gender: "Male", status: "busy", statusmsg: "zz" }],
    ]);
    const dto = enrichSocial(LISTS, roster);
    expect(dto.bookmarks).toEqual([
      {
        name: "Old Greywhisker",
        online: true,
        status: "busy",
        statusmsg: "zz",
      },
    ]);
    expect(dto.friends).toEqual([
      { name: "Nyx Firemane", online: false, status: "offline", statusmsg: "" },
    ]);
  });

  it("renders everyone offline without a roster (detached session)", () => {
    const dto = enrichSocial(LISTS, undefined);
    expect(dto.bookmarks[0]).toMatchObject({ online: false });
    expect(dto.incoming).toEqual([{ id: 1, name: "Tally Marsh" }]);
  });
});
