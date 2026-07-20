import { describe, expect, it } from "vitest";
import { adViewFor, setChannelAdView, viewShows } from "./ads.js";

describe("adViewFor", () => {
  it("inherits the default when a channel has no override", () => {
    expect(adViewFor({ adViewDefault: "both", channelAdView: {} }, "Dev")).toBe(
      "both",
    );
    expect(adViewFor({ adViewDefault: "chat", channelAdView: {} }, "Dev")).toBe(
      "chat",
    );
  });

  it("lets a per-channel override win, case-insensitively", () => {
    expect(
      adViewFor(
        { adViewDefault: "both", channelAdView: { "adh-123": "ads" } },
        "ADH-123",
      ),
    ).toBe("ads");
    expect(
      adViewFor(
        { adViewDefault: "chat", channelAdView: { development: "both" } },
        "Development",
      ),
    ).toBe("both");
  });

  it("falls back to the default without a channel key", () => {
    expect(
      adViewFor({ adViewDefault: "chat", channelAdView: {} }, undefined),
    ).toBe("chat");
  });
});

describe("setChannelAdView", () => {
  it("stores an override that differs from the default", () => {
    expect(
      setChannelAdView(
        { adViewDefault: "both", channelAdView: {} },
        "Dev",
        "ads",
      ),
    ).toEqual({ channelAdView: { dev: "ads" } });
  });

  it("prunes an override that restates the default", () => {
    expect(
      setChannelAdView(
        { adViewDefault: "both", channelAdView: { dev: "chat" } },
        "Dev",
        "both",
      ),
    ).toEqual({ channelAdView: {} });
  });

  it("leaves unrelated overrides alone", () => {
    expect(
      setChannelAdView(
        { adViewDefault: "both", channelAdView: { other: "ads" } },
        "Dev",
        "chat",
      ),
    ).toEqual({ channelAdView: { other: "ads", dev: "chat" } });
  });
});

describe("viewShows", () => {
  it("chat hides ads, ads hides chat, both hides nothing", () => {
    expect(viewShows("chat", "lrp")).toBe(false);
    expect(viewShows("chat", "msg")).toBe(true);
    expect(viewShows("ads", "msg")).toBe(false);
    expect(viewShows("ads", "lrp")).toBe(true);
    expect(viewShows("both", "lrp")).toBe(true);
    expect(viewShows("both", "msg")).toBe(true);
  });

  it("never filters system lines or rolls", () => {
    for (const view of ["chat", "ads", "both"] as const) {
      expect(viewShows(view, "sys")).toBe(true);
      expect(viewShows(view, "rll")).toBe(true);
    }
  });
});
