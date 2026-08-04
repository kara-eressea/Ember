// Discord-style "new messages" bar (#363). A returning user always opens at
// the live tail; when unread messages sit above the fold this bar rides the
// top of the log, reads "N new messages since ⟨time⟩" in plain language, and
// pressing it jumps to the first unread (the existing jump machinery in
// MessageLog).
//
// Layout (#495): the bar is two side-by-side buttons filling its whole width —
// the wide one is the jump, and "Mark as read" is the single exception to it.
// Sibling buttons rather than a button inside a button: no nested interactive
// element for a screen reader to trip on, no click on the small target that
// can reach the big one, and no container padding or gap for a press to fall
// into. The jump verb is never written out; the bar itself is the affordance.
//
// The bar is purely presentational: MessageLog owns both actions, including
// the Escape handling (mark caught up + clear the divider), so Escape works
// whether or not the bar is shown — the #373 fix — and "Mark as read" is that
// same handler under a visible label. The bar renders nothing when there is
// nothing to jump to: no unread messages (`count <= 0`) or the unreads are
// already visible on screen (`hidden`). In both cases the in-log "new since
// you left" divider carries the marker on its own.

import { dayKey, formatTime, type TimeFormat } from "../../lib/time.js";
import styles from "./chat.module.css";

export interface NewMessagesBarState {
  /** Unread messages accrued while away — a snapshot frozen at attach (the
   * read cursor advances on open via the shell's auto-ack, so this count does
   * NOT shrink as the conversation is marked read; only `acknowledged` hides
   * the bar). */
  count: number;
  /** Parked at the live tail. */
  atBottom: boolean;
  /** The first unread sits above the viewport — the bar has somewhere to jump
   * to; when all unreads are on screen the in-log divider suffices. */
  firstUnreadOffscreen: boolean;
  /** The user has engaged the catch-up flow this visit (clicked the bar,
   * jumped back to the tail, or Esc-dismissed). Once true the bar stays gone —
   * returning to the tail must not re-prompt (#363 follow-up). */
  acknowledged: boolean;
  /** Viewing detached history — the tail affordances are all suppressed. */
  detachedTail: boolean;
}

/** A catch-up gesture on a conversation with unreads accrued while away. */
export type CatchUpAction = "jumpToUnread" | "dismiss";

/**
 * The read-cursor a catch-up action leaves for the in-log "new since you left"
 * divider (fed to buildRows: a null cursor renders no divider).
 *
 * Esc (`dismiss`) means fully caught up — clear the cursor so the divider
 * disappears along with the bar. A bar-click (`jumpToUnread`) keeps it: the
 * user is scrolling up to read toward the divider, so it stays a useful marker
 * (#363 follow-up).
 */
export function dividerCursorAfter(
  action: CatchUpAction,
  cursor: number | null,
): number | null {
  return action === "dismiss" ? null : cursor;
}

/**
 * Whether the new-messages bar should be hidden. Pure so the show/re-show
 * rules are testable without the scroll geometry. The bar is a tail-only
 * prompt: it shows only while parked at the tail with off-screen unreads that
 * the user has not yet acknowledged.
 */
export function newMessagesBarHidden(state: NewMessagesBarState): boolean {
  return (
    state.count <= 0 ||
    !state.atBottom ||
    !state.firstUnreadOffscreen ||
    state.acknowledged ||
    state.detachedTail
  );
}

/**
 * The "since ⟨time⟩" anchor in the bar's copy (#495): the oldest unread's clock
 * time, formatted the way the log formats its own timestamps — the same
 * 12/24-hour choice and seconds granularity. `timestampFormat: "off"` hides the
 * per-line stamps, but the bar is one sentence that needs its anchor, so it
 * falls back to plain clock time there. A stamp from an earlier day carries a
 * short date with it, or "since 23:40" would read as tonight.
 */
export function unreadSinceLabel(
  iso: string,
  format: TimeFormat,
  now: Date = new Date(),
): string {
  const clock = formatTime(
    iso,
    format.timestampFormat === "off"
      ? { ...format, timestampFormat: "time" }
      : format,
  );
  if (dayKey(iso) === dayKey(now.toISOString())) {
    return clock;
  }
  const date = new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${date}, ${clock}`;
}

export interface NewMessagesBarProps {
  /** Unread messages accrued while away (own sends excluded, matching the
   * in-log divider). */
  count: number;
  /** Clock time of the OLDEST unread, already formatted (unreadSinceLabel).
   * Undefined only when the log cannot name one — the copy then falls back to
   * the plain "since you left". */
  since: string | undefined;
  /** The first unread is on screen already, so there is nothing to jump to —
   * the divider suffices and the bar stays hidden. */
  hidden: boolean;
  /** Scroll up to the first unread (MessageLog's jump machinery). */
  onJump: () => void;
  /** Mark the conversation caught up — the same action Escape performs, which
   * is why the bar no longer advertises the key (#495). */
  onMarkRead: () => void;
}

export function NewMessagesBar({
  count,
  since,
  hidden,
  onJump,
  onMarkRead,
}: NewMessagesBarProps) {
  if (count <= 0 || hidden) {
    return null;
  }

  const noun = count === 1 ? "new message" : "new messages";
  const label =
    since === undefined
      ? `${String(count)} ${noun} since you left`
      : `${String(count)} ${noun} since ${since}`;
  // Spoken, the visible sentence alone would not say what pressing it does —
  // the whole bar is the jump, and nothing writes the verb out. The label says
  // it in the same words a person would use.
  const jumpLabel =
    count === 1
      ? `Go to the new message${since === undefined ? "" : ` from ${since}`}`
      : `Go to the first of ${String(count)} new messages${
          since === undefined ? "" : ` since ${since}`
        }`;

  return (
    <div className={styles.newMessagesBar} data-testid="new-messages-bar">
      <button
        type="button"
        className={styles.newMessagesJump}
        aria-label={jumpLabel}
        onClick={onJump}
        data-testid="new-messages-jump"
      >
        {label}
      </button>
      <button
        type="button"
        className={styles.newMessagesMarkRead}
        aria-label="Mark these messages as read"
        onClick={(event) => {
          // Siblings, so nothing of ours is listening above this — the guard is
          // for whatever the bar is ever nested inside.
          event.stopPropagation();
          onMarkRead();
        }}
        data-testid="new-messages-mark-read"
      >
        Mark as read
      </button>
    </div>
  );
}
