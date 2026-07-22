// MessageLog (COMPONENTS.md §6): virtualized IRC-compact rows — date
// dividers, system lines, message lines. Bodies render as plain text this
// milestone (raw BBCode passthrough); the parser arrives with the Markdown
// layer in M4. Scrolling up past the buffer start pages older history in via
// REST; the log sticks to the bottom while the user is there.

import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import type { MessageDto, OutboxItemDto, UserPrefs } from "@emberchat/protocol";
import { gateway } from "../../gateway/socket.js";
import {
  formatFullDateTime,
  formatTime,
  type TimeFormat,
} from "../../lib/time.js";
import { useMessagesStore } from "../../stores/messages.js";
import type { PresenceLine } from "../../stores/messages.js";
import { openCardFrom } from "../../stores/profile.js";
import { useSessionsStore } from "../../stores/sessions.js";
import { CachedMatchChip } from "../profile/CachedMatchChip.js";
import { RateEditor } from "../ratings/RateEditor.js";
import { StarRow } from "../ratings/StarRating.js";
import ratingsStyles from "../ratings/ratings.module.css";
import { ratingFor, useRatingsStore } from "../../stores/ratings.js";
import { ACCENTS, BASE_THEMES, mix, nickColor } from "../../theme/tokens.js";
import { adViewFor } from "./ads.js";
import { buildRows } from "./log-rows.js";
import { parseEmote } from "./rich-text.js";
import { RichText } from "./RichText.js";
import styles from "./chat.module.css";

/** Message-log type ramp (Appearance pref, issue #188): body plus the
 * proportional secondary sizes — timestamp/mono meta and the nick column.
 * S preserves the pre-#188 density; the default is M (prefs schema). */
const FONT_RAMP_PX = {
  s: { body: 13, meta: 11.5, nick: 12.5 },
  m: { body: 14, meta: 12, nick: 13 },
  l: { body: 15, meta: 13, nick: 14 },
} as const;

const EMPTY: MessageDto[] = [];
const EMPTY_IGNORES: string[] = [];
const EMPTY_OUTBOX: OutboxItemDto[] = [];
/** Scroll-up distance that triggers the next history page. */
const LOAD_OLDER_THRESHOLD_PX = 120;
/** Within this of the bottom still counts as "at the bottom". */
const AT_BOTTOM_SLACK_PX = 60;
/** Frames to keep re-applying a scroll correction while the newly rendered
 * variable-height rows (ads, grouped messages, dividers) settle their
 * measurements. Small — one paint is rarely enough, a dozen is plenty. */
const SCROLL_SETTLE_FRAMES = 8;
/** Auto-fill (#254) stop condition: after this many consecutive older pages
 * that add no visible rows (all filtered/ignored), give up rather than
 * cascade through the whole backlog. */
const AUTO_FILL_MAX_EMPTY_PAGES = 3;

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
  const outbox = useSessionsStore(
    (s) => s.sessions[identityId]?.outbox ?? EMPTY_OUTBOX,
  );
  const prefs = useSessionsStore(
    (s) => s.sessions[identityId]?.prefs ?? PREFS_DEFAULTS,
  );
  const channelKey = useSessionsStore(
    (s) => s.sessions[identityId]?.channelByConvId[convId],
  );
  const pending = outbox.filter((item) => item.convId === convId);
  const presence = prefs.showJoinPartQuit ? buffer?.presence : undefined;
  const view = adViewFor(prefs, channelKey);
  const rows = useMemo(
    () =>
      buildRows(messages, newSinceId, ignores, {
        groupConsecutive: prefs.groupConsecutive,
        view,
        presence,
      }),
    [messages, newSinceId, ignores, prefs.groupConsecutive, view, presence],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  // Mirrors atBottomRef for rendering — the "Jump to recent" pill shows
  // while the user is scrolled away from the newest messages.
  const [atBottom, setAtBottom] = useState(true);
  const loadingRef = useRef(false);
  /** Anchor a history prepend: the id of the row to keep visually fixed and
   * its distance below the viewport top (in px) captured *before* the
   * prepend. We restore against measured offsets, not the 26px estimate, so
   * variable-height rows re-measuring above the anchor no longer jump the
   * view (#266). */
  const anchorRef = useRef<{ id: number; gap: number }>(undefined);

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

  // Search jump (M9): once the history page is in, scroll the target row
  // into view. One scroll per target — the ref guards re-renders; the flash
  // itself is a per-row class + one-shot CSS animation, no state involved.
  const jumpTarget = useMessagesStore((s) => s.jumpTarget);
  const scrolledTargetRef = useRef<number>(undefined);
  useEffect(() => {
    if (
      jumpTarget?.convId !== convId ||
      scrolledTargetRef.current === jumpTarget.messageId
    ) {
      return;
    }
    const index = rows.findIndex(
      (row) =>
        row.type === "message" && row.message.id === jumpTarget.messageId,
    );
    if (index >= 0) {
      scrolledTargetRef.current = jumpTarget.messageId;
      atBottomRef.current = false;
      virtualizer.scrollToIndex(index, { align: "center" });
    }
  }, [jumpTarget, rows, convId, virtualizer]);

  // Stick to the bottom while the user is there. The second pass after the
  // frame catches row-measurement adjustments to the total size.
  const lastKey = rows.at(-1)?.key;
  const detachedTail = buffer?.detachedTail === true;
  // Leaving the detached history view means "take me back to now" — stick
  // to the bottom deliberately, not via the scroll-clamp accident the
  // audit called out.
  const wasDetachedRef = useRef(false);
  useEffect(() => {
    if (wasDetachedRef.current && !detachedTail) {
      atBottomRef.current = true;
    }
    wasDetachedRef.current = detachedTail;
  }, [detachedTail]);
  useEffect(() => {
    if (!atBottomRef.current || detachedTail) {
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
    // rows.length re-sticks after a prepend that grew the log while the
    // user sat at the bottom (the #254 auto-fill).
  }, [lastKey, rows.length, detachedTail]);

  // After older history prepends, keep the anchor row visually fixed. The old
  // approach (scrollToIndex align:start) restored against the 26px estimate
  // and jumped once ads/grouped rows/dividers re-measured. Instead we pin the
  // anchor against its *measured* offset and re-apply the correction across a
  // few frames while the newly rendered rows above it settle (#266).
  useEffect(() => {
    const anchor = anchorRef.current;
    if (anchor === undefined) {
      return;
    }
    anchorRef.current = undefined;
    const index = rows.findIndex(
      (row) => row.type === "message" && row.message.id === anchor.id,
    );
    if (index < 0) {
      return;
    }
    let raf = 0;
    let frames = 0;
    const pin = () => {
      const el = scrollRef.current;
      // Measured offset that aligns the anchor row to the top — reflects the
      // real heights of every row now rendered above it, not the estimate.
      const measured = virtualizer.getOffsetForIndex(index, "start")?.[0];
      if (el && measured !== undefined) {
        el.scrollTop = measured - anchor.gap;
      }
      frames += 1;
      if (frames < SCROLL_SETTLE_FRAMES) {
        raf = requestAnimationFrame(pin);
      }
    };
    pin();
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [rows, virtualizer]);

  // A short buffer never scrolls, so scroll-to-top could never trigger
  // paging and the backlog would be unreachable (#254). Keep pulling older
  // pages until the log overflows its viewport or history is exhausted —
  // the store's hasMoreBefore/loadingOlder guards bound the loop.
  const hasMoreBefore = buffer?.hasMoreBefore === true;
  const backfilled = buffer?.backfilled === true;
  const loadingOlder = buffer?.loadingOlder === true;
  // Auto-fill progress guard: the row count at the last auto-fill page and a
  // run-length of pages that added no visible rows. A backlog of nothing but
  // ignored/merged messages must not page forever (#266).
  const autoFillRowsRef = useRef(0);
  const autoFillEmptyRef = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !backfilled || !hasMoreBefore || loadingOlder) {
      return;
    }
    if (el.scrollHeight > el.clientHeight + LOAD_OLDER_THRESHOLD_PX) {
      return;
    }
    // A page that grew the visible log resets the run; one that added no
    // rows advances it. Stop once too many consecutive pages made no
    // progress — otherwise a fully filtered backlog cascades to its start.
    if (rows.length > autoFillRowsRef.current) {
      autoFillEmptyRef.current = 0;
    } else {
      autoFillEmptyRef.current += 1;
    }
    autoFillRowsRef.current = rows.length;
    if (autoFillEmptyRef.current >= AUTO_FILL_MAX_EMPTY_PAGES) {
      return;
    }
    void loadOlder();
    // loadOlder is re-created per render but reads only fresh store state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, backfilled, hasMoreBefore, loadingOlder]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const bottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - AT_BOTTOM_SLACK_PX;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    if (el.scrollTop < LOAD_OLDER_THRESHOLD_PX) {
      void loadOlder();
    }
  }

  // Snap to the newest messages. When parked in the detached history view
  // that means "take me back to now" (drop the frozen tail); otherwise it is
  // a plain scroll to the bottom of the loaded buffer. Either way the jump
  // also marks the conversation read (#254): catching up is over, so the
  // read cursor advances to the newest message.
  function jumpToRecent() {
    useSessionsStore.getState().clearUnread(identityId, convId);
    if (detachedTail) {
      // The newest *buffered* id here is an old message — never ack it.
      // Back at the live tail, the shell's auto-ack advances the cursor.
      void useMessagesStore.getState().backToPresent(identityId, convId);
      return;
    }
    const newest = useMessagesStore.getState().buffers[convId]?.messages.at(-1);
    if (newest) {
      gateway.readAck(identityId, convId, newest.id);
    }
    atBottomRef.current = true;
    setAtBottom(true);
    // Setting scrollTop once to the *estimated* scrollHeight can land short —
    // rows below re-measure taller and the pill lingers. Re-stick across a
    // few frames until the measurements settle (#266).
    let frames = 0;
    const stick = () => {
      const el = scrollRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
      frames += 1;
      if (frames < SCROLL_SETTLE_FRAMES && atBottomRef.current) {
        requestAnimationFrame(stick);
      }
    };
    stick();
  }

  // Whether there is a newer position to jump to. Detached tail always
  // qualifies; otherwise it is the "scrolled up past the slack" state.
  const canJumpToRecent = detachedTail || !atBottom;

  // Escape returns to the newest messages (Discord parity). This listens in
  // the bubble phase with no stopPropagation, so any open popover/menu —
  // which consume Escape in the capture phase — closes first and only an
  // otherwise-unhandled Escape reaches here. Focus in the composer is fine:
  // the composer does not swallow a bare Escape.
  useEffect(() => {
    if (!canJumpToRecent) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        jumpToRecent();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
    // jumpToRecent closes over identityId/convId/detachedTail, all stable
    // for the effect's lifetime aside from detachedTail (in the deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canJumpToRecent, detachedTail, identityId, convId]);

  /** Snapshot the anchor row's on-screen position before a prepend: its id
   * plus the pixel gap between its top and the viewport top. Returns
   * undefined when stuck to the bottom (no anchor — the bottom stick wins)
   * or when the row isn't currently rendered. */
  function captureAnchor(
    id: number | undefined,
  ): { id: number; gap: number } | undefined {
    const el = scrollRef.current;
    if (atBottomRef.current || el == null || id === undefined) {
      return undefined;
    }
    const index = rows.findIndex(
      (row) => row.type === "message" && row.message.id === id,
    );
    if (index < 0) {
      return undefined;
    }
    const rowEl = el.querySelector(`[data-index="${String(index)}"]`);
    const gap = rowEl
      ? rowEl.getBoundingClientRect().top - el.getBoundingClientRect().top
      : 0;
    return { id, gap };
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
      // Hold the previous top row in place after the prepend — except while
      // stuck to the bottom (the auto-fill of a too-short log, #254), where
      // anchoring an old top row would drag the view away from the newest
      // messages; the bottom stick wins there. Capture the anchor's distance
      // below the viewport top *now*, against measured DOM, so the restore
      // can pin it back exactly regardless of how the prepended rows measure.
      anchorRef.current = captureAnchor(current.messages[0]?.id);
      await useMessagesStore.getState().loadOlder(identityId, convId);
    } catch (error) {
      anchorRef.current = undefined;
      console.error("history page failed", error);
    } finally {
      loadingRef.current = false;
    }
  }

  const logClass = [
    styles.log,
    prefs.density === "compact" ? styles.logCompact : "",
    prefs.alignedColumns ? styles.logAligned : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Mention-row hue (highlightTint pref): "accent" leaves the theme vars
  // alone; a fixed accent overrides --eb-hl* for this log only, with the
  // soft wash derived the same way applyTheme derives --eb-accent-soft.
  const ramp = FONT_RAMP_PX[prefs.fontSize];
  const styleVars: Record<string, string> = {
    "--eb-msg-font": `${String(ramp.body)}px`,
    "--eb-msg-meta-font": `${String(ramp.meta)}px`,
    "--eb-msg-nick-font": `${String(ramp.nick)}px`,
  };
  if (prefs.highlightTint !== "accent") {
    styleVars["--eb-hl"] = ACCENTS[prefs.highlightTint].hex;
    styleVars["--eb-hl-soft"] = mix(
      ACCENTS[prefs.highlightTint].hex,
      BASE_THEMES[prefs.baseTheme].bg,
      0.84,
    );
  }

  return (
    <div className={styles.logWrap}>
      <div
        className={logClass}
        style={styleVars}
        ref={scrollRef}
        onScroll={onScroll}
        data-testid="message-log"
      >
        {detachedTail && (
          <div className={styles.historyBanner} role="status">
            Viewing older history — new messages are hidden.
            <button
              type="button"
              className={styles.historyBannerButton}
              onClick={() => {
                void useMessagesStore
                  .getState()
                  .backToPresent(identityId, convId);
              }}
            >
              Back to present
            </button>
          </div>
        )}
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
                className={`${styles.logRow} ${
                  row.type === "message" &&
                  row.message.id === jumpTarget?.messageId
                    ? (styles.jumpFlash ?? "")
                    : ""
                }`}
                style={{ transform: `translateY(${String(item.start)}px)` }}
              >
                {row.type === "divider" ? (
                  <div className={styles.dateDivider}>{row.label}</div>
                ) : row.type === "new" ? (
                  <div className={styles.newDivider} data-testid="new-divider">
                    new since you left
                  </div>
                ) : row.type === "presence" ? (
                  <PresenceLineRow line={row.line} prefs={prefs} />
                ) : row.message.kind === "sys" ? (
                  <SystemLine message={row.message} prefs={prefs} />
                ) : row.message.kind === "rll" ? (
                  <RollLine message={row.message} prefs={prefs} />
                ) : row.message.kind === "lrp" ? (
                  <AdLine message={row.message} prefs={prefs} />
                ) : (
                  <MessageLine
                    message={row.message}
                    prefs={prefs}
                    grouped={row.grouped === true}
                  />
                )}
              </div>
            );
          })}
        </div>
        {pending.length > 0 && (
          <div className={styles.pendingBlock}>
            {pending.map((item) => (
              <PendingLine key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>
      {canJumpToRecent && (
        <button
          type="button"
          className={styles.jumpToRecent}
          onClick={jumpToRecent}
          data-testid="jump-to-recent"
        >
          Jump to newest ↓
        </button>
      )}
    </div>
  );
}

/**
 * A message still parked in the server-side outbox: the local echo of a
 * delayed send. It reconciles for free — release clears it via
 * outbox.updated and the real message arrives as message.new. ArrowUp in
 * the empty composer recalls the newest one.
 */
function PendingLine({ item }: { item: OutboxItemDto }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const seconds = Math.max(
    0,
    Math.ceil((new Date(item.releaseAt).getTime() - now) / 1000),
  );
  const emote = parseEmote(item.bbcode);
  return (
    <div className={styles.pendingLine} data-testid="pending-send">
      <span
        className={`${styles.body} ${emote ? (styles.emoteBody ?? "") : ""}`}
      >
        <RichText bbcode={emote ? emote.action : item.bbcode} />
      </span>
      <span className={styles.pendingMeta}>
        {item.kind === "lrp" && <span className={styles.adTag}>AD</span>}{" "}
        {item.state === "failed"
          ? `could not send${item.failureReason ? ` — ${item.failureReason}` : ""}`
          : `sending in ${String(seconds)}s`}
      </span>
    </div>
  );
}

/** A roleplay ad (M10, CD spec §5): a distinct bordered block with an
 * accent rail, so an ad never reads as a normal chat line. The MatchTier
 * chip appears ONLY when the poster's profile is already in the local
 * cache — no fetch-on-render, so most rows carry no chip and its absence
 * is the normal look (it sits in the flex spacer, not a reserved column).
 */
function AdLine({ message, prefs }: { message: MessageDto; prefs: UserPrefs }) {
  const time = formatTime(message.createdAt, timeFormat(prefs));
  const sender = message.senderCharacter;
  const rating = useRatingsStore((s) => ratingFor(s.byName, sender));
  const [expanded, setExpanded] = useState(false);
  const [editorAnchor, setEditorAnchor] = useState<DOMRect>();

  // Rating the poster (M11 §6): never on our own ads. A rated poster's
  // ads carry their stars; unrated ones get the quiet hover/focus pill.
  const rateAffordance = message.sentByUs ? null : (
    <button
      type="button"
      className={rating ? styles.chipReset : (ratingsStyles.ratePill ?? "")}
      aria-label={
        rating
          ? `Your rating for ${sender}: ${String(rating.score)} of 5 — edit`
          : `Rate ${sender}`
      }
      onClick={(event) => {
        setEditorAnchor(event.currentTarget.getBoundingClientRect());
      }}
    >
      {rating ? (
        <span className={ratingsStyles.ratingChip}>
          <StarRow score={rating.score} size={11} />
          {rating.note !== undefined && (
            <span className={ratingsStyles.noteGlyph} aria-hidden>
              ✎
            </span>
          )}
        </span>
      ) : (
        <>
          <span aria-hidden>☆</span> Rate
        </>
      )}
    </button>
  );

  const editor = editorAnchor && (
    <RateEditor
      character={sender}
      anchor={editorAnchor}
      onClose={() => {
        setEditorAnchor(undefined);
      }}
    />
  );

  // A poster rated ≤2★ collapses to a dimmed one-line stub (§8) — the ad
  // is never unreachable; "show ▾" expands in place.
  if (
    rating !== undefined &&
    rating.score <= 2 &&
    !expanded &&
    !message.sentByUs
  ) {
    return (
      <>
        <button
          type="button"
          className={ratingsStyles.collapsedRow}
          aria-label={`Show the ad from ${sender}, whom you rated ${String(rating.score)} of 5`}
          onClick={() => {
            setExpanded(true);
          }}
        >
          <span className={ratingsStyles.collapsedTag} aria-hidden>
            AD
          </span>
          <span
            className={ratingsStyles.collapsedNick}
            style={{ color: nickColor(sender) }}
          >
            {sender}
          </span>
          <StarRow score={rating.score} size={10} />
          <span className={ratingsStyles.collapsedNote}>
            {rating.note !== undefined
              ? `“${rating.note}”`
              : "you rated this poster low — ad hidden"}
          </span>
          <span className={ratingsStyles.collapsedShow} aria-hidden>
            show ▾
          </span>
        </button>
        {editor}
      </>
    );
  }

  return (
    <div className={styles.adBlock} data-ad>
      <div className={styles.adBlockHead}>
        <span className={styles.adTag} title="Roleplay ad">
          AD
        </span>
        <button
          type="button"
          className={`${styles.nick} ${styles.nameButton ?? ""}`}
          style={{ color: nickColor(message.senderCharacter) }}
          onClick={(event) => {
            openCardFrom(event.currentTarget, message.senderCharacter);
          }}
        >
          {message.senderCharacter}
        </button>
        {time !== "" && (
          <span
            className={styles.time}
            title={formatFullDateTime(message.createdAt)}
          >
            {time}
          </span>
        )}
        <span className={styles.adBlockSpacer} />
        <CachedMatchChip name={message.senderCharacter} />
        {rateAffordance}
      </div>
      <div className={styles.adBlockBody}>
        <RichText bbcode={message.bbcode} />
      </div>
      {rating?.note !== undefined && expanded && (
        <div className={ratingsStyles.noteStrip}>
          <span className={ratingsStyles.noteEyebrow}>YOUR NOTE</span>
          <span className={ratingsStyles.noteText}>{rating.note}</span>
        </div>
      )}
      {editor}
    </div>
  );
}

function MessageLine({
  message,
  prefs,
  grouped,
}: {
  message: MessageDto;
  prefs: UserPrefs;
  grouped: boolean;
}) {
  const emote = parseEmote(message.bbcode);
  const time = formatTime(message.createdAt, timeFormat(prefs));
  return (
    <div
      className={`${styles.messageLine} ${
        message.mention ? (styles.mentionLine ?? "") : ""
      }`}
      data-mention={message.mention || undefined}
    >
      {time !== "" && (
        <span
          className={styles.time}
          title={formatFullDateTime(message.createdAt)}
        >
          {time}
        </span>
      )}
      {/* Grouped rows keep an invisible nick so aligned columns stay put;
          visible nicks open the mini profile card (M8). */}
      {grouped ? (
        <span
          className={`${styles.nick} ${styles.nickGrouped ?? ""} ${
            emote ? (styles.emoteNick ?? "") : ""
          }`}
          style={{ color: nickColor(message.senderCharacter) }}
          aria-hidden
        >
          {message.senderCharacter}
        </span>
      ) : (
        <button
          type="button"
          className={`${styles.nick} ${styles.nameButton ?? ""} ${
            emote ? (styles.emoteNick ?? "") : ""
          }`}
          style={{ color: nickColor(message.senderCharacter) }}
          onClick={(event) => {
            openCardFrom(event.currentTarget, message.senderCharacter);
          }}
        >
          {message.senderCharacter}
        </button>
      )}
      {emote ? (
        // /me: italic action running straight off the name, no separator.
        // Possessives pull back across the row gap so "/me's teacup" reads
        // "Name's teacup", not "Name 's teacup".
        <span
          className={`${styles.body} ${styles.emoteBody ?? ""} ${emote.possessive ? (styles.emotePossessive ?? "") : ""}`}
        >
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

/** A dice roll / bottle spin: the server-rendered BBCode already names the
 * roller, so it reads like a system line with a die glyph. */
function RollLine({
  message,
  prefs,
}: {
  message: MessageDto;
  prefs: UserPrefs;
}) {
  const time = formatTime(message.createdAt, timeFormat(prefs));
  return (
    <div className={styles.rollLine} data-testid="roll-line">
      {time !== "" && (
        <span
          className={styles.time}
          title={formatFullDateTime(message.createdAt)}
        >
          {time}
        </span>
      )}
      <span aria-hidden>🎲</span>
      <span>
        <RichText bbcode={message.bbcode} />
      </span>
    </div>
  );
}

/** A live join/leave/went-offline notice (M5, "show join/part/quit" pref).
 * Carries the same timestamp treatment as every other log line (#208). */
function PresenceLineRow({
  line,
  prefs,
}: {
  line: PresenceLine;
  prefs: UserPrefs;
}) {
  const time = formatTime(line.createdAt, timeFormat(prefs));
  return (
    <div className={styles.presenceLine} data-testid="presence-line">
      {time !== "" && (
        <span
          className={styles.time}
          title={formatFullDateTime(line.createdAt)}
        >
          {time}
        </span>
      )}
      <span>
        {line.character}{" "}
        {line.kind === "join"
          ? "joined"
          : line.kind === "part"
            ? "left the channel"
            : "went offline"}
      </span>
    </div>
  );
}

function SystemLine({
  message,
  prefs,
}: {
  message: MessageDto;
  prefs: UserPrefs;
}) {
  const time = formatTime(message.createdAt, timeFormat(prefs));
  return (
    <div className={styles.systemLine}>
      {time !== "" && (
        <span
          className={styles.time}
          title={formatFullDateTime(message.createdAt)}
        >
          {time}
        </span>
      )}
      <span>
        <RichText bbcode={message.bbcode} />
      </span>
    </div>
  );
}

function timeFormat(prefs: UserPrefs): TimeFormat {
  return {
    timestampFormat: prefs.timestampFormat,
    use24HourClock: prefs.use24HourClock,
  };
}
