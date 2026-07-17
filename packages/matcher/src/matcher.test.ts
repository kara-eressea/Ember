// Golden-pair tests: fixture profiles per dimension, plus the two invariants
// that must never regress — missing data is NEUTRAL (never a mismatch) and
// one hard mismatch dominates the overall score.

import { describe, expect, it } from "vitest";
import type { KinkChoice, ProfileDto } from "@emberchat/protocol";
import {
  aggregate,
  INFOTAG_IDS,
  kinkTier,
  match,
  TIER_FRACTION,
} from "./matcher.js";

interface ProfileSeed {
  age?: string;
  orientation?: string;
  gender?: string;
  species?: string;
  subDomRole?: string;
  furryPreference?: string;
  kinks?: { id: number; name?: string; choice: KinkChoice }[];
}

function profile(seed: ProfileSeed): ProfileDto {
  const tags: { id: number; label: string; value: string }[] = [];
  const push = (id: number, label: string, value?: string) => {
    if (value !== undefined) {
      tags.push({ id, label, value });
    }
  };
  push(INFOTAG_IDS.age, "Age", seed.age);
  push(INFOTAG_IDS.orientation, "Orientation", seed.orientation);
  push(INFOTAG_IDS.gender, "Gender", seed.gender);
  push(INFOTAG_IDS.species, "Species", seed.species);
  push(INFOTAG_IDS.subDomRole, "Dom/Sub Role", seed.subDomRole);
  push(INFOTAG_IDS.furryPreference, "Furry preference", seed.furryPreference);
  return {
    id: 1,
    name: "Fixture",
    description: "",
    views: 0,
    customTitle: null,
    customsFirst: false,
    createdAt: null,
    updatedAt: null,
    settings: {
      guestbook: false,
      showFriends: false,
      preventBookmarks: false,
      public: true,
    },
    badges: [],
    infotagGroups: [{ group: "General details", tags }],
    kinks: (seed.kinks ?? []).map((kink) => ({
      id: kink.id,
      name: kink.name ?? `Kink ${String(kink.id)}`,
      description: "",
      choice: kink.choice,
    })),
    customKinks: [],
    images: [],
    timezone: null,
  };
}

function dimension(report: ReturnType<typeof match>, key: string) {
  return report.dimensions.find((entry) => entry.key === key)!;
}

describe("gender/orientation dimensions", () => {
  it("straight × opposite binary genders match both ways", () => {
    const report = match(
      profile({ orientation: "Straight", gender: "Male" }),
      profile({ orientation: "Straight", gender: "Female" }),
    );
    expect(dimension(report, "gender").tier).toBe("match");
    expect(dimension(report, "orientation").tier).toBe("match");
  });

  it("gay × same gender matches; straight × same gender hard-mismatches", () => {
    const gay = match(
      profile({ orientation: "Gay", gender: "Male" }),
      profile({ orientation: "Gay", gender: "Male" }),
    );
    expect(dimension(gay, "gender").tier).toBe("match");
    const straight = match(
      profile({ orientation: "Straight", gender: "Male" }),
      profile({ orientation: "Straight", gender: "Male" }),
    );
    expect(dimension(straight, "gender").tier).toBe("mismatch");
    expect(straight.overall).toBe("mismatch");
  });

  it("bisexual/pansexual match any gender; nonbinary against binary orientations reads soft", () => {
    const bi = match(
      profile({ orientation: "Bisexual", gender: "Female" }),
      profile({ gender: "Herm" }),
    );
    expect(dimension(bi, "gender").tier).toBe("match");
    const nonbinary = match(
      profile({ orientation: "Straight", gender: "Male" }),
      profile({ gender: "Transgender" }),
    );
    expect(dimension(nonbinary, "gender").tier).toBe("weakMatch");
  });

  it("no orientation falls back to gender-preference kinks", () => {
    const withFallback = match(
      profile({ gender: "Male", kinks: [{ id: 554, choice: "fave" }] }),
      profile({ gender: "Female" }),
    );
    expect(dimension(withFallback, "gender").tier).toBe("weakMatch");
    const rejecting = match(
      profile({ gender: "Male", kinks: [{ id: 553, choice: "no" }] }),
      profile({ gender: "Male" }),
    );
    expect(dimension(rejecting, "gender").tier).toBe("weakMismatch");
  });
});

describe("age dimension", () => {
  it("comparable ages match; non-numeric ages are neutral", () => {
    expect(
      dimension(match(profile({ age: "25" }), profile({ age: "31" })), "age")
        .tier,
    ).toBe("match");
    expect(
      dimension(
        match(profile({ age: "Ageless" }), profile({ age: "25" })),
        "age",
      ).tier,
    ).toBe("neutral");
  });

  it("large gaps defer to the Age Differences kink", () => {
    const both = match(
      profile({ age: "25", kinks: [{ id: 620, choice: "fave" }] }),
      profile({ age: "116", kinks: [{ id: 620, choice: "yes" }] }),
    );
    expect(dimension(both, "age").tier).toBe("match");
    const refused = match(
      profile({ age: "25", kinks: [{ id: 620, choice: "no" }] }),
      profile({ age: "116" }),
    );
    expect(dimension(refused, "age").tier).toBe("weakMismatch");
    const unstated = match(profile({ age: "25" }), profile({ age: "116" }));
    expect(dimension(unstated, "age").tier).toBe("neutral");
  });
});

describe("furry preference / species dimensions", () => {
  it("humans-only against an anthro species hard-mismatches; the mirror scores their preference", () => {
    const report = match(
      profile({
        furryPreference: "No furry characters, just humans",
        species: "Human",
      }),
      profile({ furryPreference: "Furs and / or humans", species: "Red Fox" }),
    );
    expect(dimension(report, "furryPreference").tier).toBe("mismatch");
    expect(dimension(report, "species").tier).toBe("match");
    expect(report.overall).toBe("mismatch");
  });

  it("fantasy humanoids count as human-adjacent; preferences grade softly", () => {
    const elf = match(
      profile({ furryPreference: "Humans ok, Furries Preferred" }),
      profile({ species: "Elf" }),
    );
    expect(dimension(elf, "furryPreference").tier).toBe("weakMatch");
    const missing = match(profile({}), profile({ species: "Dragon" }));
    expect(dimension(missing, "furryPreference").tier).toBe("neutral");
  });
});

describe("sub/dom dimension", () => {
  it("dom × sub matches, switch pairs are soft, both-always-dominant hard-mismatches", () => {
    expect(
      dimension(
        match(
          profile({ subDomRole: "Always dominant" }),
          profile({ subDomRole: "Usually submissive" }),
        ),
        "subDomRole",
      ).tier,
    ).toBe("match");
    expect(
      dimension(
        match(
          profile({ subDomRole: "Switch" }),
          profile({ subDomRole: "Usually dominant" }),
        ),
        "subDomRole",
      ).tier,
    ).toBe("weakMatch");
    const clash = match(
      profile({ subDomRole: "Always dominant" }),
      profile({ subDomRole: "Always dominant" }),
    );
    expect(dimension(clash, "subDomRole").tier).toBe("mismatch");
    expect(
      dimension(
        match(
          profile({ subDomRole: "Usually submissive" }),
          profile({ subDomRole: "Usually submissive" }),
        ),
        "subDomRole",
      ).tier,
    ).toBe("weakMismatch");
  });
});

describe("kink alignment", () => {
  it("scores the shared-kink matrix symmetrically and sorts worst-first", () => {
    expect(kinkTier("fave", "fave")).toBe("match");
    expect(kinkTier("fave", "yes")).toBe("weakMatch");
    expect(kinkTier("yes", "yes")).toBe("weakMatch");
    expect(kinkTier("maybe", "fave")).toBe("neutral");
    expect(kinkTier("no", "yes")).toBe("weakMismatch");
    expect(kinkTier("no", "fave")).toBe("mismatch");
    expect(kinkTier("fave", "no")).toBe(kinkTier("no", "fave"));
    // Shared dislike is compatibility, not conflict.
    expect(kinkTier("no", "no")).toBe("neutral");

    const report = match(
      profile({
        kinks: [
          { id: 1, name: "Alpha", choice: "fave" },
          { id: 2, name: "Beta", choice: "fave" },
          { id: 3, name: "OnlyMine", choice: "yes" },
        ],
      }),
      profile({
        kinks: [
          { id: 1, name: "Alpha", choice: "no" },
          { id: 2, name: "Beta", choice: "fave" },
        ],
      }),
    );
    // Unshared kinks are omitted; worst first.
    expect(report.kinks.map((kink) => kink.name)).toEqual(["Alpha", "Beta"]);
    expect(report.kinks[0]?.tier).toBe("mismatch");
    expect(report.kinkOverall).toBe("mismatch");
  });
});

describe("invariants", () => {
  it("two empty profiles are neutral everywhere — absence is never rejection", () => {
    const report = match(profile({}), profile({}));
    for (const entry of report.dimensions) {
      expect(entry.tier).toBe("neutral");
    }
    expect(report.overall).toBe("neutral");
    expect(report.kinks).toEqual([]);
    expect(report.kinkOverall).toBe("neutral");
  });

  it("one hard mismatch dominates an otherwise perfect pairing", () => {
    const report = match(
      profile({
        age: "25",
        orientation: "Straight",
        gender: "Male",
        species: "Human",
        subDomRole: "Always dominant",
        furryPreference: "No furry characters, just humans",
      }),
      profile({
        age: "27",
        orientation: "Straight",
        gender: "Female",
        species: "Wolf", // the one conflict
        subDomRole: "Always submissive",
        furryPreference: "Furs and / or humans",
      }),
    );
    expect(dimension(report, "furryPreference").tier).toBe("mismatch");
    expect(report.overall).toBe("mismatch");
  });

  it("aggregate rounds the informative mean and ignores neutrals", () => {
    expect(aggregate([])).toBe("neutral");
    expect(aggregate(["neutral", "neutral"])).toBe("neutral");
    expect(aggregate(["match", "match", "neutral"])).toBe("match");
    // Exact tier midpoints round toward the friendlier tier.
    expect(aggregate(["match", "weakMatch"])).toBe("match");
    expect(aggregate(["weakMatch", "weakMatch"])).toBe("weakMatch");
    expect(aggregate(["match", "weakMatch", "weakMatch"])).toBe("weakMatch");
    expect(aggregate(["weakMismatch", "weakMismatch"])).toBe("weakMismatch");
    expect(aggregate(["match", "mismatch"])).toBe("mismatch");
  });

  it("tier fractions encode the pie glyph exactly", () => {
    expect(TIER_FRACTION).toEqual({
      match: 1,
      weakMatch: 0.75,
      neutral: 0.5,
      weakMismatch: 0.25,
      mismatch: 0,
    });
  });
});
