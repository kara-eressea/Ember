// MessageLog (COMPONENTS.md §6): virtualized IRC-compact rows — date
// dividers, system lines, message lines. Bodies render as plain text this
// milestone (raw BBCode passthrough); the parser arrives with the Markdown
// layer in M4. Scrolling up past the buffer start pages older history in via
// REST; the log sticks to the bottom while the user is there.

import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { match } from "@emberchat/matcher";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import type { MessageDto, OutboxItemDto, UserPrefs } from "@emberchat/protocol";
import { formatTime, type TimeFormat } from "../../lib/time.js";
import { useMessagesStore } from "../../stores/messages.js";
import { openCardFrom, useProfileStore } from "../../stores/profile.js";
import { useSessionsStore } from "../../stores/sessions.js";
import { MatchPill } from "../profile/MatchTier.js";
import { ACCENTS, BASE_THEMES, mix, nickColor } from "../../theme/tokens.js";
import { adViewFor } from "./ads.js";
import { buildRows } from "./log-rows.js";
import { parseEmote } from "./rich-text.js";
import { RichText } from "./RichText.js";
import styles from "./chat.module.css";

/** Message body font size (Appearance pref) — the .body rule reads the var. */
const FONT_SIZE_PX = { s: 12, m: 13, l: 14.5 } as const;

const EMPTY: MessageDto[] = [];
const EMPTY_IGNORES: string[] = [];
const EMPTY_OUTBOX: OutboxItemDto[] = [];
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
  }, [lastKey, detachedTail]);

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
  const styleVars: Record<string, string> = {
    "--eb-msg-font": `${String(FONT_SIZE_PX[prefs.fontSize])}px`,
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
                  new
                </div>
              ) : row.type === "presence" ? (
                <div
                  className={styles.presenceLine}
                  data-testid="presence-line"
                >
                  {row.line.character}{" "}
                  {row.line.kind === "join"
                    ? "joined"
                    : row.line.kind === "part"
                      ? "left the channel"
                      : "went offline"}
                </div>
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
        {time !== "" && <span className={styles.time}>{time}</span>}
        <span className={styles.adBlockSpacer} />
        <CachedMatchChip name={message.senderCharacter} />
      </div>
      <div className={styles.adBlockBody}>
        <RichText bbcode={message.bbcode} />
      </div>
    </div>
  );
}

/** Cache-only compatibility chip (M10 step 8): renders the M8 MatchPill
 * compact size when — and only when — both profiles are already loaded in
 * this session. Never triggers a fetch. */
function CachedMatchChip({ name }: { name: string }) {
  const loaded = useProfileStore((s) => s.profiles[name.toLowerCase()]);
  const own = useProfileStore((s) => s.ownProfile?.profile);
  const theirs = loaded?.response?.profile;
  const tier = useMemo(
    () => (own && theirs ? match(own, theirs).overall : undefined),
    [own, theirs],
  );
  if (tier === undefined) {
    return null;
  }
  return <MatchPill tier={tier} short compact />;
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
      {time !== "" && <span className={styles.time}>{time}</span>}
      {/* Grouped rows keep an invisible nick so aligned columns stay put;
          visible nicks open the mini profile card (M8). */}
      {grouped ? (
        <span
          className={`${styles.nick} ${styles.nickGrouped ?? ""}`}
          style={{ color: nickColor(message.senderCharacter) }}
          aria-hidden
        >
          {message.senderCharacter}
        </span>
      ) : (
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
      {time !== "" && <span className={styles.time}>{time}</span>}
      <span aria-hidden>🎲</span>
      <span>
        <RichText bbcode={message.bbcode} />
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
      {time !== "" && <span className={styles.time}>{time}</span>}
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
