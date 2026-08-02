// The Insights "Active hours" grid: 7 weekdays × 24 hours of messages we saw
// from this character, drawn on the *viewer's* clock (the server buckets in
// the zone the loader sends). Local data only — no F-List traffic.

import type { ProfileActivity } from "@emberchat/protocol";
import {
  busiestSlot,
  cellLevel,
  hourRangeLabel,
  DAY_INITIALS,
  DAY_NAMES,
  LABELLED_HOURS,
} from "./heatmap.js";
import styles from "./profile.module.css";

/** Accent share per intensity bucket, mixed against the panel behind it. */
const LEVEL_MIX = [0, 18, 38, 62, 90] as const;

export function ActivityHeatmap({ activity }: { activity: ProfileActivity }) {
  const peak = Math.max(0, ...activity.grid.flat());
  const busiest = busiestSlot(activity.grid);

  return (
    <section className={styles.group}>
      <div className={styles.groupLabel}>Active hours</div>
      {activity.total === 0 ? (
        <div className={styles.heatEmpty}>
          Nothing in the last {activity.windowDays} days — we haven&apos;t seen
          them talk in a channel or DM you share.
        </div>
      ) : (
        <>
          <div className={styles.heatSummary}>
            {busiest && (
              <>
                Busiest {DAY_NAMES[busiest.dow]} around{" "}
                {hourRangeLabel(busiest.hour).split("–")[0]} ·{" "}
              </>
            )}
            {activity.total} {activity.total === 1 ? "message" : "messages"} in{" "}
            {activity.windowDays} days
          </div>
          <div
            className={styles.heatGrid}
            role="img"
            aria-label={`Activity by weekday and hour, ${activity.total} messages over the last ${activity.windowDays} days, in ${activity.timezone}`}
          >
            <span aria-hidden />
            {Array.from({ length: 24 }, (_, hour) => (
              <span key={`h${String(hour)}`} className={styles.heatHour}>
                {(LABELLED_HOURS as readonly number[]).includes(hour)
                  ? String(hour)
                  : ""}
              </span>
            ))}
            {activity.grid.map((row, dow) => (
              <Row key={DAY_NAMES[dow]} dow={dow} counts={row} peak={peak} />
            ))}
          </div>
          <div className={styles.heatLegend}>
            <span>{activity.timezone.replace(/_/g, " ")} · your time</span>
            <span className={styles.heatScale}>
              less
              {LEVEL_MIX.map((mix, level) => (
                <span
                  key={mix}
                  className={styles.heatCell}
                  style={cellStyle(level)}
                  aria-hidden
                />
              ))}
              more
            </span>
          </div>
        </>
      )}
      {/* Honesty, per decisions.md: these are our receive times, and only for
          the stretches this bouncer was actually connected. */}
      <div className={styles.heatFoot}>
        Counted from messages this bouncer saw while it was connected — quiet
        cells can mean you were away, not that they were.
      </div>
    </section>
  );
}

function Row({
  dow,
  counts,
  peak,
}: {
  dow: number;
  counts: number[];
  peak: number;
}) {
  return (
    <>
      <span className={styles.heatDay} title={DAY_NAMES[dow]}>
        {DAY_INITIALS[dow]}
      </span>
      {counts.map((count, hour) => (
        <span
          key={`${String(dow)}-${String(hour)}`}
          className={styles.heatCell}
          style={cellStyle(cellLevel(count, peak))}
          title={`${DAY_NAMES[dow] ?? ""} ${hourRangeLabel(hour)} · ${String(count)} ${count === 1 ? "message" : "messages"}`}
        />
      ))}
    </>
  );
}

function cellStyle(level: number): React.CSSProperties {
  const mix = LEVEL_MIX[level] ?? 0;
  return {
    background:
      mix === 0
        ? "var(--eb-hover)"
        : `color-mix(in oklab, var(--eb-accent) ${String(mix)}%, var(--eb-side))`,
  };
}
