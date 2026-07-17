// MatchTier — the reusable five-tier primitive (COMPONENTS-profile-viewer.md
// §0). The SVG pie encodes tier as a fill fraction (full disc → empty ring)
// so alignment reads monotonically with color removed; color is a second,
// reinforcing channel. Kept decoupled from the profile viewer — the spec
// earmarks it for future ad rows / search results too.

import { TIER_FRACTION, type MatchTier } from "@emberchat/matcher";
import styles from "./profile.module.css";

export const TIER_LABEL: Record<MatchTier, string> = {
  match: "Match",
  weakMatch: "Weak match",
  neutral: "Neutral",
  weakMismatch: "Weak mismatch",
  mismatch: "Mismatch",
};

/** §0 tier colors, as CSS values over the theme tokens (mix(a,b,t) is a
 * lerp toward b, so mix(ok,warn,.55) = 45% ok). */
export const TIER_COLOR: Record<MatchTier, string> = {
  match: "var(--eb-ok)",
  weakMatch: "color-mix(in srgb, var(--eb-ok) 45%, var(--eb-warn))",
  neutral: "color-mix(in srgb, var(--eb-dim) 60%, var(--eb-faint))",
  weakMismatch: "var(--eb-warn)",
  mismatch: "var(--eb-danger)",
};

const STROKE = 1.4;

/** Bare pie glyph. `color` overrides the tier color (filter chips). Drawn
 * as SVG so every fill level is metrically identical and crisp. */
export function TierPie({
  tier,
  size,
  color,
}: {
  tier: MatchTier;
  size: number;
  color?: string;
}) {
  const frac = TIER_FRACTION[tier];
  const r = size / 2;
  const rr = r - STROKE / 2;
  let fill: React.ReactNode = null;
  if (frac >= 1) {
    fill = <circle cx={r} cy={r} r={rr} fill="currentColor" stroke="none" />;
  } else if (frac > 0) {
    // Pie wedge from 12 o'clock, sweeping clockwise.
    const angle = frac * 2 * Math.PI - Math.PI / 2;
    const x = r + rr * Math.cos(angle);
    const y = r + rr * Math.sin(angle);
    const large = frac > 0.5 ? 1 : 0;
    const d = `M ${String(r)} ${String(r)} L ${String(r)} ${String(r - rr)} A ${String(rr)} ${String(rr)} 0 ${String(large)} 1 ${String(x)} ${String(y)} Z`;
    fill = <path d={d} fill="currentColor" stroke="none" />;
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      className={styles.tierPie}
      style={{ color: color ?? TIER_COLOR[tier] }}
      aria-hidden
    >
      {fill}
      <circle
        cx={r}
        cy={r}
        r={rr}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
      />
    </svg>
  );
}

/** Overall pill: pie + label. `short` drops the " match"/" mismatch"
 * suffix (compare table rows). */
export function MatchPill({
  tier,
  short = false,
}: {
  tier: MatchTier;
  short?: boolean;
}) {
  const label = short
    ? TIER_LABEL[tier].replace(" match", "").replace(" mismatch", "")
    : TIER_LABEL[tier];
  return (
    <span
      className={styles.matchPill}
      style={{
        color: TIER_COLOR[tier],
        background: `color-mix(in srgb, ${TIER_COLOR[tier]} 17%, var(--eb-bg))`,
        borderColor: `color-mix(in srgb, ${TIER_COLOR[tier]} 42%, var(--eb-bg))`,
      }}
    >
      <TierPie tier={tier} size={11} />
      {label}
    </span>
  );
}

/** Compact dimension chip: label + trailing pie. `title` carries the
 * reason string on hover. */
export function DimChip({
  label,
  tier,
  title,
}: {
  label: string;
  tier: MatchTier;
  title?: string;
}) {
  return (
    <span
      className={styles.dimChip}
      title={title}
      style={{
        background: `color-mix(in srgb, ${TIER_COLOR[tier]} 14%, var(--eb-side))`,
        borderColor: `color-mix(in srgb, ${TIER_COLOR[tier]} 40%, var(--eb-side))`,
      }}
    >
      {label}
      <TierPie tier={tier} size={10} />
    </span>
  );
}
