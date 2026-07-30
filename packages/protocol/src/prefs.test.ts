import { describe, expect, it } from "vitest";
import { clientFrameSchema } from "./gateway.js";
import {
  DEFAULT_IMAGE_PREVIEW_HOSTS,
  PREFS_DEFAULTS,
  resolvePrefs,
  userPrefsPatchSchema,
  userPrefsSchema,
} from "./prefs.js";

describe("PREFS_DEFAULTS", () => {
  it("covers every field and satisfies the schema", () => {
    // A field added to the shape without a default here would make
    // resolvePrefs silently emit `undefined` for it.
    expect(Object.keys(PREFS_DEFAULTS).sort()).toEqual(
      Object.keys(userPrefsSchema.shape).sort(),
    );
    expect(userPrefsSchema.parse(PREFS_DEFAULTS)).toEqual(PREFS_DEFAULTS);
  });
});

describe("userPrefsPatchSchema", () => {
  it("accepts any subset of fields", () => {
    expect(userPrefsPatchSchema.parse({})).toEqual({});
    expect(userPrefsPatchSchema.parse({ accent: "moss" })).toEqual({
      accent: "moss",
    });
  });

  it("rejects invalid values strictly — a bad patch is the client's error", () => {
    expect(userPrefsPatchSchema.safeParse({ accent: "neon" }).success).toBe(
      false,
    );
  });

  it("strips unknown keys so they never reach the stored document", () => {
    expect(userPrefsPatchSchema.parse({ mystery: true })).toEqual({});
  });
});

describe("imagePreviewHosts (#215)", () => {
  it("defaults to the known-good allowlist", () => {
    expect(PREFS_DEFAULTS.imagePreviewHosts).toEqual([
      ...DEFAULT_IMAGE_PREVIEW_HOSTS,
    ]);
  });

  it("accepts a list of bare hostnames", () => {
    expect(
      userPrefsPatchSchema.safeParse({
        imagePreviewHosts: ["imgur.com", "i.gyazo.com", "static.f-list.net"],
      }).success,
    ).toBe(true);
    // Empty list (user removed everything) is valid.
    expect(
      userPrefsPatchSchema.safeParse({ imagePreviewHosts: [] }).success,
    ).toBe(true);
  });

  it("rejects entries carrying a scheme, path, or non-hostname text", () => {
    for (const bad of [
      "https://imgur.com",
      "imgur.com/foo",
      "imgur.com:443",
      "not a host",
      "localhost",
    ]) {
      expect(
        userPrefsPatchSchema.safeParse({ imagePreviewHosts: [bad] }).success,
        bad,
      ).toBe(false);
    }
  });

  it("resolves a stored garbage value back to the default list", () => {
    expect(
      resolvePrefs({ imagePreviewHosts: "nope" }).imagePreviewHosts,
    ).toEqual([...DEFAULT_IMAGE_PREVIEW_HOSTS]);
  });
});

describe("prefs.set frame", () => {
  const frame = (d: unknown) => ({
    t: "cmd",
    id: 1,
    d: {
      identityId: "11111111-1111-7111-8111-111111111111",
      action: "prefs.set",
      d,
    },
  });

  it("refuses an empty patch and accepts either field alone", () => {
    expect(clientFrameSchema.safeParse(frame({})).success).toBe(false);
    // The M4 composer shape (sendDelaySeconds only) stays valid.
    expect(
      clientFrameSchema.safeParse(frame({ sendDelaySeconds: 30 })).success,
    ).toBe(true);
    expect(
      clientFrameSchema.safeParse(frame({ prefs: { accent: "moss" } })).success,
    ).toBe(true);
  });
});

describe("resolvePrefs", () => {
  it("resolves absent, empty, and non-object documents to the defaults", () => {
    expect(resolvePrefs(undefined)).toEqual(PREFS_DEFAULTS);
    expect(resolvePrefs(null)).toEqual(PREFS_DEFAULTS);
    expect(resolvePrefs({})).toEqual(PREFS_DEFAULTS);
    expect(resolvePrefs("garbage")).toEqual(PREFS_DEFAULTS);
    expect(resolvePrefs(42)).toEqual(PREFS_DEFAULTS);
  });

  it("defaults the three per-section show-offline prefs to hide (#329)", () => {
    const resolved = resolvePrefs({});
    expect(resolved.showOfflineFriends).toBe(false);
    expect(resolved.showOfflineBookmarks).toBe(false);
    expect(resolved.showOfflineDms).toBe(false);
  });

  it("seeds all three sections from the legacy hideOfflineCharacters (#329)", () => {
    // A pre-#329 "show everyone" (hide === false) becomes show-offline in
    // every section, so nobody's visible list changes on upgrade.
    const shown = resolvePrefs({ hideOfflineCharacters: false });
    expect(shown.showOfflineFriends).toBe(true);
    expect(shown.showOfflineBookmarks).toBe(true);
    expect(shown.showOfflineDms).toBe(true);

    // The common legacy hide (true) matches the new per-section default.
    const hidden = resolvePrefs({ hideOfflineCharacters: true });
    expect(hidden.showOfflineFriends).toBe(false);
    expect(hidden.showOfflineBookmarks).toBe(false);
    expect(hidden.showOfflineDms).toBe(false);
  });

  it("lets a stored per-section key win over the legacy seed (#329)", () => {
    // Once a client has written the new keys, migration must not clobber
    // them — a section explicitly set wins regardless of the legacy value.
    const resolved = resolvePrefs({
      hideOfflineCharacters: false,
      showOfflineBookmarks: false,
    });
    expect(resolved.showOfflineFriends).toBe(true);
    expect(resolved.showOfflineBookmarks).toBe(false);
    expect(resolved.showOfflineDms).toBe(true);
  });

  it("keeps stored values that are valid", () => {
    expect(resolvePrefs({ accent: "clay" })).toEqual({
      ...PREFS_DEFAULTS,
      accent: "clay",
    });
  });

  it("falls back per field on invalid stored values", () => {
    // Stored history is untrusted (a since-removed enum member, say) —
    // the bad field defaults without dragging the document down.
    expect(resolvePrefs({ accent: "neon" })).toEqual(PREFS_DEFAULTS);
  });

  it("ignores unknown stored keys", () => {
    expect(resolvePrefs({ accent: "moss", legacy: 1 })).toEqual({
      ...PREFS_DEFAULTS,
      accent: "moss",
    });
  });
});

describe("resolvePrefs M6→M10 ad-view migration", () => {
  it("maps hideAds:true onto adViewDefault chat, once", () => {
    expect(resolvePrefs({ hideAds: true })).toEqual({
      ...PREFS_DEFAULTS,
      adViewDefault: "chat",
    });
    expect(resolvePrefs({ hideAds: false })).toEqual(PREFS_DEFAULTS);
    // A written tri-state wins over the legacy boolean.
    expect(resolvePrefs({ hideAds: true, adViewDefault: "both" })).toEqual(
      PREFS_DEFAULTS,
    );
  });

  it("maps channelAdVisibility onto channelAdView (hide→chat, show→both)", () => {
    expect(
      resolvePrefs({ channelAdVisibility: { dev: "hide", garden: "show" } }),
    ).toEqual({
      ...PREFS_DEFAULTS,
      channelAdView: { dev: "chat", garden: "both" },
    });
    // A written record wins over the legacy one.
    expect(
      resolvePrefs({
        channelAdVisibility: { dev: "hide" },
        channelAdView: { dev: "ads" },
      }),
    ).toEqual({ ...PREFS_DEFAULTS, channelAdView: { dev: "ads" } });
  });

  it("ignores a malformed legacy record", () => {
    expect(resolvePrefs({ channelAdVisibility: { dev: "sideways" } })).toEqual(
      PREFS_DEFAULTS,
    );
  });
});
