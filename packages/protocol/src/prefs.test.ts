import { describe, expect, it } from "vitest";
import { clientFrameSchema } from "./gateway.js";
import {
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

  it("defaults hideOfflineCharacters to on and honors a stored false", () => {
    expect(resolvePrefs({}).hideOfflineCharacters).toBe(true);
    expect(
      resolvePrefs({ hideOfflineCharacters: false }).hideOfflineCharacters,
    ).toBe(false);
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
