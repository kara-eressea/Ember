// Chip selection + summary copy over a MatchReport.

import { describe, expect, it } from "vitest";
import type { MatchReport } from "@emberchat/matcher";
import { compareSummary, notableDimensions } from "./match-utils.js";

function report(overrides: Partial<MatchReport> = {}): MatchReport {
  return {
    overall: "neutral",
    dimensions: [
      { key: "gender", label: "Gender", tier: "match", reason: "fits" },
      {
        key: "orientation",
        label: "Orientation",
        tier: "neutral",
        reason: "unknown",
      },
      { key: "age", label: "Age", tier: "weakMismatch", reason: "gap" },
      {
        key: "furryPreference",
        label: "Furry preference",
        tier: "mismatch",
        reason: "humans only",
      },
      { key: "species", label: "Species", tier: "neutral", reason: "unknown" },
      {
        key: "subDomRole",
        label: "Sub/Dom role",
        tier: "weakMatch",
        reason: "both switch",
      },
    ],
    kinks: [],
    kinkOverall: "neutral",
    ...overrides,
  };
}

describe("notableDimensions", () => {
  it("drops neutral rows and puts extremes first, conflicts on ties", () => {
    const notable = notableDimensions(report(), 4);
    expect(notable.map((entry) => entry.label)).toEqual([
      "Furry preference", // mismatch (extreme, conflict wins the tie)
      "Gender", // match (extreme)
      "Age", // weakMismatch
      "Sub/Dom role", // weakMatch
    ]);
  });

  it("caps at the limit", () => {
    expect(notableDimensions(report(), 2)).toHaveLength(2);
  });

  it("adds a Kinks pseudo-chip only when kinks overlap", () => {
    const withKinks = notableDimensions(
      report({
        kinks: [
          {
            id: 8,
            name: "Dirty Talking",
            yourChoice: "fave",
            theirChoice: "fave",
            tier: "match",
          },
        ],
        kinkOverall: "match",
      }),
      9,
    );
    expect(withKinks.map((entry) => entry.label)).toContain("Kinks");
    expect(
      notableDimensions(report(), 9).map((entry) => entry.label),
    ).not.toContain("Kinks");
  });

  it("returns nothing for an all-neutral report", () => {
    const allNeutral = report();
    for (const dimension of allNeutral.dimensions) {
      dimension.tier = "neutral";
    }
    expect(notableDimensions(allNeutral, 4)).toEqual([]);
  });
});

describe("compareSummary", () => {
  it("counts the conflicts into the weak-match line", () => {
    expect(compareSummary(report({ overall: "weakMatch" }), "Vesna")).toBe(
      "Broadly compatible, with 2 points of friction below.",
    );
  });

  it("names the character on the hard-conflict line", () => {
    expect(compareSummary(report({ overall: "mismatch" }), "Vesna")).toContain(
      "Vesna",
    );
  });

  it("stays honest when there is no overlapping data", () => {
    expect(compareSummary(report(), "Vesna")).toMatch(/Not enough/);
  });
});
