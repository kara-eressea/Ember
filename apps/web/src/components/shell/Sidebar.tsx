// Sidebar (COMPONENTS.md §2–4): ServerHead · sections (Pinned, Channels,
// Direct Messages) · MeBar. Channel discovery is the M6 ChannelBrowser;
// until then joining happens through the join-by-name mini form. Friends/
// Bookmarks sections arrive with their milestones.

import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import {
  CLIENT_SETTABLE_STATUSES,
  type ClientSettableStatus,
} from "@emberchat/protocol";
import { gateway } from "../../gateway/socket.js";
import { appConfig } from "../../lib/config.js";
import { presenceDot, type DotKind } from "../../lib/presence.js";
import { channelPath, dmPath } from "../../lib/routes.js";
import {
  useSessionsStore,
  type ChannelView,
  type DmView,
  type IdentitySession,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { Avatar } from "../common/Avatar.js";
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

const DOT_CLASS: Record<DotKind, string> = {
  ok: styles.dotOk!,
  warn: styles.dotWarn!,
  faint: styles.dotFaint!,
};

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

  // convId "" = volatile placeholder whose conversation row is still being
  // written; it becomes routable one event later.
  const allChannels = Object.values(session.channels)
    .filter((channel) => channel.convId !== "")
    .sort((a, b) => a.title.localeCompare(b.title));
  const allDms = Object.values(session.dms).sort((a, b) =>
    a.partner.localeCompare(b.partner),
  );
  // Pinning is cross-type (COMPONENTS.md §3): pinned channels and DMs
  // surface together under Pinned; the rest stay in their type sections.
  const pinnedChannels = allChannels.filter((c) => c.pinned);
  const pinnedDms = allDms.filter((d) => d.pinned);
  const channels = allChannels.filter((c) => !c.pinned);
  const dms = allDms.filter((d) => !d.pinned);

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

        <div className={styles.sectionHeader}>
          <span>Channels</span>
          <span>{channels.length || ""}</span>
        </div>
        {channels.map((channel) => channelRow(channel, false))}
        <JoinChannelForm session={session} />

        <div className={styles.sectionHeader}>
          <span>Direct messages</span>
          <span>{dms.length || ""}</span>
        </div>
        {dms.map((dm) => dmRow(dm, false))}
        <NewDmForm session={session} />
      </div>

      <div className={styles.meBar}>
        <Avatar name={session.character || "?"} size={30} />
        <MeStatus session={session} online={online} />
        <PowerButton session={session} />
        <Link
          className={styles.meGear}
          to="/identities"
          title="Identities & settings"
        >
          ⚙
        </Link>
      </div>
    </nav>
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
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={styles.meMeta}>
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
    <Link className={classes.join(" ")} to={to}>
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
          @{mentions > 99 ? "99+" : mentions}
        </span>
      ) : (
        unread > 0 && (
          <span className={styles.navBadge} data-testid="nav-badge">
            {unread > 99 ? "99+" : unread}
          </span>
        )
      )}
    </Link>
  );
}

function JoinChannelForm({ session }: { session: IdentitySession }) {
  const navigate = useNavigate();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = key.trim();
    if (!trimmed || busy) {
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      const ack = await gateway.cmd({
        identityId: session.identityId,
        action: "channel.join",
        d: { key: trimmed },
      });
      if (!ack.ok) {
        setError(ack.error ?? "Could not join");
        return;
      }
      // The ack only confirms the send; the join is real when the sink's
      // conversation row lands in the store (JCH echo → persisted → fan-out).
      const channel = await waitForJoin(session.identityId, trimmed);
      if (!channel) {
        setError("No response from the channel — check the name");
        return;
      }
      setKey("");
      void navigate(channelPath(session.character, channel.key));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form
        className={styles.miniForm}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <input
          className={styles.miniInput}
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
          }}
          placeholder="Join a channel…"
          aria-label="Join a channel"
        />
        <button
          className={styles.miniButton}
          type="submit"
          disabled={session.sessionStatus !== "online" || busy}
        >
          Join
        </button>
      </form>
      {error && (
        <p className={styles.miniError} role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function NewDmForm({ session }: { session: IdentitySession }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const character = name.trim();
    if (!character) {
      return;
    }
    setBusy(true);
    setError(undefined);
    const ack = await gateway.cmd({
      identityId: session.identityId,
      action: "pm.open",
      d: { character },
    });
    setBusy(false);
    if (!ack.ok || !ack.conversation) {
      setError(ack.error ?? "Could not open");
      return;
    }
    // The creation event also fans out, but only when the row is new — a
    // reopened conversation arrives only in this ack.
    useSessionsStore
      .getState()
      .applyConversation(session.identityId, ack.conversation);
    setName("");
    void navigate(
      dmPath(session.character, ack.conversation.partnerCharacter ?? ""),
    );
  }

  return (
    <>
      <form
        className={styles.miniForm}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <input
          className={styles.miniInput}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          placeholder="Message a character…"
          aria-label="Message a character"
        />
        <button className={styles.miniButton} type="submit" disabled={busy}>
          Open
        </button>
      </form>
      {error && (
        <p className={styles.miniError} role="alert">
          {error}
        </p>
      )}
    </>
  );
}
