// Discord-style "new messages" bar (#363). A returning user always opens at
// the live tail; when unread messages sit above the fold this bar rides the
// top of the log, reads "N new messages since you left" in plain language, and
// clicking it jumps to the first unread (the existing jump machinery in
// MessageLog). Escape dismisses it AND marks the conversation read — routed
// through the shared Escape stack (useEscapeToClose) so a modal or popover
// above it closes first, and the bar only answers Escape when it is the
// topmost UI.
//
// The bar renders nothing when there is nothing to jump to: no unread messages
// (`count <= 0`) or the unreads are already visible on screen (`hidden`). In
// both cases the in-log "new since you left" divider carries the marker on its
// own.

import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
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

export interface NewMessagesBarProps {
  /** Unread messages accrued while away (own sends excluded, matching the
   * in-log divider). */
  count: number;
  /** The first unread is on screen already, so there is nothing to jump to —
   * the divider suffices and the bar stays hidden. */
  hidden: boolean;
  /** Scroll up to the first unread (MessageLog's jump machinery). */
  onJump: () => void;
  /** Mark the conversation read and dismiss the bar (the read-cursor path). */
  onDismiss: () => void;
}

export function NewMessagesBar({
  count,
  hidden,
  onJump,
  onDismiss,
}: NewMessagesBarProps) {
  const visible = count > 0 && !hidden;
  // Only claim Escape while actually shown; the stack keeps a later-mounted
  // overlay (modal, popover) topmost, so those close first.
  useEscapeToClose(onDismiss, visible);

  if (!visible) {
    return null;
  }

  const label =
    count === 1
      ? "1 new message since you left"
      : `${String(count)} new messages since you left`;

  return (
    <button
      type="button"
      className={styles.newMessagesBar}
      onClick={onJump}
      data-testid="new-messages-bar"
    >
      <span>{label}</span>
      <span className={styles.newMessagesBarHint} aria-hidden>
        Jump ↑ · Esc to mark read
      </span>
    </button>
  );
}
