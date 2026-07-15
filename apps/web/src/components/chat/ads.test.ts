import { describe, expect, it } from "vitest";
import { adsHidden, toggleChannelAds } from "./ads.js";

describe("adsHidden", () => {
  it("inherits the global default when a channel has no override", () => {
    expect(adsHidden({ hideAds: false, channelAdVisibility: {} }, "Dev")).toBe(
      false,
    );
    expect(adsHidden({ hideAds: true, channelAdVisibility: {} }, "Dev")).toBe(
      true,
    );
  });

  it("lets a per-channel override win in both directions, case-insensitively", () => {
    expect(
      adsHidden(
        { hideAds: false, channelAdVisibility: { "adh-123": "hide" } },
        "ADH-123",
      ),
    ).toBe(true);
    expect(
      adsHidden(
        { hideAds: true, channelAdVisibility: { development: "show" } },
        "Development",
      ),
    ).toBe(false);
  });

  it("falls back to the global default without a channel key", () => {
    expect(
      adsHidden({ hideAds: true, channelAdVisibility: {} }, undefined),
    ).toBe(true);
  });
});

describe("toggleChannelAds", () => {
  it("adds an override when flipping away from the global default", () => {
    expect(
      toggleChannelAds({ hideAds: false, channelAdVisibility: {} }, "Dev"),
    ).toEqual({ channelAdVisibility: { dev: "hide" } });
    expect(
      toggleChannelAds({ hideAds: true, channelAdVisibility: {} }, "Dev"),
    ).toEqual({ channelAdVisibility: { dev: "show" } });
  });

  it("prunes the override when flipping back to the global default", () => {
    expect(
      toggleChannelAds(
        { hideAds: false, channelAdVisibility: { dev: "hide", other: "show" } },
        "Dev",
      ),
    ).toEqual({ channelAdVisibility: { other: "show" } });
  });
});
