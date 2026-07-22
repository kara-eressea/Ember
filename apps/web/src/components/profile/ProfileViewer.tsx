// Full profile viewer (M8, COMPONENTS-profile-viewer.md §1–§8): 900×640
// modal — HistoryRail + header/tabs/content column. Step 7 ships Overview /
// Details / Kinks / Insights; Compare arrives with the matcher surfaces
// (step 9), Images/Guestbook with step 10.

import { useEffect, useMemo, useRef, useState } from "react";
import { match } from "@emberchat/matcher";
import type { ProfileDto } from "@emberchat/protocol";
import { nickColor } from "../../theme/tokens.js";
import { loadSocial } from "../../lib/social.js";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import { api } from "../../lib/api.js";
import {
  persistViewerFullscreen,
  savedViewerFullscreen,
} from "../../lib/viewer-size.js";
import {
  loadHistory,
  loadInsights,
  loadOwnProfile,
  loadProfile,
  removeHistoryEntry,
  resetInsights,
  useProfileStore,
  type LoadedProfile,
} from "../../stores/profile.js";
import { useSessionsStore } from "../../stores/sessions.js";
import { Avatar } from "../common/Avatar.js";
import { CHOICES } from "./choices.js";
import { CompareTab } from "./CompareTab.js";
import { PrivateNote } from "./PrivateNote.js";
import { GuestbookTab } from "./GuestbookTab.js";
import { ImagesTab } from "./ImagesTab.js";
import { DimChip, MatchPill } from "./MatchTier.js";
import { notableDimensions } from "./match-utils.js";
import { ProfileBBCode } from "./ProfileBBCode.js";
import { ago, dateLabel } from "./time.js";
import styles from "./profile.module.css";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "details", label: "Details" },
  { id: "kinks", label: "Kinks" },
  { id: "compare", label: "Compare" },
  { id: "insights", label: "Insights" },
  { id: "images", label: "Images" },
  { id: "guestbook", label: "Guestbook" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function ProfileViewer({
  identityId,
  onClose,
}: {
  identityId: string;
  onClose: () => void;
}) {
  const viewing = useProfileStore((s) => s.viewing);
  const activeTab = useProfileStore((s) => s.activeTab);
  const loaded = useProfileStore((s) =>
    viewing ? s.profiles[viewing.toLowerCase()] : undefined,
  );
  const ownCharacter = useSessionsStore(
    (s) => s.identities?.find((entry) => entry.id === identityId)?.name,
  );
  const windowRef = useRef<HTMLDivElement>(null);
  // Window size is a device-level UI pref (#276): the viewer opens in whatever
  // mode the user last left it in, so a full-screen session carries to the
  // next profile they open. Persisted to localStorage on every toggle.
  const [fullscreen, setFullscreen] = useState(savedViewerFullscreen);

  useEffect(() => {
    windowRef.current?.focus();
  }, []);

  useEscapeToClose(onClose);

  useEffect(() => {
    void loadHistory(identityId);
    void loadSocial(identityId);
    if (ownCharacter) {
      void loadOwnProfile(identityId, ownCharacter);
    }
  }, [identityId, ownCharacter]);

  useEffect(() => {
    if (viewing) {
      void loadProfile(identityId, viewing);
    }
  }, [identityId, viewing]);

  if (!viewing) {
    return null;
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
        className={`${styles.window} ${fullscreen ? styles.windowFull : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={`Profile: ${viewing}`}
        tabIndex={-1}
        ref={windowRef}
      >
        <div className={styles.windowControls}>
          <button
            type="button"
            className={styles.windowControl}
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            aria-pressed={fullscreen}
            onClick={() => {
              setFullscreen((value) => {
                const next = !value;
                persistViewerFullscreen(next);
                return next;
              });
            }}
          >
            {fullscreen ? "⤡" : "⛶"}
          </button>
          <button
            type="button"
            className={styles.windowControl}
            aria-label="Close profile"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <HistoryRail identityId={identityId} viewing={viewing} />
        <div className={styles.main}>
          <ViewerBody
            key={viewing.toLowerCase()}
            identityId={identityId}
            name={viewing}
            loaded={loaded}
            activeTab={activeTab}
            ownCharacter={ownCharacter}
            fullscreen={fullscreen}
          />
        </div>
      </div>
    </div>
  );
}

// ── History rail (§2) ────────────────────────────────────────────────────────

function HistoryRail({
  identityId,
  viewing,
}: {
  identityId: string;
  viewing: string;
}) {
  const history = useProfileStore((s) => s.history);
  const open = useProfileStore((s) => s.open);
  return (
    <nav className={styles.rail} aria-label="Recently viewed profiles">
      <div className={styles.railHead}>Recently viewed</div>
      {history.length === 0 ? (
        <div className={styles.railEmpty}>
          <span className={styles.railEmptyTile} aria-hidden>
            ◌
          </span>
          Profiles you view will appear here.
        </div>
      ) : (
        <div className={styles.railList}>
          {history.map((entry) => {
            const active = entry.name.toLowerCase() === viewing.toLowerCase();
            // Two sibling buttons, not a control nested in a control — the
            // remove affordance must be valid ARIA and keyboard-reachable
            // (M8 audit M3).
            return (
              <div
                key={entry.name.toLowerCase()}
                className={`${styles.histRow} ${active ? styles.histRowActive : ""}`}
              >
                <button
                  type="button"
                  className={styles.histOpen}
                  onClick={() => {
                    open(entry.name);
                  }}
                >
                  <Avatar name={entry.name} size={28} square />
                  <span className={styles.histMeta}>
                    <span className={styles.histName}>{entry.name}</span>
                    <span className={styles.histAgo}>
                      {ago(entry.lastViewedAt)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.histRemove}
                  aria-label={`Remove ${entry.name} from history`}
                  onClick={() => {
                    void removeHistoryEntry(identityId, entry.name);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </nav>
  );
}

// ── Main column ──────────────────────────────────────────────────────────────

function ViewerBody({
  identityId,
  name,
  loaded,
  activeTab,
  ownCharacter,
  fullscreen,
}: {
  identityId: string;
  name: string;
  loaded: LoadedProfile | undefined;
  activeTab: TabId;
  ownCharacter: string | undefined;
  fullscreen: boolean;
}) {
  const setTab = useProfileStore((s) => s.setTab);
  const response = loaded?.response;

  if (!response) {
    if (loaded && loaded.state !== "loading") {
      return <ErrorState identityId={identityId} name={name} loaded={loaded} />;
    }
    return <LoadingState name={name} />;
  }

  const profile = response.profile;
  return (
    <>
      <Header
        identityId={identityId}
        profile={profile}
        response={response}
        loading={loaded?.state === "loading"}
      />
      {(response.stale || response.budgetExhausted) && (
        <div className={styles.staleBanner} role="status">
          <span aria-hidden>⚠</span>
          {response.budgetExhausted
            ? "Hourly profile budget exhausted — showing the cached copy."
            : "Couldn't refresh — showing the cached copy."}
        </div>
      )}
      <div className={styles.tabs} role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeTab}
            className={`${styles.tab} ${tab.id === activeTab ? styles.tabActive : ""}`}
            onClick={() => {
              setTab(tab.id);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className={styles.content} data-testid="profile-content">
        <TabContent
          identityId={identityId}
          profile={profile}
          activeTab={activeTab}
          ownCharacter={ownCharacter}
          fullscreen={fullscreen}
        />
      </div>
    </>
  );
}

function TabContent({
  identityId,
  profile,
  activeTab,
  ownCharacter,
  fullscreen,
}: {
  identityId: string;
  profile: ProfileDto;
  activeTab: TabId;
  ownCharacter: string | undefined;
  fullscreen: boolean;
}) {
  const ownProfile = useProfileStore((s) => s.ownProfile?.profile);
  switch (activeTab) {
    case "overview":
      return (
        <>
          <MatchStrip
            profile={profile}
            ownProfile={ownProfile}
            ownCharacter={ownCharacter}
          />
          <ProfileBBCode
            bbcode={profile.description}
            inlines={profile.inlines}
            fullscreen={fullscreen}
          />
        </>
      );
    case "details":
      return <DetailsTab profile={profile} />;
    case "kinks":
      return <KinksTab profile={profile} />;
    case "compare":
      return (
        <CompareTab
          identityId={identityId}
          profile={profile}
          ownProfile={ownProfile}
          ownCharacter={ownCharacter}
        />
      );
    case "insights":
      return (
        <InsightsTab
          identityId={identityId}
          name={profile.name}
          ownCharacter={ownCharacter}
        />
      );
    case "images":
      return <ImagesTab profile={profile} fullscreen={fullscreen} />;
    case "guestbook":
      return <GuestbookTab identityId={identityId} profile={profile} />;
  }
}

// ── MatchStrip (§6) ──────────────────────────────────────────────────────────

/** Overview's compatibility card — only when own-profile data exists and
 * this isn't your own profile (mirrors the mini card's no-match case). */
function MatchStrip({
  profile,
  ownProfile,
  ownCharacter,
}: {
  profile: ProfileDto;
  ownProfile: ProfileDto | undefined;
  ownCharacter: string | undefined;
}) {
  const setTab = useProfileStore((s) => s.setTab);
  const self =
    ownCharacter !== undefined &&
    profile.name.toLowerCase() === ownCharacter.toLowerCase();
  const report = useMemo(
    () => (ownProfile && !self ? match(ownProfile, profile) : undefined),
    [ownProfile, profile, self],
  );
  if (!report || ownCharacter === undefined) {
    return null;
  }
  return (
    <section className={styles.matchStrip}>
      <div className={styles.matchStripHead}>
        <span className={styles.groupLabel}>
          Compatibility with {ownCharacter}
        </span>
        <button
          type="button"
          className={styles.fullCompare}
          onClick={() => {
            setTab("compare");
          }}
        >
          Full compare →
        </button>
      </div>
      <div className={styles.matchStripChips}>
        <MatchPill tier={report.overall} />
        {notableDimensions(report, 4).map((dimension) => (
          <DimChip
            key={dimension.label}
            label={dimension.label}
            tier={dimension.tier}
            title={dimension.reason}
          />
        ))}
      </div>
    </section>
  );
}

// ── Header (§3) + PrivateNote (§4) ───────────────────────────────────────────

function Header({
  identityId,
  profile,
  response,
  loading,
}: {
  identityId: string;
  profile: ProfileDto;
  response: NonNullable<LoadedProfile["response"]>;
  loading: boolean;
}) {
  const social = useSessionsStore((s) => s.sessions[identityId]?.social);
  const isFriend = social?.friends.some(
    (row) => row.name.toLowerCase() === profile.name.toLowerCase(),
  );
  const isBookmarked =
    social?.bookmarks.some(
      (row) => row.name.toLowerCase() === profile.name.toLowerCase(),
    ) ?? false;
  const [tooltip, setTooltip] = useState(false);
  // Optimistic bookmark state (#185): show the intended state instantly while
  // the request is in flight; clear the override afterwards so the refreshed
  // social lists (the same pathway the member menu uses) become the source of
  // truth — on failure the server list is unchanged, so clearing reverts.
  const [optimisticBookmark, setOptimisticBookmark] = useState<boolean>();
  const [bookmarkPending, setBookmarkPending] = useState(false);
  const bookmarked = optimisticBookmark ?? isBookmarked;
  const accent = nickColor(profile.name);

  function toggleBookmark() {
    const next = !bookmarked;
    setOptimisticBookmark(next);
    setBookmarkPending(true);
    void api
      .postBookmark(identityId, next ? "add" : "remove", profile.name)
      .then(() => loadSocial(identityId, true))
      .catch((error: unknown) => {
        useSessionsStore
          .getState()
          .applyNotice(
            identityId,
            "error",
            error instanceof Error ? error.message : "Couldn't update bookmark",
          );
      })
      .finally(() => {
        setOptimisticBookmark(undefined);
        setBookmarkPending(false);
      });
  }

  return (
    <header
      className={styles.header}
      style={{ "--gender-accent": accent } as React.CSSProperties}
    >
      <Avatar name={profile.name} size={56} square />
      <div className={styles.headerInfo}>
        <div className={styles.nameRow}>
          <span className={styles.name}>{profile.name}</span>
          {isFriend && (
            <span
              className={`${styles.badge} ${styles.badgeFriend}`}
              title="Friend"
            >
              ★
            </span>
          )}
          <button
            type="button"
            className={`${styles.badge} ${styles.bookmarkBtn} ${
              bookmarked ? styles.badgeBookmarkOn : styles.badgeBookmark
            }`}
            aria-pressed={bookmarked}
            disabled={bookmarkPending}
            title={bookmarked ? "Remove bookmark" : "Bookmark this character"}
            onClick={toggleBookmark}
          >
            ⚑
          </button>
        </div>
        <div className={styles.metaRow}>
          fetched {ago(response.fetchedAt)}
          <span
            onMouseEnter={() => {
              setTooltip(true);
            }}
            onMouseLeave={() => {
              setTooltip(false);
            }}
          >
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Refresh profile"
              disabled={response.budgetExhausted || loading}
              onClick={() => {
                void loadProfile(identityId, profile.name, true);
              }}
            >
              ⟳
              {tooltip && response.budgetExhausted && (
                <span className={styles.tooltip} role="tooltip">
                  Hourly profile budget exhausted — showing cached copy.
                </span>
              )}
            </button>
          </span>
        </div>
      </div>
    </header>
  );
}

// ── Details (§7) ─────────────────────────────────────────────────────────────

function DetailsTab({ profile }: { profile: ProfileDto }) {
  if (profile.infotagGroups.length === 0) {
    return (
      <EmptyState glyph="≡" title="No details">
        {profile.name} hasn't filled in any profile fields.
      </EmptyState>
    );
  }
  return (
    <div className={styles.columns}>
      {profile.infotagGroups.map((group) => (
        <section key={group.group} className={styles.group}>
          <div className={styles.groupLabel}>{group.group}</div>
          {group.tags.map((tag) => (
            <div key={tag.id} className={styles.detailRow}>
              <span className={styles.detailLabel}>{tag.label}</span>
              <span className={styles.detailValue}>{tag.value}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

// ── Kinks (§8) ───────────────────────────────────────────────────────────────

function KinksTab({ profile }: { profile: ProfileDto }) {
  const ownProfile = useProfileStore((s) => s.ownProfile);
  const ownChoice = new Map(
    (ownProfile?.profile.kinks ?? []).map((kink) => [kink.id, kink.choice]),
  );
  if (profile.kinks.length === 0 && profile.customKinks.length === 0) {
    return (
      <EmptyState glyph="♥" title="No kinks listed">
        {profile.name} hasn't filled in a kink list.
      </EmptyState>
    );
  }
  return (
    <>
      <div className={styles.kinkLegend} aria-hidden>
        {CHOICES.map((choice) => (
          <span key={choice.id}>
            {choice.glyph} your “{choice.label.toLowerCase()}”
          </span>
        ))}
        <span>· not on your list</span>
      </div>
      <div className={styles.kinkGrid}>
        {CHOICES.map((column) => {
          const rows = profile.kinks.filter(
            (kink) => kink.choice === column.id,
          );
          const customs = profile.customKinks.filter(
            (custom) => custom.choice === column.id,
          );
          return (
            <section key={column.id} className={styles.kinkCol}>
              <header className={styles.kinkColHead}>
                <span
                  className={styles.kinkColSquare}
                  style={{ background: column.color }}
                  aria-hidden
                />
                {column.label}
                <span className={styles.kinkColCount}>
                  {rows.length + customs.length}
                </span>
              </header>
              <div className={styles.kinkList}>
                {customs.map((custom) => (
                  <CustomKinkRow key={custom.name} custom={custom} />
                ))}
                {rows.map((kink) => {
                  const mine = ownChoice.get(kink.id);
                  const mineColor = CHOICES.find(
                    (choice) => choice.id === mine,
                  )?.color;
                  return (
                    <div
                      key={kink.id}
                      className={styles.kinkRow}
                      title={kink.description}
                      style={
                        mineColor
                          ? {
                              background: `color-mix(in srgb, ${mineColor} 10%, var(--eb-bg))`,
                              boxShadow: `inset 2px 0 0 color-mix(in srgb, ${mineColor} 50%, var(--eb-bg))`,
                            }
                          : undefined
                      }
                    >
                      <span
                        className={styles.choiceMark}
                        style={{
                          color: mineColor ?? "var(--eb-faint)",
                          background: mineColor
                            ? `color-mix(in srgb, ${mineColor} 18%, var(--eb-side))`
                            : "var(--eb-side)",
                        }}
                        aria-label={mine ? `your ${mine}` : "not on your list"}
                      >
                        {CHOICES.find((choice) => choice.id === mine)?.glyph ??
                          "·"}
                      </span>
                      <span className={styles.kinkName}>{kink.name}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

function CustomKinkRow({
  custom,
}: {
  custom: ProfileDto["customKinks"][number];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className={styles.kinkRow}>
        <span className={styles.customTag}>CUSTOM</span>
        <span className={styles.kinkName}>{custom.name}</span>
        {custom.description !== "" && (
          <button
            type="button"
            className={styles.kinkExpand}
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${custom.name}`}
            onClick={() => {
              setOpen((value) => !value);
            }}
          >
            {open ? "−" : "+"}
          </button>
        )}
      </div>
      {open && <div className={styles.kinkDesc}>{custom.description}</div>}
    </div>
  );
}

// ── Insights (§7b) ───────────────────────────────────────────────────────────

function InsightsTab({
  identityId,
  name,
  ownCharacter,
}: {
  identityId: string;
  name: string;
  ownCharacter: string | undefined;
}) {
  const insights = useProfileStore((s) => s.insights[name.toLowerCase()]);
  // The private note lives here now (#211) — the header corner is reserved for
  // window controls (close + fullscreen). The saved note rides the cached
  // profile response.
  const note = useProfileStore(
    (s) => s.profiles[name.toLowerCase()]?.response?.note ?? null,
  );
  useEffect(() => {
    void loadInsights(identityId, name);
  }, [identityId, name]);

  const noteBlock = (
    <div className={styles.insightsNote}>
      <PrivateNote identityId={identityId} name={name} initial={note} />
    </div>
  );

  if (!insights) {
    return (
      <>
        {noteBlock}
        <div className={styles.shimmer} style={{ height: 120 }} />
      </>
    );
  }
  if (insights === "error") {
    return (
      <>
        {noteBlock}
        <EmptyState glyph="?" title="Couldn't load insights">
          Reading your local history with {name} failed.
          <span className={styles.emptyActions}>
            <button
              type="button"
              className={styles.button}
              onClick={() => {
                resetInsights(name);
                void loadInsights(identityId, name);
              }}
            >
              Retry
            </button>
          </span>
        </EmptyState>
      </>
    );
  }
  const crossed =
    insights.messagesSent + insights.messagesReceived > 0 ||
    insights.lastSeenTalkingAt !== null ||
    insights.sharedChannels.length > 0;
  if (!crossed) {
    return (
      <>
        {noteBlock}
        <EmptyState glyph="⇄" title="You haven't crossed paths yet">
          Once you share a channel or exchange messages with {name}, your
          history together will show up here.
        </EmptyState>
      </>
    );
  }
  return (
    <>
      {noteBlock}
      <div className={styles.insightsEyebrow}>
        <span className={styles.noteDot} aria-hidden />
        YOU × {name}
      </div>
      <div className={styles.insightsSub}>
        from your local history, never fetched from F-List
      </div>
      <div className={styles.columns}>
        <InsightGroup
          label="Conversation"
          rows={[
            [
              "Messages exchanged",
              String(insights.messagesSent + insights.messagesReceived),
              true,
            ],
            [
              "First encountered",
              insights.firstEncountered
                ? `${dateLabel(insights.firstEncountered.at)} · ${insights.firstEncountered.conversation}`
                : "—",
            ],
            [
              "Last chatted",
              insights.lastChattedAt ? ago(insights.lastChattedAt) : "never",
            ],
            [
              "Last seen talking",
              insights.lastSeenTalkingAt
                ? ago(insights.lastSeenTalkingAt)
                : "—",
            ],
          ]}
        />
        <InsightGroup
          label="Right now"
          rows={[
            [
              "Currently online",
              insights.online
                ? `yes${insights.status ? ` · ${insights.status}` : ""}`
                : ownCharacter
                  ? "no"
                  : "unknown (disconnected)",
              insights.online,
            ],
            [
              "Shared channels",
              insights.sharedChannels.length > 0
                ? insights.sharedChannels.join(", ")
                : "none right now",
            ],
          ]}
        />
        <InsightGroup
          label="This profile"
          rows={[
            ["Times you've viewed", String(insights.timesViewed)],
            [
              "First viewed",
              insights.firstViewedAt ? dateLabel(insights.firstViewedAt) : "—",
            ],
          ]}
        />
      </div>
    </>
  );
}

function InsightGroup({
  label,
  rows,
}: {
  label: string;
  rows: [string, string, boolean?][];
}) {
  return (
    <section className={styles.group}>
      <div className={styles.groupLabel}>{label}</div>
      {rows.map(([rowLabel, value, headline]) => (
        <div
          key={rowLabel}
          className={`${styles.detailRow} ${styles.insightRow}`}
        >
          <span className={styles.detailLabel}>{rowLabel}</span>
          <span
            className={`${styles.detailValue} ${headline ? styles.insightHeadline : ""}`}
          >
            {value}
          </span>
        </div>
      ))}
    </section>
  );
}

// ── Loading / error states ───────────────────────────────────────────────────

function LoadingState({ name }: { name: string }) {
  return (
    <>
      <header className={styles.header}>
        <Avatar name={name} size={56} square />
        <div className={styles.headerInfo}>
          <div className={styles.nameRow}>
            <span className={styles.name}>{name}</span>
          </div>
          <div className={styles.metaRow}>fetching…</div>
        </div>
      </header>
      <div className={styles.tabs} aria-hidden>
        {TABS.map((tab) => (
          <span key={tab.id} className={styles.tab}>
            {tab.label}
          </span>
        ))}
      </div>
      <div className={styles.content}>
        <div
          className={styles.shimmer}
          style={{ height: 14, width: "70%", marginBottom: 10 }}
        />
        <div
          className={styles.shimmer}
          style={{ height: 14, width: "90%", marginBottom: 10 }}
        />
        <div className={styles.shimmer} style={{ height: 14, width: "55%" }} />
      </div>
    </>
  );
}

function ErrorState({
  identityId,
  name,
  loaded,
}: {
  identityId: string;
  name: string;
  loaded: LoadedProfile;
}) {
  const budget = loaded.state === "budget";
  return (
    <div className={styles.content}>
      <EmptyState
        glyph="?"
        title={
          budget
            ? "Profile budget exhausted"
            : loaded.state === "error"
              ? "Couldn't load profile"
              : "Profile not found"
        }
      >
        {loaded.error ??
          (budget
            ? "The hourly F-List budget is used up and there is no cached copy yet."
            : `F-List doesn't know a character named “${name}”.`)}
        <span className={styles.emptyActions}>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              void loadProfile(identityId, name, true);
            }}
          >
            Retry
          </button>
          <a
            className={styles.button}
            href={`https://www.f-list.net/c/${encodeURIComponent(name)}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            Open on f-list.net ↗
          </a>
        </span>
      </EmptyState>
    </div>
  );
}

function EmptyState({
  glyph,
  title,
  children,
}: {
  glyph: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.emptyState}>
      <span className={styles.emptyTile} aria-hidden>
        {glyph}
      </span>
      <span className={styles.emptyTitle}>{title}</span>
      <span className={styles.emptyBody}>{children}</span>
    </div>
  );
}
