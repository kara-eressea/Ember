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
  return (
    <span className={styles.starPicker} role="radiogroup" aria-label="Stars">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          role="radio"
          aria-checked={score === star}
          aria-label={`${String(star)} ${star === 1 ? "star" : "stars"}`}
          className={`${styles.starButton} ${star <= score ? (styles.starOn ?? "") : (styles.starOff ?? "")}`}
          onClick={() => {
            onPick(star);
          }}
        >
          {star <= score ? "★" : "☆"}
        </button>
      ))}
    </span>
  );
}
