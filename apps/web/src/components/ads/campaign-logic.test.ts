import { describe, expect, it } from "vitest";
import type { AdDto, CampaignDto } from "@emberchat/protocol";
import {
  campaignPhase,
  channelCounts,
  effectiveIntervalText,
  elapsedFraction,
  formatExpiry,
  formatIn,
  resolveCycle,
  statusIntervalText,
  totalPosts,
} from "./campaign-logic.js";

const BASE: CampaignDto = {
  id: "c1",
  tags: ["winter"],
  startedAt: 1_000_000,
  expiresAt: 1_000_000 + 3_600_000,
  attached: true,
  channels: [
    { key: "a", state: "active", nextAt: 1_100_000, posts: 3 },
    { key: "b", state: "refused", retryAt: 1_200_000, posts: 1 },
    { key: "c", state: "removed", posts: 0 },
  ],
};

describe("campaignPhase", () => {
  it("orders stopped over expired over detached over live", () => {
    expect(campaignPhase(BASE, 1_000_001)).toBe("live");
    expect(campaignPhase({ ...BASE, attached: false }, 1_000_001)).toBe(
      "detached",
    );
    expect(campaignPhase(BASE, BASE.expiresAt)).toBe("expired");
    expect(campaignPhase({ ...BASE, stoppedAt: 1_000_500 }, 1_000_001)).toBe(
      "stopped",
    );
  });
});

describe("clock formatting", () => {
  it("counts down minutes:seconds and never goes negative", () => {
    expect(formatExpiry(1_000_000 + 61_000, 1_000_000)).toBe("1:01");
    expect(formatExpiry(1_000_000, 1_000_000 + 5_000)).toBe("0:00");
  });

  it("rounds the next-post distance up to minutes", () => {
    expect(formatIn(1_000_000 + 90_000, 1_000_000)).toBe("in 2m");
    expect(formatIn(1_000_000, 1_000_000 + 1)).toBe("any moment");
  });
});

describe("effectiveIntervalText", () => {
  it("shows the base window unless the channel asks for more", () => {
    expect(effectiveIntervalText("no token here")).toEqual({
      text: "≈ one ad every 12–22 min",
      honored: false,
    });
    // A request at or below the floor changes nothing.
    expect(effectiveIntervalText("[ads: 10 min]").honored).toBe(false);
    expect(effectiveIntervalText("please [ads: 20 min]")).toEqual({
      text: "≈ one ad every 20 min · honoring [ads: 20 min]",
      honored: true,
    });
  });
});

describe("resolveCycle", () => {
  it("keeps enabled ads carrying any selected tag, in order", () => {
    const ads: AdDto[] = [
      { id: "1", content: "one", tags: ["Winter"], disabled: false },
      { id: "2", content: "two", tags: ["plot"], disabled: false },
      { id: "3", content: "three", tags: ["winter"], disabled: true },
      { id: "4", content: "four", tags: ["winter", "plot"], disabled: false },
    ];
    expect(resolveCycle(ads, ["winter"]).map((ad) => ad.id)).toEqual([
      "1",
      "4",
    ]);
    expect(resolveCycle(ads, ["winter", "plot"]).map((ad) => ad.id)).toEqual([
      "1",
      "2",
      "4",
    ]);
  });
});

describe("status aggregates", () => {
  it("counts channel states and total posts", () => {
    expect(channelCounts(BASE)).toEqual({ active: 1, waiting: 1, stopped: 1 });
    expect(totalPosts(BASE)).toBe(4);
  });

  it("clamps the elapsed fraction", () => {
    expect(elapsedFraction(0, 100, 50)).toBe(0.5);
    expect(elapsedFraction(0, 100, 200)).toBe(1);
    expect(elapsedFraction(0, 100, -10)).toBe(0);
    expect(elapsedFraction(100, 100, 100)).toBe(1);
  });
});

describe("statusIntervalText", () => {
  it("renders sentences, never the bracket token", () => {
    expect(statusIntervalText("plain room")).toBe("every 12–22 min");
    expect(statusIntervalText("[ads: 20 min]")).toBe(
      "every ≈20 min · honoring their request",
    );
    expect(statusIntervalText("[ads: 5 min]")).toBe("every 12–22 min");
  });
});
