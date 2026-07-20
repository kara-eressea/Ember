// StarRating primitive (M11, COMPONENTS-rotation-ratings.md §5): ★ 1–5 in
// the fixed warn token so it never reads as a match/compat signal; the
// ★/☆ glyph swap is the second, colorblind-safe channel. Display rows are
// inert; the interactive editor renders one real button per star.

import styles from "./ratings.module.css";

export function StarRow({
  score,
  size,
  count,
}: {
  score: number;
  size: number;
  count?: boolean;
}) {
  return (
    <span
      className={styles.starRow}
      role="img"
      aria-label={`Rated ${String(score)} of 5`}
    >
      {[1, 2, 3, 4, 5].map((star) => (
        <span
          key={star}
          aria-hidden
          className={star <= score ? styles.starOn : styles.starOff}
          style={{ fontSize: `${String(size)}px` }}
        >
          {star <= score ? "★" : "☆"}
        </span>
      ))}
      {count === true && <span className={styles.starCount}>{score}/5</span>}
    </span>
  );
}

export function StarPicker({
  score,
  onPick,
}: {
  score: number;
  onPick: (score: number) => void;
}) {
  // Roving tabindex: the group is one tab stop; arrows move and select.
  const tabStop = score > 0 ? score : 1;
  return (
    <span
      className={styles.starPicker}
      role="radiogroup"
      aria-label="Your rating"
    >
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          role="radio"
          aria-checked={score === star}
          aria-label={`${String(star)} ${star === 1 ? "star" : "stars"}`}
          tabIndex={star === tabStop ? 0 : -1}
          className={`${styles.starButton} ${star <= score ? (styles.starOn ?? "") : (styles.starOff ?? "")}`}
          onClick={() => {
            onPick(star);
          }}
          onKeyDown={(event) => {
            const delta =
              event.key === "ArrowRight" || event.key === "ArrowUp"
                ? 1
                : event.key === "ArrowLeft" || event.key === "ArrowDown"
                  ? -1
                  : 0;
            if (delta === 0) {
              return;
            }
            event.preventDefault();
            const next = Math.min(5, Math.max(1, star + delta));
            if (next !== score) {
              onPick(next);
            }
            const sibling =
              delta === 1
                ? event.currentTarget.nextElementSibling
                : event.currentTarget.previousElementSibling;
            (sibling as HTMLElement | null)?.focus();
          }}
        >
          {star <= score ? "★" : "☆"}
        </button>
      ))}
    </span>
  );
}
