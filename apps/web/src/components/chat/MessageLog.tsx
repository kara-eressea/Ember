// MessageLog (COMPONENTS.md §6): virtualized IRC-compact rows — date
// dividers, system lines, message lines. Bodies render as plain text this
// milestone (raw BBCode passthrough); the parser arrives with the Markdown
// layer in M4. Scrolling up past the buffer start pages older history in via
// REST; the log sticks to the bottom while the user is there.

import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { MessageDto } from "@emberchat/protocol";
import { formatTime } from "../../lib/time.js";
import { useMessagesStore } from "../../stores/messages.js";
import { useSessionsStore } from "../../stores/sessions.js";
import { nickColor } from "../../theme/tokens.js";
import { buildRows } from "./log-rows.js";
import { parseEmote } from "./rich-text.js";
import { RichText } from "./RichText.js";
import styles from "./chat.module.css";

const EMPTY: MessageDto[] = [];
const EMPTY_IGNORES: string[] = [];
/** Scroll-up distance that triggers the next history page. */
const LOAD_OLDER_THRESHOLD_PX = 120;
/** Within this of the bottom still counts as "at the bottom". */
const AT_BOTTOM_SLACK_PX = 60;

export interface MessageLogProps {
  identityId: string;
  convId: string;
  /** The conversation's read cursor as of attach. The parent keys this
   * component by convId, so the freeze below happens once per visit —
   * before the auto-ack advances the live cursor. */
  readCursorAtAttach: number | null;
}

export function MessageLog({
  identityId,
  convId,
  readCursorAtAttach,
}: MessageLogProps) {
  const [newSinceId] = useState(readCursorAtAttach);
  const buffer = useMessagesStore((s) => s.buffers[convId]);
  const messages = buffer?.messages ?? EMPTY;
  const ignores = useSessionsStore(
    (s) => s.sessions[identityId]?.ignores ?? EMPTY_IGNORES,
  );
  const rows = useMemo(
    () => buildRows(messages, newSinceId, ignores),
    [messages, newSinceId, ignores],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const loadingRef = useRef(false);
  /** Message id to keep in place after a history page prepends. */
  const anchorRef = useRef<number>(undefined);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 12,
    getItemKey: (index) => rows[index]!.key,
  });

  // Initial page for this conversation (once; live events merge on top).
  useEffect(() => {
    atBottomRef.current = true;
    useMessagesStore
      .getState()
      .backfill(identityId, convId)
      .catch((error: unknown) => {
        console.error("history backfill failed", error);
      });
  }, [identityId, convId]);

  // Stick to the bottom while the user is there. The second pass after the
  // frame catches row-measurement adjustments to the total size.
  const lastKey = rows.at(-1)?.key;
  useEffect(() => {
    if (!atBottomRef.current) {
      return;
    }
    const toBottom = () => {
      const el = scrollRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    };
    toBottom();
    const raf = requestAnimationFrame(toBottom);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [lastKey]);

  // After older history prepends, restore the previous top row so the view
  // doesn't jump.
  useEffect(() => {
    const anchorId = anchorRef.current;
    if (anchorId === undefined) {
      return;
    }
    anchorRef.current = undefined;
    const index = rows.findIndex(
      (row) => row.type === "message" && row.message.id === anchorId,
    );
    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: "start" });
    }
  }, [rows, virtualizer]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    atBottomRef.current =
      el.scrollTop + el.clientHeight >= el.scrollHeight - AT_BOTTOM_SLACK_PX;
    if (el.scrollTop < LOAD_OLDER_THRESHOLD_PX) {
      void loadOlder();
    }
  }

  async function loadOlder() {
    const current = useMessagesStore.getState().buffers[convId];
    if (
      loadingRef.current ||
      !current?.backfilled ||
      !current.hasMoreBefore ||
      current.loadingOlder
    ) {
      return;
    }
    loadingRef.current = true;
    try {
      anchorRef.current = current.messages[0]?.id;
      await useMessagesStore.getState().loadOlder(identityId, convId);
    } catch (error) {
      anchorRef.current = undefined;
      console.error("history page failed", error);
    } finally {
      loadingRef.current = false;
    }
  }

  return (
    <div
      className={styles.log}
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="message-log"
    >
      {buffer?.loadingOlder && (
        <div className={styles.logNote}>Loading older messages…</div>
      )}
      {!buffer?.backfilled && <div className={styles.logNote}>Loading…</div>}
      {buffer?.backfilled && rows.length === 0 && (
        <div className={styles.logNote}>No messages yet.</div>
      )}
      <div
        className={styles.logInner}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!;
          return (
            <div
              key={row.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className={styles.logRow}
              style={{ transform: `translateY(${String(item.start)}px)` }}
            >
              {row.type === "divider" ? (
                <div className={styles.dateDivider}>{row.label}</div>
              ) : row.type === "new" ? (
                <div className={styles.newDivider} data-testid="new-divider">
                  new
                </div>
              ) : row.message.kind === "sys" ? (
                <SystemLine message={row.message} />
              ) : (
                <MessageLine message={row.message} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MessageLine({ message }: { message: MessageDto }) {
  const emote = parseEmote(message.bbcode);
  return (
    <div className={styles.messageLine}>
      <span className={styles.time}>{formatTime(message.createdAt)}</span>
      <span
        className={styles.nick}
        style={{ color: nickColor(message.senderCharacter) }}
      >
        {message.senderCharacter}
      </span>
      {emote ? (
        // /me: italic action running straight off the name, no separator.
        <span className={`${styles.body} ${styles.emoteBody ?? ""}`}>
          <RichText bbcode={emote.action} />
        </span>
      ) : (
        <span className={styles.body}>
          <RichText bbcode={message.bbcode} />
        </span>
      )}
    </div>
  );
}

function SystemLine({ message }: { message: MessageDto }) {
  return (
    <div className={styles.systemLine}>
      <span className={styles.time}>{formatTime(message.createdAt)}</span>
      <span>
        <RichText bbcode={message.bbcode} />
      </span>
    </div>
  );
}
