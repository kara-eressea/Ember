// Compare tab (COMPONENTS-profile-viewer.md §9, frames P·D/P·E): your
// active character vs. theirs. Header = overall pill + one-line summary;
// §9a dimension table (six rows, values from both profiles, reason on
// hover); §9b kink alignment, worst-first, with the conflicts-only filter.
// The matcher runs client-side over the two resolved ProfileDtos.

import { useMemo, useState } from "react";
import { INFOTAG_IDS, match, type MatchReport } from "@emberchat/matcher";
import type { ProfileDto } from "@emberchat/protocol";
import { nickColor } from "../../theme/tokens.js";
import { loadOwnProfile, useProfileStore } from "../../stores/profile.js";
import { choiceOf } from "./choices.js";
import { compareSummary } from "./match-utils.js";
import { MatchPill, TierPie, TIER_COLOR } from "./MatchTier.js";
import styles from "./profile.module.css";

export function CompareTab({
  identityId,
  profile,
  ownProfile,
  ownCharacter,
}: {
  identityId: string;
  profile: ProfileDto;
  ownProfile: ProfileDto | undefined;
  ownCharacter: string | undefined;
}) {
  const ownProfileError = useProfileStore((s) => s.ownProfileError);
  const self =
    ownCharacter !== undefined &&
    profile.name.toLowerCase() === ownCharacter.toLowerCase();
  const report = useMemo(
    () => (ownProfile && !self ? match(ownProfile, profile) : undefined),
    [ownProfile, profile, self],
  );

  if (self) {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyTile} aria-hidden>
          ⇄
        </span>
        <span className={styles.emptyTitle}>This is you</span>
        <span className={styles.emptyBody}>
          Open another character's profile to compare it with {profile.name}.
        </span>
      </div>
    );
  }
  if (!report || !ownProfile || ownCharacter === undefined) {
    const failed = ownProfileError !== undefined && !ownProfile;
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyTile} aria-hidden>
          ⇄
        </span>
        <span className={styles.emptyTitle}>
          {failed ? "Couldn't load your profile" : "No match data"}
        </span>
        <span className={styles.emptyBody}>
          {failed
            ? `Your own character's profile couldn't be loaded: ${ownProfileError}`
            : "Your own character's profile hasn't loaded yet, so there is nothing to compare against. It loads automatically — try again in a moment."}
        </span>
        {failed && ownCharacter !== undefined && (
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              void loadOwnProfile(identityId, ownCharacter, true);
            }}
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <div className={styles.cmpHead}>
        <MatchPill tier={report.overall} />
        <span className={styles.cmpSummary}>
          {compareSummary(report, profile.name)}
        </span>
      </div>
      <DimensionTable
        report={report}
        you={ownProfile}
        yourName={ownCharacter}
        them={profile}
      />
      <KinkAlignment report={report} themName={profile.name} />
    </>
  );
}

// ── §9a DimensionTable ───────────────────────────────────────────────────────

function DimensionTable({
  report,
  you,
  yourName,
  them,
}: {
  report: MatchReport;
  you: ProfileDto;
  yourName: string;
  them: ProfileDto;
}) {
  return (
    <div className={styles.dimTable} role="table" aria-label="Dimensions">
      <div className={`${styles.dimRow} ${styles.dimHeadRow}`} role="row">
        <span className={styles.dimCellLabel}>Dimension</span>
        <span style={{ color: nickColor(yourName) }}>{yourName}</span>
        <span style={{ color: nickColor(them.name) }}>{them.name}</span>
        <span className={styles.dimCellMatch}>Match</span>
      </div>
      {report.dimensions.map((dimension) => (
        <div
          key={dimension.key}
          className={styles.dimRow}
          role="row"
          title={dimension.reason}
          style={{
            background: `color-mix(in srgb, ${TIER_COLOR[dimension.tier]} 6%, var(--eb-side))`,
          }}
        >
          <span className={styles.dimCellLabel}>{dimension.label}</span>
          <span>{infotagValue(you, dimension.key)}</span>
          <span>{infotagValue(them, dimension.key)}</span>
          <span className={styles.dimCellMatch}>
            <MatchPill tier={dimension.tier} short />
          </span>
        </div>
      ))}
    </div>
  );
}

/** The displayed cell value: the dimension's own infotag on that profile.
 * (The tier can rest on more — gender-pref kinks, the paired preference —
 * which is what the hover reason narrates.) */
function infotagValue(profile: ProfileDto, key: string): string {
  const id = INFOTAG_IDS[key as keyof typeof INFOTAG_IDS];
  const tag = profile.infotagGroups
    .flatMap((group) => group.tags)
    .find((entry) => entry.id === id);
  return tag?.value ?? "—";
}

// ── §9b KinkAlignmentList ────────────────────────────────────────────────────

function KinkAlignment({
  report,
  themName,
}: {
  report: MatchReport;
  themName: string;
}) {
  const [conflictsOnly, setConflictsOnly] = useState(false);
  const rows = conflictsOnly
    ? report.kinks.filter(
        (kink) => kink.tier === "mismatch" || kink.tier === "weakMismatch",
      )
    : report.kinks;

  if (report.kinks.length === 0) {
    return (
      <div className={styles.cmpKinksEmpty}>
        No kinks appear on both lists — nothing to align.
      </div>
    );
  }
  return (
    <section className={styles.cmpKinks}>
      <header className={styles.cmpKinksHead}>
        <span className={styles.groupLabel}>Kink alignment</span>
        <span className={styles.cmpKinksMeta}>
          sorted worst-first · {rows.length} shown
        </span>
        <button
          type="button"
          className={`${styles.conflictChip} ${conflictsOnly ? styles.conflictChipOn : ""}`}
          aria-pressed={conflictsOnly}
          onClick={() => {
            setConflictsOnly((value) => !value);
          }}
        >
          <TierPie
            tier="mismatch"
            size={10}
            color={conflictsOnly ? "var(--eb-danger)" : "var(--eb-faint)"}
          />
          Conflicts only
        </button>
      </header>
      <div className={styles.cmpKinkCaptions} aria-hidden>
        <span>You</span>
        <span>Kink</span>
        <span className={styles.cmpTheirs}>{themName}</span>
      </div>
      <div className={styles.cmpKinkList}>
        {rows.length === 0 ? (
          <div className={styles.cmpKinksEmpty}>No conflicts — good sign.</div>
        ) : (
          rows.map((kink) => {
            const yours = choiceOf(kink.yourChoice);
            const theirs = choiceOf(kink.theirChoice);
            return (
              <div
                key={kink.id}
                className={styles.cmpKinkRow}
                style={{
                  background: `color-mix(in srgb, ${TIER_COLOR[kink.tier]} 10%, var(--eb-bg))`,
                  boxShadow: `inset 2px 0 0 color-mix(in srgb, ${TIER_COLOR[kink.tier]} 55%, var(--eb-bg))`,
                }}
              >
                <span className={styles.cmpChoice}>
                  <span aria-hidden style={{ color: yours?.color }}>
                    {yours?.glyph}
                  </span>
                  {yours?.label}
                </span>
                <span className={styles.cmpKinkName}>
                  <TierPie tier={kink.tier} size={10} />
                  {kink.name}
                </span>
                <span className={`${styles.cmpChoice} ${styles.cmpTheirs}`}>
                  {theirs?.label}
                  <span aria-hidden style={{ color: theirs?.color }}>
                    {theirs?.glyph}
                  </span>
                </span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
