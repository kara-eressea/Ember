// Campaign dialog (M11 step 5, COMPONENTS-rotation-ratings.md §1–§3): the
// Rotate… slot's surface. No campaign → setup (pick tags → the resolved
// cycle, pick channels with their honored intervals, the fixed 1-hour
// fact, Start). A campaign → the status surface (three-tone expiry bar +
// Renew, per-channel next-post countdowns, plain-words pauses, run
// summary once it ends, Stop everything). All schedule policy lives
// server-side; this surface only reads the resulting timeline.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CampaignChannelDto } from "@emberchat/protocol";
import { gateway } from "../../gateway/socket.js";
import { api } from "../../lib/api.js";
import { useAdsStore } from "../../stores/ads.js";
import type { IdentitySession } from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { adTitle } from "./ad-center-logic.js";
import {
  campaignPhase,
  channelCounts,
  effectiveIntervalText,
  elapsedFraction,
  formatClock,
  formatExpiry,
  formatIn,
  resolveCycle,
  totalPosts,
} from "./campaign-logic.js";
import styles from "./campaign.module.css";

export function CampaignDialog({
  session,
  onClose,
}: {
  session: IdentitySession;
  onClose: () => void;
}) {
  const identityId = session.identityId;
  const campaign = session.campaign;
  const entry = useAdsStore((state) => state.byIdentity[identityId]);
  const ads = useMemo(() => entry?.ads ?? [], [entry]);
  // No campaign always renders setup; with one, an explicit override
  // ("Change tags") opens setup over the default status surface. Derived,
  // so a campaign appearing/vanishing from another device just re-renders.
  const [setupOverride, setSetupOverride] = useState(false);
  const mode: "setup" | "status" =
    campaign === null || setupOverride ? "setup" : "status";
  const setMode = (next: "setup" | "status") => {
    setSetupOverride(next === "setup");
  };
  const [tags, setTags] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const windowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    windowRef.current?.focus();
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

  useEffect(() => {
    if (!entry?.loaded) {
      api
        .getAds(identityId)
        .then((response) => {
          useAdsStore.getState().applyAds(identityId, response.ads);
        })
        .catch(() => undefined);
    }
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on open only
  }, []);

  const online = session.sessionStatus === "online";
  const running =
    campaign !== null &&
    campaign.stoppedAt === undefined &&
    now < campaign.expiresAt;

  /** Joined channels whose mode allows ads (setup step 2). */
  const eligible = useMemo(
    () =>
      Object.values(session.channels)
        .filter((channel) => channel.joined && channel.mode !== "chat")
        .sort((a, b) => a.title.localeCompare(b.title)),
    [session.channels],
  );

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ad of ads) {
      if (ad.disabled) {
        continue;
      }
      for (const tag of ad.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [ads]);

  const cycle = useMemo(() => resolveCycle(ads, tags), [ads, tags]);

  async function cmd(
    action: "campaign.start" | "campaign.stop" | "campaign.renew",
    d: object,
  ) {
    setBusy(true);
    setError(undefined);
    const ack = await gateway.cmd({ identityId, action, d } as Parameters<
      typeof gateway.cmd
    >[0]);
    setBusy(false);
    if (!ack.ok) {
      setError(ack.error ?? "That didn't work — try again");
    }
    return ack.ok;
  }

  async function start(replace: boolean) {
    if (tags.length === 0 || picked.size === 0 || busy) {
      return;
    }
    const ok = await cmd("campaign.start", {
      tags,
      channels: [...picked],
      ...(replace ? { replace: true } : {}),
    });
    if (ok) {
      setMode("status");
    }
  }

  function toggleTag(tag: string) {
    setTags((current) =>
      current.includes(tag)
        ? current.filter((entry) => entry !== tag)
        : [...current, tag],
    );
  }

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

  // ── Setup ────────────────────────────────────────────────────────────────

  const setupBody = (
    <>
      {running && campaign && (
        <div className={styles.replaceBanner} role="alert">
          <span className={styles.replaceGlyph} aria-hidden>
            ⚠
          </span>
          <span className={styles.replaceBody}>
            <strong>
              A campaign is already running as {session.character}
            </strong>
            <span>
              {formatExpiry(campaign.expiresAt, now)} left ·{" "}
              {String(channelCounts(campaign).active)} channels active. Starting
              a new one <strong>replaces it</strong> — the current one stops
              immediately.
            </span>
          </span>
          <span className={styles.replaceActions}>
            <button
              type="button"
              className={styles.button}
              onClick={() => {
                setMode("status");
              }}
            >
              Keep current
            </button>
            <button
              type="button"
              className={styles.replaceConfirm}
              disabled={busy || tags.length === 0 || picked.size === 0}
              onClick={() => {
                void start(true);
              }}
            >
              Replace
            </button>
          </span>
        </div>
      )}
      <div className={styles.step}>
        <span className={styles.stepDot} aria-hidden>
          1
        </span>
        <span className={styles.stepTitle}>Pick tags to rotate</span>
        <span className={styles.stepHint}>
          every enabled ad with these tags cycles, in library order
        </span>
      </div>
      {tagCounts.length === 0 ? (
        <div className={styles.edge}>
          <div className={styles.edgeGlyph} aria-hidden>
            ○
          </div>
          <div className={styles.edgeTitle}>No ads to rotate</div>
          <p className={styles.edgeCopy}>
            Write and tag an ad in the Ad Center first — campaigns rotate
            whatever your tags select.
          </p>
          <button
            type="button"
            className={styles.edgeCta}
            onClick={() => {
              onClose();
              useUiStore.getState().setAdCenterOpen(true);
            }}
          >
            Open Ad Center →
          </button>
        </div>
      ) : (
        <div className={styles.tagRow}>
          {tagCounts.map(([tag, count]) => (
            <button
              key={tag}
              type="button"
              className={`${styles.tagPick} ${tags.includes(tag) ? (styles.tagPickOn ?? "") : ""}`}
              aria-pressed={tags.includes(tag)}
              onClick={() => {
                toggleTag(tag);
              }}
            >
              {tags.includes(tag) && (
                <span aria-hidden className={styles.tagCheck}>
                  ✓
                </span>
              )}
              {tag}
              <span className={styles.tagCount}>{count}</span>
            </button>
          ))}
        </div>
      )}
      {tags.length > 0 && cycle.length === 0 && (
        <div className={styles.edge}>
          <div className={styles.edgeGlyph} aria-hidden>
            ○
          </div>
          <div className={styles.edgeTitle}>No ads with those tags</div>
          <p className={styles.edgeCopy}>
            None of your enabled ads carry the tags you picked. Choose other
            tags, or enable an ad in the Ad Center.
          </p>
        </div>
      )}
      {cycle.length > 0 && (
        <div className={styles.resolveBox}>
          <div className={styles.resolveHead}>
            <span className={styles.resolveCount}>
              {cycle.length} {cycle.length === 1 ? "ad" : "ads"} will rotate
            </span>
            <span className={styles.resolveNote}>library order · loops</span>
          </div>
          <div className={styles.resolveList}>
            {cycle.map((ad, index) => (
              <div key={ad.id} className={styles.resolveRow}>
                <span className={styles.resolveIndex} aria-hidden>
                  {index + 1}·
                </span>
                <span className={styles.resolveTitle}>
                  {adTitle(ad.content)}
                </span>
                {index === cycle.length - 1 && (
                  <span className={styles.resolveLoop}>↺ back to 1</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className={styles.step}>
        <span className={styles.stepDot} aria-hidden>
          2
        </span>
        <span className={styles.stepTitle}>Choose channels</span>
        <span className={styles.stepHint}>
          each gets one ad on its own schedule — never faster than every 12 min
        </span>
      </div>
      {eligible.length === 0 ? (
        <div className={styles.edge}>
          <div className={styles.edgeGlyph} aria-hidden>
            ⊘
          </div>
          <div className={styles.edgeTitle}>No channels allow ads</div>
          <p className={styles.edgeCopy}>
            You haven't joined any channel whose mode is ads or both. Join one
            from the browser, then set up a campaign.
          </p>
          <button
            type="button"
            className={styles.edgeCta}
            onClick={() => {
              onClose();
              useUiStore.getState().setChannelBrowserOpen(true);
            }}
          >
            Browse channels →
          </button>
        </div>
      ) : (
        <div className={styles.chanList}>
          {eligible.map((channel) => {
            const interval = effectiveIntervalText(channel.description);
            return (
              <button
                key={channel.key}
                type="button"
                className={`${styles.chanRow} ${picked.has(channel.key) ? (styles.chanRowOn ?? "") : ""}`}
                aria-pressed={picked.has(channel.key)}
                onClick={() => {
                  togglePicked(channel.key);
                }}
              >
                <span className={styles.chanCheck} aria-hidden>
                  {picked.has(channel.key) ? "✓" : ""}
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
                  </span>
                  <span
                    className={`${styles.chanInterval} ${interval.honored ? (styles.chanIntervalHonored ?? "") : ""}`}
                  >
                    {interval.text}
                  </span>
                </span>
                <span className={styles.chanMembers}>
                  <span className={styles.memberDot} aria-hidden />
                  {channel.members.length}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div className={styles.durationCard}>
        <span className={styles.durationGlyph} aria-hidden>
          ⧗
        </span>
        <span className={styles.durationBody}>
          <strong>Runs for 1 hour, then stops</strong>
          <span>
            The length is fixed — one click renews it for another hour.
          </span>
        </span>
      </div>
    </>
  );

  const setupFooter = (
    <>
      <span className={styles.footNote}>
        {error ?? (
          <>
            <strong>
              {cycle.length} {cycle.length === 1 ? "ad" : "ads"}
            </strong>{" "}
            →{" "}
            <strong>
              {picked.size} {picked.size === 1 ? "channel" : "channels"}
            </strong>{" "}
            · this posts on its own until it expires
          </>
        )}
      </span>
      <button
        type="button"
        className={styles.buttonPrimary}
        disabled={
          busy ||
          !online ||
          cycle.length === 0 ||
          picked.size === 0 ||
          (running && mode === "setup")
        }
        onClick={() => {
          void start(false);
        }}
      >
        Start campaign
      </button>
    </>
  );

  // ── Status ───────────────────────────────────────────────────────────────

  const phase = campaign ? campaignPhase(campaign, now) : "live";
  const ended = phase === "expired" || phase === "stopped";

  const statusRow = (channel: CampaignChannelDto) => {
    const key = channel.key;
    const title = session.channels[key]?.title ?? key;
    if (channel.state === "removed") {
      return (
        <div
          key={key}
          className={`${styles.statusRow} ${styles.rowRemoved ?? ""}`}
        >
          <span className={styles.rowGlyphDanger} aria-hidden>
            ⊘
          </span>
          <span className={styles.rowHash} aria-hidden>
            #
          </span>
          <span className={styles.chanBody}>
            <span className={styles.rowTitle}>{title}</span>
            <span className={styles.reasonDanger}>
              You were removed from this channel — rotation stopped here.
            </span>
          </span>
          <button
            type="button"
            className={styles.dropButton}
            aria-label={`Remove ${title} from the campaign`}
            onClick={() => {
              void gateway.cmd({
                identityId,
                action: "campaign.drop",
                d: { key },
              });
            }}
          >
            Drop ✕
          </button>
        </div>
      );
    }
    if (channel.state === "refused") {
      return (
        <div
          key={key}
          className={`${styles.statusRow} ${styles.rowRefused ?? ""}`}
        >
          <span className={styles.rowGlyphWarn} aria-hidden>
            ⏸
          </span>
          <span className={styles.rowHash} aria-hidden>
            #
          </span>
          <span className={styles.chanBody}>
            <span className={styles.rowTitle}>{title}</span>
            <span className={styles.reasonWarn}>
              This channel got an ad from somewhere else — waiting out its
              window.
            </span>
          </span>
          <span className={styles.rowRight}>
            <span className={styles.retryAt}>
              {campaign?.attached && channel.retryAt !== undefined
                ? `retry ≈ ${formatClock(channel.retryAt)}`
                : "retry held"}
            </span>
            {channel.lastAt !== undefined && (
              <span className={styles.rowSub}>
                last {formatClock(channel.lastAt)}
              </span>
            )}
          </span>
        </div>
      );
    }
    const waiting = channel.state === "waiting" || channel.nextAt === undefined;
    return (
      <div
        key={key}
        className={`${styles.statusRow} ${waiting ? (styles.rowWaiting ?? "") : ""}`}
      >
        {waiting ? (
          <span className={styles.rowGlyph} aria-hidden>
            ⧗
          </span>
        ) : (
          <span className={styles.liveDot} aria-hidden />
        )}
        <span className={styles.rowHash} aria-hidden>
          #
        </span>
        <span className={styles.chanBody}>
          <span className={styles.chanTitleLine}>
            <span className={styles.rowTitle}>{title}</span>
            <span
              className={`${styles.modeBadge} ${session.channels[key]?.mode === "ads" ? (styles.modeBadgeAds ?? "") : ""}`}
            >
              {session.channels[key]?.mode ?? "both"}
            </span>
          </span>
          <span className={styles.chanInterval}>
            {
              effectiveIntervalText(session.channels[key]?.description ?? "")
                .text
            }
          </span>
        </span>
        <span className={styles.rowRight}>
          {waiting || channel.nextAt === undefined ? (
            <span className={styles.rowSub}>held</span>
          ) : (
            <>
              <span className={styles.nextAt}>
                next ≈ {formatClock(channel.nextAt)}
              </span>
              <span className={styles.rowSub}>
                {formatIn(channel.nextAt, now)}
                {channel.lastAt !== undefined
                  ? ` · last ${formatClock(channel.lastAt)}`
                  : ""}
              </span>
            </>
          )}
        </span>
      </div>
    );
  };

  const expiryBar = campaign && (
    <div
      className={`${styles.expiryBar} ${
        phase === "live"
          ? (styles.expiryLive ?? "")
          : phase === "detached"
            ? (styles.expiryDetached ?? "")
            : (styles.expiryEnded ?? "")
      }`}
      role="status"
    >
      <div className={styles.expiryRow}>
        {phase === "live" ? (
          <span
            className={`${styles.liveDot} ${styles.pulse ?? ""}`}
            aria-hidden
          />
        ) : phase === "detached" ? (
          <span className={styles.rowGlyphWarn} aria-hidden>
            ⏸
          </span>
        ) : (
          <span className={styles.endedDot} aria-hidden />
        )}
        <span className={styles.expiryBody}>
          <strong>
            {phase === "live"
              ? "Posting live"
              : phase === "detached"
                ? "Paused — no device attached"
                : phase === "stopped"
                  ? "Campaign stopped — posting has stopped"
                  : "Campaign expired — posting has stopped"}
          </strong>
          <span className={styles.expirySub}>
            {phase === "live"
              ? (() => {
                  const counts = channelCounts(campaign);
                  return `${String(counts.active)} active · ${String(counts.waiting)} waiting · ${String(counts.stopped)} stopped`;
                })()
              : phase === "detached"
                ? "Rotation resumes on its own when you reconnect. The 1-hour clock keeps running while you're away."
                : `ran ${formatClock(campaign.startedAt)} – ${formatClock(campaign.stoppedAt ?? campaign.expiresAt)}`}
          </span>
        </span>
        {ended ? (
          <button
            type="button"
            className={styles.buttonPrimarySmall}
            disabled={busy || !online}
            onClick={() => {
              void cmd("campaign.renew", {});
            }}
          >
            Start again
          </button>
        ) : (
          <>
            <span className={styles.expiryLeft}>
              expires in {formatExpiry(campaign.expiresAt, now)}
            </span>
            <button
              type="button"
              className={styles.renewButton}
              disabled={busy || !online}
              onClick={() => {
                void cmd("campaign.renew", {});
              }}
            >
              ↻ Renew
            </button>
          </>
        )}
      </div>
      <div className={styles.track} aria-hidden>
        <div
          className={styles.trackFill}
          style={{
            width: `${String(
              elapsedFraction(campaign.startedAt, campaign.expiresAt, now) *
                100,
            )}%`,
          }}
        />
      </div>
    </div>
  );

  const summaryBody = campaign && (
    <>
      <div className={styles.totalStrip}>
        <span>What went out</span>
        <span className={styles.totalCount}>
          {totalPosts(campaign)} posts across {campaign.channels.length}{" "}
          {campaign.channels.length === 1 ? "channel" : "channels"}
        </span>
      </div>
      <div className={styles.statusList}>
        {campaign.channels.map((channel) => (
          <div key={channel.key} className={styles.summaryRow}>
            <span className={styles.rowHash} aria-hidden>
              #
            </span>
            <span className={styles.chanBody}>
              <span className={styles.rowTitle}>
                {session.channels[channel.key]?.title ?? channel.key}
              </span>
              {channel.state === "removed" && (
                <span className={styles.rowSub}>
                  you were removed — rotation stopped here
                </span>
              )}
            </span>
            <span
              className={`${styles.summaryPosts} ${channel.posts > 0 ? (styles.summaryPostsSome ?? "") : ""}`}
            >
              {channel.posts} {channel.posts === 1 ? "post" : "posts"}
            </span>
          </div>
        ))}
      </div>
    </>
  );

  const statusBody = campaign && (
    <>
      {expiryBar}
      {ended ? (
        summaryBody
      ) : (
        <div className={styles.statusList}>
          {campaign.channels.map((channel) => statusRow(channel))}
        </div>
      )}
    </>
  );

  const statusFooter = campaign && (
    <>
      {ended ? (
        <>
          <span className={styles.footNote}>
            {error ?? "Nothing is posting now — renew to run another hour."}
          </span>
          <span className={styles.footButtons}>
            <button
              type="button"
              className={styles.button}
              onClick={() => {
                setTags(campaign.tags);
                setPicked(
                  new Set(
                    campaign.channels
                      .filter((c) => c.state !== "removed")
                      .map((c) => c.key),
                  ),
                );
                setMode("setup");
              }}
            >
              Change tags
            </button>
            <button
              type="button"
              className={styles.buttonPrimary}
              disabled={busy || !online}
              onClick={() => {
                void cmd("campaign.renew", {});
              }}
            >
              ↻ Renew for 1 hour
            </button>
          </span>
        </>
      ) : (
        <>
          <button
            type="button"
            className={styles.stopButton}
            disabled={busy}
            onClick={() => {
              void cmd("campaign.stop", {});
            }}
          >
            ■ Stop everything
          </button>
          <button
            type="button"
            className={styles.manualLink}
            onClick={() => {
              onClose();
              useUiStore.getState().setPostAdsOpen(true);
            }}
          >
            Post once manually →
          </button>
        </>
      )}
    </>
  );

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
        aria-label={mode === "setup" ? "Set up a campaign" : "Campaign"}
        tabIndex={-1}
        ref={windowRef}
      >
        <div className={styles.head}>
          <div>
            <h2 className={styles.title}>
              {mode === "setup" ? "Set up a campaign" : "Campaign"}
            </h2>
            <span className={styles.sub}>
              {mode === "setup"
                ? `as ${session.character} · rotates on its own for 1 hour`
                : campaign
                  ? phase === "detached"
                    ? `as ${session.character} · paused while you're away`
                    : ended
                      ? `as ${session.character} · ended ${formatClock(campaign.stoppedAt ?? campaign.expiresAt)}`
                      : `as ${session.character} · started ${formatClock(campaign.startedAt)}`
                  : ""}
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
        <div className={styles.body}>
          {mode === "setup" ? setupBody : statusBody}
        </div>
        <div className={styles.footer}>
          {mode === "setup" ? setupFooter : statusFooter}
        </div>
      </div>
    </div>
  );
}
