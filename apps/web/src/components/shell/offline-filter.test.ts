import { describe, expect, it } from "vitest";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import {
  OFFLINE_SECTIONS,
  SHOW_OFFLINE_PREF,
  keepRow,
  showOfflineFor,
} from "./offline-filter.js";

describe("showOfflineFor", () => {
  it("reads each section's own pref", () => {
    const prefs = {
      ...PREFS_DEFAULTS,
      showOfflineFriends: true,
      showOfflineBookmarks: false,
      showOfflineDms: true,
    };
    expect(showOfflineFor(prefs, "friends")).toBe(true);
    expect(showOfflineFor(prefs, "bookmarks")).toBe(false);
    expect(showOfflineFor(prefs, "dms")).toBe(true);
  });

  it("maps every section to a distinct pref key", () => {
    const keys = OFFLINE_SECTIONS.map((s) => SHOW_OFFLINE_PREF[s]);
    expect(new Set(keys).size).toBe(OFFLINE_SECTIONS.length);
  });
});

describe("keepRow", () => {
  it("always keeps an online row regardless of anything else", () => {
    expect(keepRow({ online: true, showOffline: false })).toBe(true);
  });

  it("hides an offline, read, unpinned, unopened row when the section hides", () => {
    expect(
      keepRow({
        online: false,
        showOffline: false,
        pinned: false,
        unread: 0,
        active: false,
      }),
    ).toBe(false);
  });

  it("keeps every offline row when the section shows offline", () => {
    expect(keepRow({ online: false, showOffline: true })).toBe(true);
  });

  // The three always-show exemptions, each on its own with the section hiding.
  it("keeps an offline pinned row even when the section hides", () => {
    expect(keepRow({ online: false, showOffline: false, pinned: true })).toBe(
      true,
    );
  });

  it("keeps an offline unread row even when the section hides", () => {
    expect(keepRow({ online: false, showOffline: false, unread: 3 })).toBe(
      true,
    );
  });

  it("keeps the currently open offline conversation even when the section hides", () => {
    expect(keepRow({ online: false, showOffline: false, active: true })).toBe(
      true,
    );
  });

  it("hides only when offline AND hidden AND no exemption (full combo sweep)", () => {
    // Enumerate every combination of the five inputs; the row shows unless
    // it is offline, the section hides, and none of the three exemptions
    // apply.
    for (const online of [false, true]) {
      for (const showOffline of [false, true]) {
        for (const pinned of [false, true]) {
          for (const unread of [0, 2]) {
            for (const active of [false, true]) {
              const expected =
                online || showOffline || pinned || unread > 0 || active;
              expect(
                keepRow({ online, showOffline, pinned, unread, active }),
              ).toBe(expected);
            }
          }
        }
      }
    }
  });
});
