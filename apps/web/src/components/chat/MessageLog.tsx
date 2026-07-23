// MessageLog (COMPONENTS.md §6): virtualized IRC-compact rows — date
// dividers, system lines, message lines. Bodies render as plain text this
// milestone (raw BBCode passthrough); the parser arrives with the Markdown
// layer in M4. Scrolling up past the buffer start pages older history in via
// REST; the log sticks to the bottom while the user is there.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { useGenderColorVar, useSessionsStore } from "../../stores/sessions.js";
import { CachedMatchChip } from "../profile/CachedMatchChip.js";
import { RateEditor } from "../ratings/RateEditor.js";
import { StarRow } from "../ratings/StarRating.js";
import ratingsStyles from "../ratings/ratings.module.css";
import { ratingFor, useRatingsStore } from "../../stores/ratings.js";
import { ACCENTS, BASE_THEMES, mix, nickColor } from "../../theme/tokens.js";
import { adViewFor } from "./ads.js";
import { buildRows } from "./log-rows.js";
import { parseEmote } from "./rich-text.js";
import { PlainNamesProvider, RichText } from "./RichText.js";
import styles from "./chat.module.css";

/** Message-log type ramp (Appearance pref, issue #188): body plus the
 * proportional mono meta size (timestamps). The sender name tracks the body
 * size directly (#338) — a name and the message it labels read as one line at
 * one size — so the ramp no longer carries a separate nick step. S preserves
 * the pre-#188 density; the default is M (prefs schema). */
const FONT_RAMP_PX = {
  s: { body: 13, meta: 11.5 },
  m: { body: 14, meta: 12 },
  l: { body: 15, meta: 13 },
} as const;

const EMPTY: MessageDto[] = [];
const EMPTY_IGNORES: string[] = [];
const EMPTY_OUTBOX: OutboxItemDto[] = [];
/** Scroll-up distance that triggers the next history page. */
const LOAD_OLDER_THRESHOLD_PX = 120;
/** Within this of the bottom still counts as "at the bottom". */
const AT_BOTTOM_SLACK_PX = 60;
/** Hysteresis for the stick-to-bottom intent: the user must scroll further
 * than this from the bottom to release the glue. Larger than the at-bottom
 * slack so a few pixels of post-jump measurement growth never releases it
 * (which would leave the jump landing short), while a real scroll-up does. */
const STICK_RELEASE_PX = 120;
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
  /** The virtualizer's inner sizing div — observed so content growth the
   * message-keyed effects never see (late row re-measures, image loads,
   * layout work deferred while an overlay obscures the log) still re-sticks
   * the bottom while the intent is held (#284). */
  const innerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  // Mirrors atBottomRef for rendering — the "Jump to recent" pill shows
  // while the user is scrolled away from the newest messages.
  const [atBottom, setAtBottom] = useState(true);
  // The single owner of "should we be glued to the bottom?". Unlike atBottom
  // (a per-frame position read that our OWN programmatic scrolls flip), this
  // intent only changes when the user meaningfully scrolls away (hysteresis in
  // onScroll) or a deliberate jump/backfill sets it. Every bottom-directed
  // controller (bottom-stick, jump re-stick) gates on it, and the prepend
  // re-pin yields to it — so the controllers can never fight (#266). Without
  // this, scrolling to the top to read history (which triggers a prepend +
  // re-pin toward the top) raced the bottom-stick, flipping atBottom every
  // frame and flickering the jump pill until an e2e click timed out.
  const stickBottomRef = useRef(true);
  const loadingRef = useRef(false);
  /** Handle for the in-flight prepend re-pin rAF, so a jump can cancel it. */
  const rePinRafRef = useRef<number>(0);
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
    stickBottomRef.current = true;
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
      stickBottomRef.current = false;
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
      stickBottomRef.current = true;
    }
    wasDetachedRef.current = detachedTail;
  }, [detachedTail]);
  useEffect(() => {
    if (!stickBottomRef.current || detachedTail) {
      return;
    }
    const toBottom = () => {
      // Re-check the intent every frame: a deferred rAF must never clobber a
      // scroll the user has since made away from the bottom (#266).
      if (!stickBottomRef.current) {
        return;
      }
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

  // Enforce the held intent against the scroll GEOMETRY, not just message
  // arrivals: the effect above only fires when the row list changes, and its
  // rAF settle pass covers a frame or two — anything that grows the log
  // after that (rows re-measuring late, eicon/inline images loading, layout
  // and paint work the browser defers while the log sits under an overlay
  // like the profile viewer) leaves the view short of the bottom with no
  // scroll event and no effect re-run (#284). A ResizeObserver on the
  // viewport and on the virtualizer's sizing div fires whenever that
  // deferred work lands — including in a burst the moment the modal closes —
  // and re-sticks. This is not a second scroll controller: it writes only
  // while stickBottomRef holds, the same gate as every other bottom-directed
  // write, so releasing the intent silences it like the rest.
  useEffect(() => {
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (!el || !inner || detachedTail) {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (!stickBottomRef.current) {
        return;
      }
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    observer.observe(inner);
    return () => {
      observer.disconnect();
    };
  }, [detachedTail]);

  // After older history prepends, keep the anchor row visually fixed. The old
  // approach (scrollToIndex align:start) restored against the 26px estimate
  // and jumped once ads/grouped rows/dividers re-measured. Instead we pin the
  // anchor against its *measured* offset and re-apply the correction across a
  // few frames while the newly rendered rows above it settle (#266).
  //
  // This runs in useLayoutEffect, not useEffect, so the initial correction is
  // written *before* the browser paints the prepended rows — the compensated
  // position paints atomically with the insert, instead of the log rendering
  // shoved down for one frame and snapping back the next (the #360
  // rubberband). The settle pass that follows applies only the INCREMENTAL
  // change to the anchor's offset as a relative delta, never an absolute
  // re-set: as the variable-height rows above measure taller over a few
  // frames, we add exactly that growth to scrollTop. A delta rides along with
  // any scroll the user is making at the same instant — it never clobbers
  // live input — so an actively wheel-scrolling user is neither snapped nor
  // abandoned mid-page (#360). The old absolute pin bailed the moment the
  // user's own scroll moved scrollTop off the last value it wrote, dropping
  // the compensation and letting the content drift.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (anchor === undefined) {
      return;
    }
    anchorRef.current = undefined;
    // A jump-to-bottom that landed between the prepend and this effect wins —
    // never hold an old top row against an in-progress stick to the newest.
    if (stickBottomRef.current) {
      return;
    }
    const index = rows.findIndex(
      (row) => row.type === "message" && row.message.id === anchor.id,
    );
    if (index < 0) {
      return;
    }
    // The anchor's measured offset (top of the row within the scroll content)
    // the last time we accounted for it. Its growth between frames is the
    // re-measure we compensate; the user's own scroll never appears here.
    let prevOffset = virtualizer.getOffsetForIndex(index, "start")?.[0];
    const el = scrollRef.current;
    if (el && prevOffset !== undefined) {
      // Synchronous first correction — paints atomically with the prepend.
      el.scrollTop = prevOffset - anchor.gap;
    }
    let frames = 0;
    const settle = () => {
      const el = scrollRef.current;
      // Yield the instant a jump takes over (stick intent flips on): the two
      // must never write the scroll position in the same frame (#266).
      if (!el || stickBottomRef.current) {
        return;
      }
      const offset = virtualizer.getOffsetForIndex(index, "start")?.[0];
      const settled = offset === prevOffset;
      if (
        offset !== undefined &&
        prevOffset !== undefined &&
        offset !== prevOffset
      ) {
        // Add only the row-measurement growth above the anchor — a relative
        // delta that keeps the anchor put without overwriting a concurrent
        // user scroll.
        el.scrollTop += offset - prevOffset;
      }
      prevOffset = offset;
      frames += 1;
      // Stop once the anchor offset stops moving (rows measured) or the frame
      // budget runs out — never keep looping under a slow CI render.
      if (!settled && frames < SCROLL_SETTLE_FRAMES) {
        rePinRafRef.current = requestAnimationFrame(settle);
      }
    };
    rePinRafRef.current = requestAnimationFrame(settle);
    return () => {
      cancelAnimationFrame(rePinRafRef.current);
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
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const bottom = distanceFromBottom <= AT_BOTTOM_SLACK_PX;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    // Update the stick-to-bottom intent with hysteresis: reaching the bottom
    // engages it; only a scroll further than STICK_RELEASE_PX releases it. A
    // few pixels of post-jump measurement growth (between the two thresholds)
    // leaves it engaged, so the bottom-stick keeps closing the gap instead of
    // the jump landing short.
    if (bottom) {
      stickBottomRef.current = true;
    } else if (distanceFromBottom > STICK_RELEASE_PX) {
      stickBottomRef.current = false;
    }
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
    // Take exclusive scroll ownership: engage the stick intent and abandon any
    // in-flight prepend anchor + its re-pin rAF, so the "hold the top row" and
    // "go to the newest" controllers can never write the scroll in the same
    // frame (the #266 pill-flicker hang).
    atBottomRef.current = true;
    stickBottomRef.current = true;
    anchorRef.current = undefined;
    cancelAnimationFrame(rePinRafRef.current);
    setAtBottom(true);
    // Setting scrollTop once to the *estimated* scrollHeight can land short —
    // rows below re-measure taller and the pill lingers. Re-stick across a
    // few frames until the measurements settle (#266). Bail the instant the
    // stick intent is released (a user scroll-up mid-settle).
    let frames = 0;
    const stick = () => {
      // Check the intent BEFORE writing: if the user scrolled away since this
      // frame was scheduled (stick released via onScroll's hysteresis), abandon
      // rather than snap them back to the bottom. Writing first and only then
      // checking let a stale in-flight frame clobber a fresh scroll-to-top,
      // hiding the jump pill mid-click and hanging (#266).
      if (!stickBottomRef.current) {
        return;
      }
      const el = scrollRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
      frames += 1;
      if (frames < SCROLL_SETTLE_FRAMES) {
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
    // While the stick intent is engaged the bottom-stick owns the scroll —
    // capturing an anchor here would let the re-pin fight it (#266).
    if (stickBottomRef.current || el == null || id === undefined) {
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
          ref={innerRef}
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
                  <RollLine
                    message={row.message}
                    prefs={prefs}
                    identityId={identityId}
                  />
                ) : row.message.kind === "lrp" ? (
                  <AdLine message={row.message} prefs={prefs} />
                ) : (
                  <MessageLine
                    message={row.message}
                    prefs={prefs}
                    grouped={row.grouped === true}
                    identityId={identityId}
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
  identityId,
}: {
  message: MessageDto;
  prefs: UserPrefs;
  grouped: boolean;
  identityId: string;
}) {
  const emote = parseEmote(message.bbcode);
  const time = formatTime(message.createdAt, timeFormat(prefs));
  // Sender names carry the member list's gender colour (#338) — the same
  // token, resolved from the same roster, so a character reads identically in
  // the list and in the log. Unknown gender → default text colour, as in the
  // list.
  const nameColor = useGenderColorVar(identityId, message.senderCharacter);
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
          style={nameColor ? { color: nameColor } : undefined}
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
          style={nameColor ? { color: nameColor } : undefined}
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
 * roller (and, for a bottle spin, the target) in `[user]` tags, so it reads
 * like a system line with a die glyph. Those names render as plain inline
 * sender names — not the mid-sentence mention chip — carrying the member-list
 * gender colour like any other name, so the die line reads as a normal chat
 * line rather than a badge (#337). */
function RollLine({
  message,
  prefs,
  identityId,
}: {
  message: MessageDto;
  prefs: UserPrefs;
  identityId: string;
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
      {/* Text die-face glyph (U+2684, default text presentation) — the
          design system allows only SVG/text glyphs, never system emoji
          like 🎲 (COMPONENTS.md §8, #269 item 4). */}
      <span aria-hidden>⚄</span>
      <span>
        <PlainNamesProvider value={{ plain: true, identityId }}>
          <RichText bbcode={message.bbcode} />
        </PlainNamesProvider>
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
