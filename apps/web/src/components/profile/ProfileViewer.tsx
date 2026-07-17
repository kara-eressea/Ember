// Full profile viewer (M8, COMPONENTS-profile-viewer.md §1–§8): 900×640
// modal — HistoryRail + header/tabs/content column. Step 7 ships Overview /
// Details / Kinks / Insights; Compare arrives with the matcher surfaces
// (step 9), Images/Guestbook with step 10.

import { useEffect, useMemo, useRef, useState } from "react";
import { match } from "@emberchat/matcher";
import type { ProfileDto } from "@emberchat/protocol";
import { nickColor } from "../../theme/tokens.js";
import { loadSocial } from "../../lib/social.js";
import { api } from "../../lib/api.js";
import {
  loadHistory,
  loadInsights,
  loadOwnProfile,
  loadProfile,
  removeHistoryEntry,
  saveNoteDebounced,
  useProfileStore,
  type LoadedProfile,
} from "../../stores/profile.js";
import { useSessionsStore } from "../../stores/sessions.js";
import { Avatar } from "../common/Avatar.js";
import { CHOICES } from "./choices.js";
import { CompareTab } from "./CompareTab.js";
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
        className={styles.window}
        role="dialog"
        aria-modal="true"
        aria-label={`Profile: ${viewing}`}
        tabIndex={-1}
        ref={windowRef}
      >
        <HistoryRail identityId={identityId} viewing={viewing} />
        <div className={styles.main}>
          <ViewerBody
            key={viewing.toLowerCase()}
            identityId={identityId}
            name={viewing}
            loaded={loaded}
            activeTab={activeTab}
            ownCharacter={ownCharacter}
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
            return (
              <button
                key={entry.name.toLowerCase()}
                type="button"
                className={`${styles.histRow} ${active ? styles.histRowActive : ""}`}
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
                <span
                  className={styles.histRemove}
                  role="button"
                  aria-label={`Remove ${entry.name} from history`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void removeHistoryEntry(identityId, entry.name);
                  }}
                >
                  ×
                </span>
              </button>
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
}: {
  identityId: string;
  name: string;
  loaded: LoadedProfile | undefined;
  activeTab: TabId;
  ownCharacter: string | undefined;
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
      <div className={styles.content}>
        <TabContent
          identityId={identityId}
          profile={profile}
          activeTab={activeTab}
          ownCharacter={ownCharacter}
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
}: {
  identityId: string;
  profile: ProfileDto;
  activeTab: TabId;
  ownCharacter: string | undefined;
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
          <ProfileBBCode bbcode={profile.description} />
        </>
      );
    case "details":
      return <DetailsTab profile={profile} />;
    case "kinks":
      return <KinksTab profile={profile} />;
    case "compare":
      return (
        <CompareTab
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
      return <ImagesTab profile={profile} />;
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
  const isBookmarked = social?.bookmarks.some(
    (row) => row.name.toLowerCase() === profile.name.toLowerCase(),
  );
  const [tooltip, setTooltip] = useState(false);
  const accent = nickColor(profile.name);

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
          <span
            className={`${styles.badge} ${
              isBookmarked ? styles.badgeBookmarkOn : styles.badgeBookmark
            }`}
            title={isBookmarked ? "Bookmarked" : "Not bookmarked"}
          >
            ⚑
          </span>
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
      <div className={styles.noteZone}>
        <PrivateNote
          identityId={identityId}
          name={profile.name}
          initial={response.note}
        />
      </div>
    </header>
  );
}

function PrivateNote({
  identityId,
  name,
  initial,
}: {
  identityId: string;
  name: string;
  initial: string | null;
}) {
  const [mode, setMode] = useState<"idle" | "editing">("idle");
  const [body, setBody] = useState(initial ?? "");
  const [saved, setSaved] = useState(false);

  function edit(next: string) {
    setBody(next);
    setSaved(false);
    saveNoteDebounced(identityId, name, next, () => {
      setSaved(true);
    });
  }

  if (mode === "editing") {
    return (
      <div className={styles.noteEditor}>
        <span className={styles.noteEyebrow}>
          <span className={styles.noteDot} aria-hidden />
          PRIVATE NOTE
          {saved && <span className={styles.noteSaved}>Saved ✓</span>}
        </span>
        <textarea
          className={styles.noteBody}
          value={body}
          autoFocus
          placeholder={`Anything you want to remember about ${name}…`}
          onChange={(event) => {
            edit(event.target.value);
          }}
          onBlur={() => {
            if (body.trim() === "") {
              setMode("idle");
            }
          }}
        />
        <span className={styles.noteFoot}>
          autosaves · only you can see this
          {body === "" && (
            <>
              {" · "}
              <button
                type="button"
                className={styles.noteImport}
                onClick={() => {
                  void api
                    .getProfileMemo(identityId, name)
                    .then(({ note }) => {
                      if (note) {
                        edit(note);
                      }
                    })
                    .catch(() => {
                      // No memo / upstream trouble — the affordance is best-effort.
                    });
                }}
              >
                import F-List memo
              </button>
            </>
          )}
        </span>
      </div>
    );
  }

  if (body.trim() === "") {
    return (
      <button
        type="button"
        className={styles.noteAdd}
        onClick={() => {
          setMode("editing");
        }}
      >
        + Add private note
      </button>
    );
  }

  return (
    <button
      type="button"
      className={styles.notePeek}
      onClick={() => {
        setMode("editing");
      }}
    >
      <span className={styles.noteEyebrow}>
        <span className={styles.noteDot} aria-hidden />
        PRIVATE NOTE
        <span className={styles.notePencil} aria-hidden>
          ✎
        </span>
      </span>
      <span className={styles.notePreview}>{body}</span>
    </button>
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
  useEffect(() => {
    void loadInsights(identityId, name);
  }, [identityId, name]);

  if (!insights) {
    return <div className={styles.shimmer} style={{ height: 120 }} />;
  }
  const crossed =
    insights.messagesSent + insights.messagesReceived > 0 ||
    insights.lastSeenTalkingAt !== null ||
    insights.sharedChannels.length > 0;
  if (!crossed) {
    return (
      <EmptyState glyph="⇄" title="You haven't crossed paths yet">
        Once you share a channel or exchange messages with {name}, your history
        together will show up here.
      </EmptyState>
    );
  }
  return (
    <>
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
        title={budget ? "Profile budget exhausted" : "Profile not found"}
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
