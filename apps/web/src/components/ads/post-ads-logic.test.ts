import { describe, expect, it } from "vitest";
import type { AdDto } from "@emberchat/protocol";
import {
  filterAds,
  formatWait,
  parseAdsCadence,
  tagCounts,
} from "./post-ads-logic.js";

function ad(id: string, tags: string[], disabled = false): AdDto {
  return { id, content: `ad ${id}`, tags, disabled };
}

describe("parseAdsCadence", () => {
  it("parses the community [ads: N min] convention, case-insensitive", () => {
    expect(parseAdsCadence("cozy scenes · [ads: 15 min] please")).toBe(15);
    expect(parseAdsCadence("[ADS: 30 MINUTES]")).toBe(30);
    expect(parseAdsCadence("[ads:10min]")).toBe(10);
  });

  it("ignores descriptions without the token or with nonsense values", () => {
    expect(parseAdsCadence("no ads here")).toBeUndefined();
    expect(parseAdsCadence("[ads: soon]")).toBeUndefined();
    expect(parseAdsCadence("[ads: 0 min]")).toBeUndefined();
  });
});

describe("tagCounts", () => {
  it("counts tags across enabled ads with an 'all' chip up front", () => {
    const ads = [
      ad("1", ["winter", "slowburn"]),
      ad("2", ["winter"]),
      ad("3", ["event"], true), // disabled — never counted
    ];
    expect(tagCounts(ads)).toEqual([
      { tag: "all", count: 2 },
      { tag: "slowburn", count: 1 },
      { tag: "winter", count: 2 },
    ]);
  });
});

describe("filterAds", () => {
  const ads = [
    ad("1", ["winter"]),
    ad("2", ["plot"]),
    ad("3", ["winter"], true),
  ];

  it("keeps library indices so selection survives filtering", () => {
    expect(filterAds(ads, "winter").map((x) => x.index)).toEqual([0]);
    expect(filterAds(ads, "all").map((x) => x.index)).toEqual([0, 1]);
    expect(filterAds(ads, "nope")).toEqual([]);
  });
});

describe("formatWait", () => {
  it("rounds up so a channel is never called clear early", () => {
    expect(formatWait(600_000)).toBe("10m");
    expect(formatWait(61_000)).toBe("2m");
    expect(formatWait(59_000)).toBe("59s");
    expect(formatWait(400)).toBe("1s");
  });
});
