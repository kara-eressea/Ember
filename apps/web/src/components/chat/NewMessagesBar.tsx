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
