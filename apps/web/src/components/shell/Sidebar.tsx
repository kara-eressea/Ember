// Sidebar (COMPONENTS.md §2–4): ServerHead · toolbar (filter + browser
// entry points, #196) · sections (Pinned, Channels, Direct Messages,
// Friends, Bookmarks) · MeBar. Section headings collapse (#168, per-device
// localStorage); friends/bookmarks sort online-first (#164) and offline
// rows hide behind the hideOfflineCharacters pref (#165). The social
// sections load lazily (four upstream F-List calls) and refresh on demand;
// incoming friend requests render as actionable rows like channel invites.

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate } from "react-router";
import {
  CLIENT_SETTABLE_STATUSES,
  type ClientSettableStatus,
  type MemberDto,
} from "@emberchat/protocol";
import { gateway } from "../../gateway/socket.js";
import { api } from "../../lib/api.js";
import { appConfig } from "../../lib/config.js";
import { presenceDot, type DotKind } from "../../lib/presence.js";
import { clampBadge, DOT_CLASS } from "./badges.js";
import { channelPath, dmPath } from "../../lib/routes.js";
import { loadSocial } from "../../lib/social.js";
import { patchPrefs } from "../prefs/patch.js";
import {
  useSessionsStore,
  type ChannelInvite,
  type ChannelView,
  type DmView,
  type IdentitySession,
  type SocialCharacter,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { Avatar } from "../common/Avatar.js";
import { MemberContextMenu } from "../chat/MemberContextMenu.js";
import { matchScore } from "./quick-switch.js";
import { orderRows, orderSocial } from "./sidebar-order.js";
import {
  loadCollapsedSections,
  toggleCollapsedSection,
  type CollapsedSections,
  type SidebarSection,
} from "./sidebar-sections.js";
import styles from "./shell.module.css";

/** Bounded wait for the joined conversation row to reach the store. */
async function waitForJoin(
  identityId: string,
  key: string,
): Promise<ChannelView | undefined> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const channel =
      useSessionsStore.getState().sessions[identityId]?.channels[key];
    if (channel?.joined) {
      return channel;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

/** Rough pre-clamp so the context menu doesn't flash off-screen for a
 * frame; the menu re-clamps against its measured size once rendered. */
const MENU_WIDTH = 216;

/** Right-click target of a sidebar people row (DM / friend / bookmark). */
interface PersonMenuState {
  member: MemberDto;
  position: { x: number; y: number };
}

export interface SidebarProps {
  session: IdentitySession;
  activeConvId: string | undefined;
}

export function Sidebar({ session, activeConvId }: SidebarProps) {
  const gatewayStatus = useUiStore((s) => s.gatewayStatus);
  const online = session.sessionStatus === "online";
  const headDot: DotKind =
    online && gatewayStatus === "online"
      ? "ok"
      : gatewayStatus === "connecting" ||
          session.sessionStatus === "connecting" ||
          session.sessionStatus === "identifying" ||
          session.sessionStatus === "acquiring_ticket"
        ? "warn"
        : "faint";

  // Toolbar filter (#196): one query narrows every section as you type —
  // subsequence matching, same behavior as the quick switcher.
  const [query, setQuery] = useState("");
  const trimmed = query.trim();
  const filtering = trimmed !== "";
  const matches = (label: string) =>
    !filtering || matchScore(trimmed, label) !== undefined;

  // Collapsed sections (#168) — per-device, survives reloads. A live
  // filter overrides collapse so matches are never invisibly hidden.
  const [collapsed, setCollapsed] = useState<CollapsedSections>(
    loadCollapsedSections,
  );
  const toggleSection = (section: SidebarSection) => {
    setCollapsed((current) => toggleCollapsedSection(current, section));
  };
  const openSection = (section: SidebarSection) =>
    filtering || collapsed[section] !== true;

  // Right-click identity menu on people rows (#167) — the same menu the
  // channel member list uses, minus the channel-only sections.
  const [personMenu, setPersonMenu] = useState<PersonMenuState>();
  const openPersonMenu = (
    event: ReactMouseEvent,
    character: string,
    status: string,
    statusmsg: string,
  ) => {
    event.preventDefault();
    setPersonMenu({
      member: { character, gender: "", status, statusmsg },
      position: {
        x: Math.min(event.clientX, window.innerWidth - MENU_WIDTH),
        y: Math.min(event.clientY, window.innerHeight - 160),
      },
    });
  };

  // convId "" = volatile placeholder whose conversation row is still being
  // written; it becomes routable one event later.
  const bump = session.prefs.highlightBump;
  const allChannels = orderRows(
    Object.values(session.channels).filter(
      (channel) => channel.convId !== "" && matches(channel.title),
    ),
    (c) => c.title,
    (c) => c.highlightedAt,
    bump,
  );
  const allDms = orderRows(
    Object.values(session.dms).filter((dm) => matches(dm.partner)),
    (d) => d.partner,
    (d) => d.highlightedAt,
    bump,
  );
  // Pinning is cross-type (COMPONENTS.md §3): pinned channels and DMs
  // surface together under Pinned; the rest stay in their type sections.
  const pinnedChannels = allChannels.filter((c) => c.pinned);
  const pinnedDms = allDms.filter((d) => d.pinned);
  const channels = allChannels.filter((c) => !c.pinned);
  const dms = allDms.filter((d) => !d.pinned);

  // Friends/Bookmarks: online first (#164), offline hidden behind the
  // synced pref (#165), then the toolbar filter like everything else.
  const hideOffline = session.prefs.hideOfflineCharacters;
  const socialRows = (rows: readonly SocialCharacter[] | undefined) =>
    orderSocial(
      (rows ?? []).filter(
        (row) => (row.online || !hideOffline) && matches(row.name),
      ),
      (row) => row.name,
      (row) => row.online,
    );
  const friends = socialRows(session.social?.friends);
  const bookmarks = socialRows(session.social?.bookmarks);

  const nothingMatched =
    filtering &&
    allChannels.length + allDms.length + friends.length + bookmarks.length ===
      0;

  const channelRow = (channel: ChannelView, pinned: boolean) => (
    <NavRow
      key={`c:${channel.key}`}
      to={channelPath(session.character, channel.key)}
      active={channel.convId === activeConvId}
      unread={channel.unread}
      mentions={channel.mentions}
      pinned={pinned}
      glyph="#"
      label={channel.title}
    />
  );
  const dmRow = (dm: DmView, pinned: boolean) => (
    <NavRow
      key={`d:${dm.convId}`}
      to={dmPath(session.character, dm.partner)}
      active={dm.convId === activeConvId}
      unread={dm.unread}
      pinned={pinned}
      dot={presenceDot(dm.online, dm.status)}
      offline={!dm.online}
      label={dm.partner}
      onContextMenu={(event) => {
        openPersonMenu(event, dm.partner, dm.status, dm.statusmsg);
      }}
    />
  );

  return (
    <nav className={styles.sidebar}>
      <div className={styles.serverHead}>
        <span className={`${styles.serverDot} ${DOT_CLASS[headDot]}`} />
        <span className={styles.serverMeta}>
          <div className={styles.serverName}>{appConfig().appName}</div>
          <div className={styles.serverSub}>
            {session.character || "…"} · {sessionStatusLabel(session)}
          </div>
        </span>
      </div>

      <div className={styles.toolbar}>
        <input
          className={styles.toolbarSearch}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setQuery("");
            }
          }}
          placeholder="Filter channels and people…"
          aria-label="Filter the channel list"
        />
        <button
          type="button"
          className={styles.toolbarBtn}
          title="Browse channels"
          aria-label="Browse channels"
          onClick={() => {
            useUiStore.getState().setChannelBrowserOpen(true);
          }}
        >
          #
        </button>
        <button
          type="button"
          className={styles.toolbarBtn}
          title="Search characters"
          aria-label="Search characters"
          onClick={() => {
            useUiStore.getState().setCharacterSearchOpen(true);
          }}
        >
          ⌕
        </button>
      </div>

      <div className={styles.navScroll}>
        {pinnedChannels.length + pinnedDms.length > 0 && (
          <>
            <div className={styles.sectionHeader}>
              <span>Pinned</span>
              <span>{pinnedChannels.length + pinnedDms.length}</span>
            </div>
            {pinnedChannels.map((channel) => channelRow(channel, true))}
            {pinnedDms.map((dm) => dmRow(dm, true))}
          </>
        )}

        <SectionHeader
          label="Channels"
          count={channels.length}
          collapsed={!openSection("channels")}
          onToggle={() => {
            toggleSection("channels");
          }}
        />
        {openSection("channels") &&
          channels.map((channel) => channelRow(channel, false))}
        {session.invites.map((invite) => (
          <InviteRow key={invite.key} session={session} invite={invite} />
        ))}

        <SectionHeader
          label="Direct messages"
          count={dms.length}
          collapsed={!openSection("dms")}
          onToggle={() => {
            toggleSection("dms");
          }}
        />
        {openSection("dms") && dms.map((dm) => dmRow(dm, false))}

        <SocialSections
          session={session}
          friends={friends}
          bookmarks={bookmarks}
          filtering={filtering}
          openSection={openSection}
          onToggle={toggleSection}
          onRowContextMenu={openPersonMenu}
        />

        {nothingMatched && (
          <div className={styles.socialEmpty}>Nothing here matches.</div>
        )}
        {filtering && (
          <button
            type="button"
            className={`${styles.navItem} ${styles.socialRow ?? ""}`}
            onClick={() => {
              setQuery("");
              useUiStore.getState().setChannelBrowserOpen(true);
            }}
          >
            <span className={styles.navGlyph}>#</span>
            <span className={styles.navLabel}>Browse all channels…</span>
          </button>
        )}
      </div>

      {personMenu && (
        <MemberContextMenu
          identityId={session.identityId}
          ownCharacter={session.character}
          channelTitle={`Conversation with ${personMenu.member.character}`}
          member={personMenu.member}
          position={personMenu.position}
          onClose={() => {
            setPersonMenu(undefined);
          }}
        />
      )}

      <div className={styles.meBar}>
        <Avatar name={session.character || "?"} size={30} />
        <MeStatus session={session} online={online} />
        <PowerButton session={session} />
        <button
          type="button"
          className={styles.meGear}
          title="Preferences"
          aria-label="Preferences"
          onClick={() => {
            useUiStore.getState().setPrefsOpen(true);
          }}
        >
          ⚙
        </button>
      </div>
    </nav>
  );
}

/** Collapsible section heading (#168): the chevron + label toggle; the
 * right side keeps the count (and any trailing actions). */
function SectionHeader({
  label,
  count,
  collapsed,
  onToggle,
  actions,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  actions?: ReactNode;
}) {
  return (
    <div className={styles.sectionHeader}>
      <button
        type="button"
        className={styles.sectionToggle}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <span className={styles.sectionChevron} aria-hidden>
          {collapsed ? "▸" : "▾"}
        </span>
        {label}
      </button>
      <span className={styles.sectionMeta}>
        {count || ""}
        {actions}
      </span>
    </div>
  );
}

/**
 * Nick + status row of the MeBar. While the session is online it doubles as
 * the status control (F-Chat STA): clicking it opens a small editor above
 * the bar — status select, optional message, one Set button. The session
 * remembers the choice across reconnects; the fan-out converges every tab.
 */
function MeStatus({
  session,
  online,
}: {
  session: IdentitySession;
  online: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ClientSettableStatus>("online");
  const [statusmsg, setStatusmsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const containerRef = useRef<HTMLSpanElement>(null);

  // Escape / click-outside close the editor, like every other popover.
  useEffect(() => {
    if (!open) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const statusLine = online
    ? session.ownStatus +
      (session.ownStatusmsg ? ` — ${session.ownStatusmsg}` : "")
    : sessionStatusLabel(session);
  const dot: DotKind = online ? presenceDot(true, session.ownStatus) : "faint";

  function toggle() {
    if (!open) {
      // Seed the editor with the current choice, not the last edit.
      const current = CLIENT_SETTABLE_STATUSES.find(
        (s) => s === session.ownStatus,
      );
      setStatus(current ?? "online");
      setStatusmsg(session.ownStatusmsg);
      setError(undefined);
    }
    setOpen(!open);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const ack = await gateway.cmd({
        identityId: session.identityId,
        action: "status.set",
        d: { status, statusmsg: statusmsg.trim() },
      });
      if (!ack.ok) {
        setError(ack.error ?? "Could not set status");
        return;
      }
      // Fold a non-empty message into the recents chips (M9) — dedupe,
      // most-recent-first, whole-array patch per the recents convention.
      const message = statusmsg.trim();
      if (message !== "") {
        const recents = [
          message,
          ...session.prefs.statusMessageRecents.filter(
            (entry) => entry !== message,
          ),
        ].slice(0, 20);
        void patchPrefs(session.identityId, {
          statusMessageRecents: recents,
        });
      }
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={styles.meMeta} ref={containerRef}>
      <div className={styles.meNick}>{session.character || "—"}</div>
      <button
        className={styles.meStatusButton}
        onClick={toggle}
        disabled={!online}
        title={online ? "Set status" : undefined}
        aria-label="Set status"
      >
        <span className={`${styles.serverDot} ${DOT_CLASS[dot]}`} />
        <span className={styles.meStatusText}>{statusLine}</span>
      </button>
      {open && online && (
        <form
          className={styles.statusEditor}
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <select
            className={styles.miniInput}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as ClientSettableStatus);
            }}
            aria-label="Status"
          >
            {CLIENT_SETTABLE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            className={styles.miniInput}
            value={statusmsg}
            onChange={(e) => {
              setStatusmsg(e.target.value);
            }}
            maxLength={255}
            placeholder="Status message…"
            aria-label="Status message"
          />
          <button className={styles.miniButton} type="submit" disabled={busy}>
            Set
          </button>
          {session.prefs.statusMessageRecents.length > 0 && (
            <div className={styles.statusRecents}>
              {session.prefs.statusMessageRecents.slice(0, 5).map((recent) => (
                <button
                  key={recent}
                  type="button"
                  className={styles.statusRecentChip}
                  title={recent}
                  onClick={() => {
                    setStatusmsg(recent);
                  }}
                >
                  {recent}
                </button>
              ))}
            </div>
          )}
          {error && (
            <p className={styles.miniError} role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </span>
  );
}

/**
 * Explicit connect/disconnect (M2: closing the tab never disconnects — this
 * is the one deliberate way to log a character off the bouncer). The local
 * autoConnect mirror keeps the shell from silently reconnecting an identity
 * the user just logged off.
 */
function PowerButton({ session }: { session: IdentitySession }) {
  const [busy, setBusy] = useState(false);
  const connected =
    session.sessionStatus !== "offline" && session.sessionStatus !== "stopped";

  async function toggle() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const action = connected ? "session.disconnect" : "session.connect";
      const ack = await gateway.cmd({
        identityId: session.identityId,
        action,
      });
      if (ack.ok) {
        useSessionsStore
          .getState()
          .setAutoConnect(session.identityId, !connected);
      } else {
        useSessionsStore
          .getState()
          .applyNotice(
            session.identityId,
            "error",
            ack.error ??
              (connected ? "Could not log off" : "Could not connect"),
          );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className={styles.meGear}
      onClick={() => {
        void toggle();
      }}
      disabled={busy}
      title={connected ? "Log off F-Chat" : "Connect to F-Chat"}
      aria-label={connected ? "Log off F-Chat" : "Connect to F-Chat"}
    >
      ⏻
    </button>
  );
}

function sessionStatusLabel(session: IdentitySession): string {
  if (session.sessionStatus === "stopped" && session.statusReason) {
    return `stopped — ${session.statusReason}`;
  }
  return session.sessionStatus.replace("_", " ");
}

interface NavRowProps {
  to: string;
  active: boolean;
  unread: number;
  label: string;
  mentions?: number;
  pinned?: boolean;
  glyph?: string;
  dot?: DotKind;
  offline?: boolean;
  onContextMenu?: (event: ReactMouseEvent) => void;
}

function NavRow({
  to,
  active,
  unread,
  label,
  mentions = 0,
  pinned = false,
  glyph,
  dot,
  offline,
  onContextMenu,
}: NavRowProps) {
  const classes = [styles.navItem];
  if (active) {
    classes.push(styles.active);
  }
  if (unread > 0) {
    classes.push(styles.unread);
  }
  if (offline) {
    classes.push(styles.offlineRow);
  }
  return (
    <Link className={classes.join(" ")} to={to} onContextMenu={onContextMenu}>
      {glyph !== undefined && <span className={styles.navGlyph}>{glyph}</span>}
      {dot !== undefined && (
        <span className={`${styles.navDot} ${DOT_CLASS[dot]}`} />
      )}
      <span className={styles.navLabel}>{label}</span>
      {pinned && <span className={styles.navPin}>⚲</span>}
      {mentions > 0 ? (
        <span
          className={`${styles.navBadge} ${styles.navBadgeMention ?? ""}`}
          data-testid="nav-badge"
        >
          @{clampBadge(mentions)}
        </span>
      ) : (
        unread > 0 && (
          <span className={styles.navBadge} data-testid="nav-badge">
            {clampBadge(unread)}
          </span>
        )
      )}
    </Link>
  );
}

/**
 * An inbound channel invitation (CIU) as an actionable row: join or
 * dismiss. Volatile by design — a dismissed or missed invite stays joinable
 * later through the channel browser's hidden-by-name footer.
 */
function InviteRow({
  session,
  invite,
}: {
  session: IdentitySession;
  invite: ChannelInvite;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function join() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const ack = await gateway.cmd({
        identityId: session.identityId,
        action: "channel.join",
        d: { key: invite.key },
      });
      if (!ack.ok) {
        useSessionsStore
          .getState()
          .applyNotice(
            session.identityId,
            "error",
            ack.error ?? "Could not join",
          );
        return;
      }
      const channel = await waitForJoin(session.identityId, invite.key);
      if (!channel) {
        useSessionsStore
          .getState()
          .applyNotice(
            session.identityId,
            "error",
            "No response from the channel — the invite may have expired",
          );
        return;
      }
      useSessionsStore.getState().dismissInvite(session.identityId, invite.key);
      void navigate(channelPath(session.character, channel.key));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.inviteRow}>
      <span
        className={styles.inviteText}
        title={`${invite.title} (${invite.key})`}
      >
        ✉ <strong>{invite.sender}</strong> invited you to{" "}
        <strong>{invite.title}</strong>
      </span>
      <button
        type="button"
        className={styles.miniButton}
        aria-label={`Join ${invite.title}`}
        disabled={busy || session.sessionStatus !== "online"}
        onClick={() => {
          void join();
        }}
      >
        Join
      </button>
      <button
        type="button"
        className={styles.inviteDismiss}
        aria-label={`Dismiss invite to ${invite.title}`}
        onClick={() => {
          useSessionsStore
            .getState()
            .dismissInvite(session.identityId, invite.key);
        }}
      >
        ✕
      </button>
    </div>
  );
}

/**
 * Friends and Bookmarks (M6 step 7): lazily loaded through the social REST
 * endpoint (four upstream F-List calls behind the shared 1 req/s budget —
 * hence load-once + explicit ↻). Rows open a DM; incoming friend requests
 * are actionable like channel invites. The parent hands in the already
 * sorted/filtered row lists so the toolbar filter and the offline pref
 * apply uniformly.
 */
function SocialSections({
  session,
  friends,
  bookmarks,
  filtering,
  openSection,
  onToggle,
  onRowContextMenu,
}: {
  session: IdentitySession;
  friends: SocialCharacter[];
  bookmarks: SocialCharacter[];
  filtering: boolean;
  openSection: (section: SidebarSection) => boolean;
  onToggle: (section: SidebarSection) => void;
  onRowContextMenu: (
    event: ReactMouseEvent,
    character: string,
    status: string,
    statusmsg: string,
  ) => void;
}) {
  const identityId = session.identityId;
  const social = session.social;
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    // No synchronous state write here (lint): the load either resolves
    // (social data replaces any stale error implicitly on render) or
    // rejects and sets a fresh error.
    loadSocial(identityId).then(
      () => {
        setLoadError(undefined);
      },
      (error: unknown) => {
        setLoadError(error instanceof Error ? error.message : "Couldn't load");
      },
    );
  }, [identityId]);

  async function respond(requestId: number, action: "accept" | "deny") {
    try {
      await api.postFriendRequest(identityId, { action, requestId });
      await loadSocial(identityId, true);
    } catch (error) {
      useSessionsStore
        .getState()
        .applyNotice(
          identityId,
          "error",
          error instanceof Error ? error.message : "Request failed",
        );
    }
  }

  const refresh = (
    <button
      type="button"
      className={styles.sectionAction}
      title="Refresh friends and bookmarks"
      aria-label="Refresh friends and bookmarks"
      onClick={() => {
        setLoadError(undefined);
        loadSocial(identityId, true).catch((error: unknown) => {
          setLoadError(
            error instanceof Error ? error.message : "Couldn't load",
          );
        });
      }}
    >
      ↻
    </button>
  );

  const row = (character: SocialCharacter, glyph: string) => (
    <SocialRow
      key={character.name}
      session={session}
      character={character}
      glyph={glyph}
      onContextMenu={(event) => {
        onRowContextMenu(
          event,
          character.name,
          character.status,
          character.statusmsg,
        );
      }}
    />
  );

  return (
    <>
      <SectionHeader
        label="Friends"
        count={friends.length}
        collapsed={!openSection("friends")}
        onToggle={() => {
          onToggle("friends");
        }}
        actions={refresh}
      />
      {loadError !== undefined && (
        <div className={styles.socialEmpty} role="alert">
          Couldn't load — {loadError}. Use ↻ to retry.
        </div>
      )}
      {social?.incoming.map((request) => (
        <div className={styles.inviteRow} key={`fr:${String(request.id)}`}>
          <span className={styles.inviteText}>
            ♥ <strong>{request.name}</strong> sent a friend request
          </span>
          <button
            type="button"
            className={styles.miniButton}
            aria-label={`Accept friend request from ${request.name}`}
            onClick={() => {
              void respond(request.id, "accept");
            }}
          >
            Accept
          </button>
          <button
            type="button"
            className={styles.inviteDismiss}
            aria-label={`Deny friend request from ${request.name}`}
            onClick={() => {
              void respond(request.id, "deny");
            }}
          >
            ✕
          </button>
        </div>
      ))}
      {openSection("friends") && friends.map((friend) => row(friend, "★"))}
      {openSection("friends") &&
        !filtering &&
        social !== undefined &&
        social.friends.length === 0 && (
          <div className={styles.socialEmpty}>No friends yet.</div>
        )}

      <SectionHeader
        label="Bookmarks"
        count={bookmarks.length}
        collapsed={!openSection("bookmarks")}
        onToggle={() => {
          onToggle("bookmarks");
        }}
      />
      {openSection("bookmarks") &&
        bookmarks.map((bookmark) => row(bookmark, "⚑"))}
      {openSection("bookmarks") &&
        !filtering &&
        social !== undefined &&
        social.bookmarks.length === 0 && (
          <div className={styles.socialEmpty}>No bookmarks yet.</div>
        )}
    </>
  );
}

/** One friend/bookmark: presence dot + relationship glyph (§4: ★ friend,
 * ⚑ bookmark — same vocabulary as the profile badges) + name; clicking
 * opens the DM, right-clicking the identity menu (#167). */
function SocialRow({
  session,
  character,
  glyph,
  onContextMenu,
}: {
  session: IdentitySession;
  character: SocialCharacter;
  glyph: string;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  const navigate = useNavigate();

  async function open() {
    const ack = await gateway.cmd({
      identityId: session.identityId,
      action: "pm.open",
      d: { character: character.name },
    });
    if (!ack.ok || !ack.conversation) {
      useSessionsStore
        .getState()
        .applyNotice(
          session.identityId,
          "error",
          ack.error ?? "Could not open the conversation",
        );
      return;
    }
    useSessionsStore
      .getState()
      .applyConversation(session.identityId, ack.conversation);
    void navigate(
      dmPath(session.character, ack.conversation.partnerCharacter ?? ""),
    );
  }

  return (
    <button
      type="button"
      className={`${styles.navItem} ${styles.socialRow ?? ""} ${character.online ? "" : (styles.offlineRow ?? "")}`}
      onClick={() => {
        void open();
      }}
      onContextMenu={onContextMenu}
      title={
        character.online
          ? `${character.status}${character.statusmsg ? ` — ${character.statusmsg}` : ""}`
          : "offline"
      }
    >
      <span
        className={`${styles.navDot} ${DOT_CLASS[presenceDot(character.online, character.status)]}`}
      />
      <span className={styles.socialGlyph} aria-hidden>
        {glyph}
      </span>
      <span className={styles.navLabel}>{character.name}</span>
    </button>
  );
}
