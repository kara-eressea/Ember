// Post Ads dialog (M10 step 6, COMPONENTS-ad-center-search.md §3): the
// manual flow — pick exactly ONE ad (tags filter the single-select list;
// the server permits one ad per channel per window, so a single post can
// never land several ads in a channel), pick channels whose mode allows
// ads, post now. Per-channel outcomes replace the body afterwards; nothing
// retries automatically. A reserved, disabled Rotate… slot marks where the
// deferred rotation surface will live.

import { useEffect, useMemo, useState } from "react";
import { mdToBBCode } from "@emberchat/markdown-bbcode";
import { gateway } from "../../gateway/socket.js";
import { api } from "../../lib/api.js";
import { useAdsStore } from "../../stores/ads.js";
import type { IdentitySession } from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import {
  filterAds,
  formatWait,
  parseAdsCadence,
  tagCounts,
  type PostOutcome,
} from "./post-ads-logic.js";
import styles from "./post-ads.module.css";

export function PostAdsDialog({
  session,
  onClose,
}: {
  session: IdentitySession;
  onClose: () => void;
}) {
  const identityId = session.identityId;
  const entry = useAdsStore((state) => state.byIdentity[identityId]);
  const cooldowns = useAdsStore(
    (state) => state.cooldownsByIdentity[identityId],
  );
  const ads = useMemo(() => entry?.ads ?? [], [entry]);
  const [tag, setTag] = useState("all");
  const [pickedAd, setPickedAd] = useState<number>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [posting, setPosting] = useState(false);
  const [results, setResults] = useState<PostOutcome[]>();
  const [postedTitle, setPostedTitle] = useState("");
  // Clock state so cooldown countdowns stay current while open — render
  // stays pure; the interval below advances it.
  const [now, setNow] = useState(() => Date.now());

  const online = session.sessionStatus === "online";
  const tags = useMemo(() => tagCounts(ads), [ads]);
  const matching = useMemo(() => filterAds(ads, tag), [ads, tag]);

  /** Joined channels whose mode allows ads, with cadence + cooldown. */
  const eligible = useMemo(
    () =>
      Object.values(session.channels)
        .filter((channel) => channel.joined && channel.mode !== "chat")
        .map((channel) => ({
          key: channel.key,
          title: channel.title,
          mode: channel.mode,
          convId: channel.convId,
          members: channel.members.length,
          cadence: parseAdsCadence(channel.description),
          cooldownUntil: cooldowns?.[channel.key] ?? 0,
        }))
        .sort((a, b) => a.title.localeCompare(b.title)),
    [session.channels, cooldowns],
  );
  const openChannels = eligible.filter((c) => c.cooldownUntil <= now);
  const allOnCooldown = eligible.length > 0 && openChannels.length === 0;
  const earliest = allOnCooldown
    ? Math.min(...eligible.map((c) => c.cooldownUntil))
    : 0;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Library + live cooldowns on open; the countdown ticks locally.
  useEffect(() => {
    if (!entry?.loaded) {
      api
        .getAds(identityId)
        .then((response) => {
          useAdsStore.getState().applyAds(identityId, response.ads);
        })
        .catch(() => undefined);
    }
    const keys = Object.values(session.channels)
      .filter((channel) => channel.joined && channel.mode !== "chat")
      .map((channel) => channel.key);
    if (online && keys.length > 0) {
      void gateway.cmd({
        identityId,
        action: "ads.cooldowns",
        d: { keys },
      });
    }
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 15_000);
    return () => {
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on open only
  }, []);

  function togglePicked(key: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  async function post(keys: string[]) {
    const chosen = pickedAd !== undefined ? ads[pickedAd] : undefined;
    if (!chosen || keys.length === 0 || posting) {
      return;
    }
    setPosting(true);
    setPostedTitle(chosen.content.split("\n", 1)[0]?.trim() ?? "");
    const bbcode = mdToBBCode(chosen.content).trim();
    const outcomes: PostOutcome[] = results ? [...results] : [];
    for (const key of keys) {
      const channel = eligible.find((c) => c.key === key);
      if (!channel) {
        continue;
      }
      const ack = await gateway.cmd({
        identityId,
        action: "msg.send",
        d: {
          convId: channel.convId,
          bbcode,
          markdown: chosen.content,
          kind: "lrp",
          immediate: true,
        },
      });
      const at = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      const outcome: PostOutcome = ack.ok
        ? { key, title: channel.title, ok: true, at }
        : {
            key,
            title: channel.title,
            ok: false,
            reason: ack.error ?? "The server refused this ad",
          };
      const existing = outcomes.findIndex((o) => o.key === key);
      if (existing >= 0) {
        outcomes[existing] = outcome;
      } else {
        outcomes.push(outcome);
      }
      if (ack.ok) {
        useAdsStore
          .getState()
          .markPosted(identityId, key, session.limits.lfrpFlood);
      }
    }
    setResults(outcomes);
    setPosting(false);
  }

  const sent = results?.filter((r) => r.ok).length ?? 0;
  const failed = results?.filter((r) => !r.ok) ?? [];

  const edge = (
    glyph: string,
    title: string,
    copy: string,
    cta?: {
      label: string;
      onClick: () => void;
    },
  ) => (
    <div className={styles.edge}>
      <div className={styles.edgeGlyph} aria-hidden>
        {glyph}
      </div>
      <div className={styles.edgeTitle}>{title}</div>
      <p className={styles.edgeCopy}>{copy}</p>
      {cta && (
        <button type="button" className={styles.edgeCta} onClick={cta.onClick}>
          {cta.label}
        </button>
      )}
    </div>
  );

  let body;
  if (results) {
    body = (
      <>
        <div
          className={`${styles.summary} ${failed.length > 0 ? (styles.summaryPartial ?? "") : ""}`}
        >
          <strong>
            Posted to {sent} of {results.length}{" "}
            {results.length === 1 ? "channel" : "channels"}
          </strong>
          <span>
            {failed.length > 0
              ? `${String(sent)} sent · ${String(failed.length)} refused. Refusals show the server's reason — nothing was retried on its own.`
              : "All sent. Each channel allows one ad per posting window."}
          </span>
        </div>
        <div className={styles.list}>
          {results.map((r) => (
            <div key={r.key} className={styles.resultRow}>
              <span
                className={`${styles.resultDisc} ${r.ok ? (styles.resultOk ?? "") : (styles.resultFail ?? "")}`}
                aria-hidden
              >
                {r.ok ? "✓" : "✕"}
              </span>
              <span className={styles.rowHash} aria-hidden>
                #
              </span>
              <span className={styles.resultBody}>
                <span className={styles.rowTitle}>{r.title}</span>
                {r.reason !== undefined && (
                  <span className={styles.resultReason}>{r.reason}</span>
                )}
              </span>
              <span className={styles.resultAt}>
                {r.ok ? `sent ${r.at ?? ""}` : "not sent"}
              </span>
            </div>
          ))}
        </div>
      </>
    );
  } else if (ads.filter((ad) => !ad.disabled).length === 0) {
    body = edge(
      "○",
      "No ads to post",
      "Write an ad in the Ad Center first — everything you save there can post anywhere.",
      {
        label: "Open Ad Center →",
        onClick: () => {
          onClose();
          useUiStore.getState().setAdCenterOpen(true);
        },
      },
    );
  } else if (eligible.length === 0) {
    body = edge(
      "⊘",
      "No channels allow ads",
      "None of your joined channels accept ads right now. Find one in the channel browser first.",
      {
        label: "Browse channels →",
        onClick: () => {
          onClose();
          useUiStore.getState().setChannelBrowserOpen(true);
        },
      },
    );
  } else if (allOnCooldown && picked.size === 0) {
    body = edge(
      "◷",
      "Everything is waiting",
      `Each of your channels already got an ad recently. The earliest opens in ${formatWait(Math.max(0, earliest - now))} — this list updates on its own.`,
    );
  } else {
    body = (
      <>
        <div className={styles.step}>
          <span className={styles.stepDot} aria-hidden>
            1
          </span>
          <span className={styles.stepTitle}>Pick one ad</span>
          <span className={styles.stepHint}>
            tags narrow the list · one ad goes out per post
          </span>
        </div>
        <div className={styles.tagRow}>
          {tags.map(({ tag: t, count }) => (
            <button
              key={t}
              type="button"
              className={`${styles.tagPick} ${t === tag ? (styles.tagPickOn ?? "") : ""}`}
              onClick={() => {
                setTag(t);
              }}
            >
              {t}
              <span className={styles.tagCount}>{count}</span>
            </button>
          ))}
        </div>
        <div className={styles.adList}>
          {matching.length === 0 && (
            <p className={styles.noMatch}>
              No enabled ads carry “{tag}”. Pick another tag, or enable an ad in
              the Ad Center.
            </p>
          )}
          {matching.map(({ index, ad }) => (
            <button
              key={ad.id}
              type="button"
              className={`${styles.adPick} ${index === pickedAd ? (styles.adPickOn ?? "") : ""}`}
              onClick={() => {
                setPickedAd(index);
              }}
            >
              <span
                className={`${styles.radio} ${index === pickedAd ? (styles.radioOn ?? "") : ""}`}
                aria-hidden
              />
              <span className={styles.adPickBody}>
                <span className={styles.rowTitle}>
                  {ad.content.split("\n", 1)[0]?.trim()}
                </span>
                <span className={styles.adPickTags}>
                  {ad.tags.map((t) => (
                    <span key={t} className={styles.adPickTag}>
                      {t}
                    </span>
                  ))}
                </span>
              </span>
            </button>
          ))}
        </div>
        <div className={styles.step}>
          <span className={styles.stepDot} aria-hidden>
            2
          </span>
          <span className={styles.stepTitle}>Choose channels</span>
          <span className={styles.stepHint}>only channels that allow ads</span>
        </div>
        <div className={styles.selectAll}>
          <label className={styles.selectAllLabel}>
            <input
              type="checkbox"
              checked={
                openChannels.length > 0 &&
                openChannels.every((c) => picked.has(c.key))
              }
              onChange={(event) => {
                setPicked(
                  event.target.checked
                    ? new Set(openChannels.map((c) => c.key))
                    : new Set(),
                );
              }}
            />
            Select all available
          </label>
          <span className={styles.stepHint}>
            joined channels that allow ads
          </span>
        </div>
        <div className={styles.list}>
          {eligible.map((channel) => {
            const cooling = channel.cooldownUntil > now;
            return (
              <button
                key={channel.key}
                type="button"
                className={`${styles.chanRow} ${picked.has(channel.key) && !cooling ? (styles.chanRowOn ?? "") : ""} ${cooling ? (styles.chanRowCooling ?? "") : ""}`}
                disabled={cooling}
                onClick={() => {
                  togglePicked(channel.key);
                }}
              >
                <span className={styles.chanCheck} aria-hidden>
                  {cooling ? "◷" : picked.has(channel.key) ? "✓" : ""}
                </span>
                <span className={styles.rowHash} aria-hidden>
                  #
                </span>
                <span className={styles.chanBody}>
                  <span className={styles.chanTitleLine}>
                    <span className={styles.rowTitle}>{channel.title}</span>
                    <span
                      className={`${styles.modeBadge} ${channel.mode === "ads" ? (styles.modeBadgeAds ?? "") : ""}`}
                    >
                      {channel.mode}
                    </span>
                    {channel.cadence !== undefined && (
                      <span
                        className={styles.cadence}
                        title={`This channel asks for one ad every ${String(channel.cadence)} minutes`}
                      >
                        ⧗ {channel.cadence}m
                      </span>
                    )}
                  </span>
                  {cooling && (
                    <span className={styles.cooldownNote}>
                      Got an ad recently · next allowed in{" "}
                      {formatWait(channel.cooldownUntil - now)}
                    </span>
                  )}
                </span>
                <span className={styles.chanMembers}>
                  <span className={styles.memberDot} aria-hidden />
                  {channel.members}
                </span>
              </button>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <div
      className={styles.overlay}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className={styles.window}
        role="dialog"
        aria-modal="true"
        aria-label="Post ads"
      >
        <div className={styles.head}>
          <div>
            <h2 className={styles.title}>
              {results ? "Post results" : "Post ads"}
            </h2>
            <span className={styles.sub}>
              {results
                ? `posted “${postedTitle}”`
                : `as ${session.character} · ${String(ads.filter((a) => !a.disabled).length)} enabled ads`}
            </span>
          </div>
          <button
            type="button"
            className={styles.close}
            aria-label="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className={styles.body}>{body}</div>
        <div className={styles.footer}>
          {results ? (
            <>
              <span className={styles.footNote}>
                One ad per post · shown per channel above
              </span>
              <span className={styles.footButtons}>
                {failed.length > 0 && (
                  <button
                    type="button"
                    className={styles.button}
                    disabled={posting || !online}
                    onClick={() => {
                      void post(failed.map((r) => r.key));
                    }}
                  >
                    Retry {failed.length} failed
                  </button>
                )}
                <button
                  type="button"
                  className={styles.buttonPrimary}
                  onClick={onClose}
                >
                  Done
                </button>
              </span>
            </>
          ) : (
            <>
              <span className={styles.footNote}>
                <strong>{pickedAd !== undefined ? 1 : 0} ad</strong> →{" "}
                <strong>
                  {picked.size} {picked.size === 1 ? "channel" : "channels"}
                </strong>{" "}
                · posts right away
              </span>
              <span className={styles.footButtons}>
                <span
                  className={styles.rotateSlot}
                  title="Automatic rotation is planned — posting stays manual for now"
                >
                  Rotate… <span className={styles.soon}>soon</span>
                </span>
                <button
                  type="button"
                  className={styles.buttonPrimary}
                  disabled={
                    posting ||
                    !online ||
                    pickedAd === undefined ||
                    picked.size === 0
                  }
                  onClick={() => {
                    void post([...picked]);
                  }}
                >
                  {posting ? "Posting…" : "Post now"}
                </button>
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
