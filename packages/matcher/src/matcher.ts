// Compatibility matcher (M8 step 6).
//
// PROVENANCE: clean-room implementation of the five-tier compatibility
// scheme popularized by F-Chat Rising/Horizon (MATCH … MISMATCH across
// orientation/gender/age/furry/species/sub-dom, kink alignment, hard
// mismatches dominating the overall score). Behavior derives from the
// scheme's public documentation and observable UI only — no Rising/Horizon
// matcher source was consulted or copied (decisions.md §13,
// milestone-8-nice-to-haves.md "Risks & policy notes").
//
// Inputs are two resolved ProfileDtos (the viewer's own profile and the
// viewed character); everything runs client-side. The golden rule
// throughout: MISSING DATA IS NEUTRAL, never a mismatch — absence of an
// infotag must not read as rejection.

import type { KinkChoice, ProfileDto } from "@emberchat/protocol";

/** The five tiers. `frac` drives the MatchTier pie glyph
 * (COMPONENTS-profile-viewer.md §0): 1 / .75 / .5 / .25 / 0. */
export type MatchTier =
  "match" | "weakMatch" | "neutral" | "weakMismatch" | "mismatch";

export const TIER_FRACTION: Record<MatchTier, number> = {
  match: 1,
  weakMatch: 0.75,
  neutral: 0.5,
  weakMismatch: 0.25,
  mismatch: 0,
};

export type DimensionKey =
  | "orientation"
  | "gender"
  | "age"
  | "furryPreference"
  | "species"
  | "subDomRole";

export interface DimensionResult {
  key: DimensionKey;
  label: string;
  tier: MatchTier;
  /** Human-readable one-liner ("Straight × female — a match"). */
  reason: string;
}

export interface KinkAlignment {
  id: number;
  name: string;
  yourChoice: KinkChoice;
  theirChoice: KinkChoice;
  tier: MatchTier;
}

export interface MatchReport {
  /** Hard-mismatch-dominated aggregate of the six dimensions. */
  overall: MatchTier;
  dimensions: DimensionResult[];
  /** Kinks present on BOTH profiles, worst-first. */
  kinks: KinkAlignment[];
  /** Aggregate over the kink list (neutral when nothing overlaps). */
  kinkOverall: MatchTier;
}

// ── F-List vocabulary ────────────────────────────────────────────────────────
// Infotag ids are stable, published F-List ids (verified during the M8
// step-1 spike; the fchat-sim canned set mirrors them).

export const INFOTAG_IDS = {
  age: 1,
  orientation: 2,
  gender: 3,
  species: 9,
  subDomRole: 15,
  furryPreference: 29,
} as const;

/** Gender-preference kinks, used as a fallback signal when a profile has no
 * orientation infotag (standard F-List kinks "Males" / "Females"). */
export const GENDER_PREF_KINK_IDS = { males: 553, females: 554 } as const;

type GenderGroup = "masculine" | "feminine" | "other";

const GENDER_GROUPS: Record<string, GenderGroup> = {
  male: "masculine",
  "male-herm": "masculine",
  "cunt-boy": "masculine",
  female: "feminine",
  shemale: "feminine",
  herm: "feminine",
  transgender: "other",
  none: "other",
};

/** Species read as human-adjacent for furry-preference purposes. Anything
 * not matched here counts as anthro/non-human; an empty species is unknown. */
const HUMAN_LIKE =
  /human|elf|elven|dwarf|halfling|angel|demon|devil|succub|incub|vampire|witch|wizard|mermaid|nymph|genie|djinn|orc|goblin|giant|fae|fairy|faerie|nephilim|tiefling|aasimar|android|cyborg/i;

const choiceRank: Record<KinkChoice, number> = {
  fave: 3,
  yes: 2,
  maybe: 1,
  no: 0,
};

// ── Profile field access ─────────────────────────────────────────────────────

function infotag(profile: ProfileDto, id: number): string | undefined {
  for (const group of profile.infotagGroups) {
    for (const tag of group.tags) {
      if (tag.id === id) {
        return tag.value.trim() || undefined;
      }
    }
  }
  return undefined;
}

function kinkChoice(profile: ProfileDto, id: number): KinkChoice | undefined {
  return profile.kinks.find((kink) => kink.id === id)?.choice;
}

function genderGroup(profile: ProfileDto): GenderGroup | undefined {
  const value = infotag(profile, INFOTAG_IDS.gender);
  return value ? GENDER_GROUPS[value.toLowerCase()] : undefined;
}

/** Numeric age, when the field is actually a number ("116", "25ish" → 25?
 * no: strict — prose ages like "Ageless" or "varies" are unknown). */
function numericAge(profile: ProfileDto): number | undefined {
  const value = infotag(profile, INFOTAG_IDS.age);
  if (!value || !/^\d{1,5}$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

// ── Dimension scoring ────────────────────────────────────────────────────────

/**
 * How well a character of `group` fits an `orientation`. Fallback: with no
 * orientation, the gender-preference kinks ("Males"/"Females") stand in —
 * fave/yes reads as attraction, no as rejection, absent as unknown.
 */
function orientationFit(
  orientation: string | undefined,
  ownGroup: GenderGroup | undefined,
  theirGroup: GenderGroup | undefined,
  kinkFallback: { males?: KinkChoice; females?: KinkChoice },
): { tier: MatchTier; reason: string } {
  if (!theirGroup) {
    return { tier: "neutral", reason: "Their gender is unspecified" };
  }
  if (!orientation) {
    const pref =
      theirGroup === "masculine"
        ? kinkFallback.males
        : theirGroup === "feminine"
          ? kinkFallback.females
          : undefined;
    if (pref === undefined) {
      return { tier: "neutral", reason: "No orientation listed" };
    }
    if (pref === "no") {
      return {
        tier: "weakMismatch",
        reason: "No orientation listed, but their gender is a 'no' kink",
      };
    }
    return {
      tier: pref === "fave" ? "weakMatch" : "neutral",
      reason: "Inferred from gender-preference kinks",
    };
  }
  const value = orientation.toLowerCase();
  if (value.includes("bisexual") || value.includes("pansexual")) {
    return { tier: "match", reason: `${orientation} — open to any gender` };
  }
  if (value.includes("asexual")) {
    return { tier: "neutral", reason: "Asexual — gender isn't the axis" };
  }
  if (value.includes("unsure") || value.includes("curious")) {
    return { tier: "weakMatch", reason: `${orientation} — possibly open` };
  }
  if (theirGroup === "other") {
    // Binary orientations against nonbinary genders: soft signal only.
    return {
      tier: "weakMatch",
      reason: `${orientation} against a nonbinary gender — unclear`,
    };
  }
  const straight = value.includes("straight") || value.includes("hetero");
  const gay = value.includes("gay") || value.includes("homo");
  if (!straight && !gay) {
    return { tier: "neutral", reason: `Unrecognized orientation` };
  }
  if (!ownGroup || ownGroup === "other") {
    return {
      tier: "neutral",
      reason: `${orientation}, but their own gender is unclear`,
    };
  }
  const same = ownGroup === theirGroup;
  const fits = straight ? !same : same;
  return fits
    ? { tier: "match", reason: `${orientation} — genders align` }
    : { tier: "mismatch", reason: `${orientation} — genders conflict` };
}

function scoreAge(you: ProfileDto, them: ProfileDto): DimensionResult {
  const yours = numericAge(you);
  const theirs = numericAge(them);
  if (yours === undefined || theirs === undefined) {
    return {
      key: "age",
      label: "Age",
      tier: "neutral",
      reason: "Age unspecified or non-numeric",
    };
  }
  const ratio = Math.max(yours, theirs) / Math.max(1, Math.min(yours, theirs));
  if (ratio <= 1.6) {
    return {
      key: "age",
      label: "Age",
      tier: "match",
      reason: `${String(yours)} and ${String(theirs)} — comparable ages`,
    };
  }
  // Large gaps defer to the Age Differences kink on both sides.
  const yourGap = kinkChoice(you, 620);
  const theirGap = kinkChoice(them, 620);
  if (yourGap === "no" || theirGap === "no") {
    return {
      key: "age",
      label: "Age",
      tier: "weakMismatch",
      reason: "Large age gap and Age Differences is a 'no'",
    };
  }
  if (
    (yourGap === "fave" || yourGap === "yes") &&
    (theirGap === "fave" || theirGap === "yes")
  ) {
    return {
      key: "age",
      label: "Age",
      tier: "match",
      reason: "Large age gap, but both like Age Differences",
    };
  }
  return {
    key: "age",
    label: "Age",
    tier: "neutral",
    reason: "Large age gap — no stated preference",
  };
}

/** `pref` (one side's furry preference) against `species` (the other's). */
function furryFit(
  pref: string | undefined,
  species: string | undefined,
): { tier: MatchTier; reason: string } {
  if (!pref) {
    return { tier: "neutral", reason: "No furry preference listed" };
  }
  if (!species) {
    return { tier: "neutral", reason: "Species unspecified" };
  }
  const humanLike = HUMAN_LIKE.test(species);
  const value = pref.toLowerCase();
  if (value.startsWith("no furry")) {
    return humanLike
      ? { tier: "match", reason: `Wants humans; ${species} qualifies` }
      : { tier: "mismatch", reason: `Wants humans only; ${species} is not` };
  }
  if (value.startsWith("no humans")) {
    return humanLike
      ? { tier: "mismatch", reason: `Wants furs only; ${species} is not` }
      : { tier: "match", reason: `Wants furs; ${species} qualifies` };
  }
  if (value.includes("furries preferred")) {
    return humanLike
      ? { tier: "weakMatch", reason: `Prefers furs; ${species} is okay` }
      : { tier: "match", reason: `Prefers furs; ${species} qualifies` };
  }
  if (value.includes("humans preferred")) {
    return humanLike
      ? { tier: "match", reason: `Prefers humans; ${species} qualifies` }
      : { tier: "weakMatch", reason: `Prefers humans; ${species} is okay` };
  }
  // "Furs and / or humans" and anything unrecognized-but-present.
  return value.includes("and / or") || value.includes("and/or")
    ? { tier: "match", reason: "Open to furs and humans alike" }
    : { tier: "neutral", reason: "Unrecognized furry preference" };
}

function scoreSubDom(you: ProfileDto, them: ProfileDto): DimensionResult {
  const yours = infotag(you, INFOTAG_IDS.subDomRole);
  const theirs = infotag(them, INFOTAG_IDS.subDomRole);
  const base = { key: "subDomRole" as const, label: "Dom/Sub role" };
  if (!yours || !theirs) {
    return { ...base, tier: "neutral", reason: "Role unspecified" };
  }
  const lean = (value: string): "dom" | "sub" | "switch" =>
    /dominant/i.test(value)
      ? "dom"
      : /submissive/i.test(value)
        ? "sub"
        : "switch";
  const always = (value: string) => /always/i.test(value);
  const a = lean(yours);
  const b = lean(theirs);
  if (a === "switch" || b === "switch") {
    return a === b
      ? { ...base, tier: "match", reason: "Both switch" }
      : { ...base, tier: "weakMatch", reason: `${yours} with ${theirs}` };
  }
  if (a !== b) {
    return { ...base, tier: "match", reason: `${yours} with ${theirs}` };
  }
  // Same lean: hard when both are "Always", soft otherwise.
  return always(yours) && always(theirs)
    ? { ...base, tier: "mismatch", reason: `Both ${yours.toLowerCase()}` }
    : {
        ...base,
        tier: "weakMismatch",
        reason: `Both lean ${a} — someone has to bend`,
      };
}

// ── Kink alignment ───────────────────────────────────────────────────────────

/** Tier for one shared kink. Symmetric. Shared enthusiasm scales with the
 * weaker side; a 'no' against interest scales with how strong the interest
 * was; shared 'no' is compatibility, not conflict. */
export function kinkTier(a: KinkChoice, b: KinkChoice): MatchTier {
  const [low, high] = choiceRank[a] <= choiceRank[b] ? [a, b] : [b, a];
  if (low === "no") {
    if (high === "fave") {
      return "mismatch";
    }
    if (high === "yes") {
      return "weakMismatch";
    }
    return "neutral"; // no × maybe, no × no
  }
  if (low === "maybe") {
    return "neutral";
  }
  if (low === "yes") {
    return "weakMatch"; // yes × yes, yes × fave
  }
  return "match"; // fave × fave
}

// ── Report ───────────────────────────────────────────────────────────────────

export function match(you: ProfileDto, them: ProfileDto): MatchReport {
  const yourGroup = genderGroup(you);
  const theirGroup = genderGroup(them);

  const genderPrefs = (profile: ProfileDto) => ({
    males: kinkChoice(profile, GENDER_PREF_KINK_IDS.males),
    females: kinkChoice(profile, GENDER_PREF_KINK_IDS.females),
  });

  // "Gender": do THEY fit YOUR orientation. "Orientation": do YOU fit
  // THEIRS. Both direction labels read from the viewer's seat.
  const genderFit = orientationFit(
    infotag(you, INFOTAG_IDS.orientation),
    yourGroup,
    theirGroup,
    genderPrefs(you),
  );
  const orientationBack = orientationFit(
    infotag(them, INFOTAG_IDS.orientation),
    theirGroup,
    yourGroup,
    genderPrefs(them),
  );

  const furryOut = furryFit(
    infotag(you, INFOTAG_IDS.furryPreference),
    infotag(them, INFOTAG_IDS.species),
  );
  const furryBack = furryFit(
    infotag(them, INFOTAG_IDS.furryPreference),
    infotag(you, INFOTAG_IDS.species),
  );

  const dimensions: DimensionResult[] = [
    {
      key: "gender",
      label: "Gender",
      tier: genderFit.tier,
      reason: genderFit.reason,
    },
    {
      key: "orientation",
      label: "Orientation",
      tier: orientationBack.tier,
      reason: orientationBack.reason,
    },
    scoreAge(you, them),
    {
      key: "furryPreference",
      label: "Furry preference",
      tier: furryOut.tier,
      reason: furryOut.reason,
    },
    {
      key: "species",
      label: "Species",
      tier: furryBack.tier,
      reason: furryBack.reason,
    },
    scoreSubDom(you, them),
  ];

  const theirKinks = new Map(them.kinks.map((kink) => [kink.id, kink]));
  const kinks: KinkAlignment[] = [];
  for (const kink of you.kinks) {
    const theirs = theirKinks.get(kink.id);
    if (!theirs) {
      continue;
    }
    kinks.push({
      id: kink.id,
      name: kink.name,
      yourChoice: kink.choice,
      theirChoice: theirs.choice,
      tier: kinkTier(kink.choice, theirs.choice),
    });
  }
  kinks.sort(
    (a, b) =>
      TIER_FRACTION[a.tier] - TIER_FRACTION[b.tier] ||
      a.name.localeCompare(b.name),
  );

  return {
    overall: aggregate(dimensions.map((dimension) => dimension.tier)),
    dimensions,
    kinks,
    kinkOverall: aggregate(kinks.map((kink) => kink.tier)),
  };
}

/** Hard-mismatch-dominated aggregate: any mismatch sinks the whole score;
 * otherwise the mean of the non-neutral tiers, rounded to a tier; all
 * neutral (or empty) stays neutral. */
export function aggregate(tiers: MatchTier[]): MatchTier {
  if (tiers.includes("mismatch")) {
    return "mismatch";
  }
  const informative = tiers.filter((tier) => tier !== "neutral");
  if (informative.length === 0) {
    return "neutral";
  }
  const mean =
    informative.reduce((sum, tier) => sum + TIER_FRACTION[tier], 0) /
    informative.length;
  if (mean >= 0.875) {
    return "match";
  }
  if (mean >= 0.625) {
    return "weakMatch";
  }
  if (mean > 0.375) {
    return "neutral";
  }
  if (mean > 0.125) {
    return "weakMismatch";
  }
  return "mismatch";
}
