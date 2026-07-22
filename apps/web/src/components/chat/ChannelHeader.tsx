// ChannelHeader (COMPONENTS.md §5). F-Chat channels carry one CDS
// description — it fills the collapsed description row; the separate
// editable TOPIC row has no wire counterpart and is omitted. For DMs the
// header shows the partner with presence; the TPN typing state now rests on
// the message bar (#336), rendered by the composer's typingLine.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { gateway } from "../../gateway/socket.js";
import { useIsNarrow } from "../../lib/dm-sidebar.js";
import { presenceDot } from "../../lib/presence.js";
import { identityPath } from "../../lib/routes.js";
import {
  useSessionsStore,
  type ChannelView,
  type DmView,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { patchPrefs } from "../prefs/patch.js";
import { MemberContextMenu } from "./MemberContextMenu.js";
import { RoomSettingsWindow } from "./RoomSettingsWindow.js";
import { SearchGlyph } from "../icons/Glyphs.js";
import { RichText } from "./RichText.js";
import { roleFor } from "./member-roles.js";
import styles from "./chat.module.css";

const DESCRIPTION_CLAMP = 140;

/**
 * COMPONENTS.md §5 "⚲ pinned" chip, made interactive: pinned channels are
 * what an explicit reconnect rejoins (decisions.md §9), pinned DMs surface
 * under the sidebar's Pinned section.
 */
/**
 * DM-header ignore toggle (M3). Ignoring is server-stored (IGN) and
 * render-side here: history keeps the messages, the log hides them. State
 * follows the `ignore.updated` fan-out, so no optimistic flip is needed.
 */
function IgnoreChip({
  identityId,
  character,
}: {
  identityId: string;
  character: string;
}) {
  const [busy, setBusy] = useState(false);
  const ignored = useSessionsStore((s) =>
    (s.sessions[identityId]?.ignores ?? []).some(
      (name) => name.toLowerCase() === character.toLowerCase(),
    ),
  );

  async function toggle() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const ack = await gateway.cmd({
        identityId,
        action: ignored ? "ignore.remove" : "ignore.add",
        d: { character },
      });
      if (!ack.ok) {
        useSessionsStore
          .getState()
          .applyNotice(
            identityId,
            "error",
            ack.error ?? "Could not update the ignore list",
          );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className={`${styles.pinChip} ${ignored ? (styles.ignoreChipActive ?? "") : ""}`}
      onClick={() => {
        void toggle();
      }}
      disabled={busy}
      title={
        ignored
          ? "Unignore — show their messages again"
          : "Ignore — hide their messages (history is kept)"
      }
    >
      ⊘ {ignored ? "ignored" : "ignore"}
    </button>
  );
}

/**
 * Per-conversation mute (M5 step 8, decisions.md §10): silences the alert
 * layer — chime, title flash, desktop notifications — while badges and
 * mention tint keep accruing. Stored in the synced prefs document; the
 * Notifications pane lists and clears these.
 */
function MuteChip({
  identityId,
  convId,
}: {
  identityId: string;
  convId: string;
}) {
  const mutedConvIds = useSessionsStore(
    (s) => s.sessions[identityId]?.prefs.mutedConvIds ?? EMPTY_MUTES,
  );
  const muted = mutedConvIds.includes(convId);

  return (
    <button
      className={`${styles.pinChip} ${muted ? (styles.ignoreChipActive ?? "") : ""}`}
      onClick={() => {
        // The prefs schema caps the list at 500; without this check the
        // patch is rejected server-side and the chip silently flips back
        // (M5 audit backlog) — say why instead.
        if (!muted && mutedConvIds.length >= 500) {
          useSessionsStore
            .getState()
            .applyNotice(
              identityId,
              "error",
              "Mute limit reached (500 conversations) — unmute some in Preferences → Notifications first.",
            );
          return;
        }
        void patchPrefs(identityId, {
          mutedConvIds: muted
            ? mutedConvIds.filter((entry) => entry !== convId)
            : [...mutedConvIds, convId],
        });
      }}
      title={
        muted
          ? "Unmute — sounds and notifications again"
          : "Mute — no sounds or notifications (badges still count)"
      }
    >
      {muted ? "🔕 muted" : "🔔 mute"}
    </button>
  );
}

const EMPTY_MUTES = PREFS_DEFAULTS.mutedConvIds;

function PinChip({
  identityId,
  convId,
  pinned,
}: {
  identityId: string;
  convId: string;
  pinned: boolean;
}) {
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const ack = await gateway.cmd({
        identityId,
        action: "conv.pin",
        d: { convId, pinned: !pinned },
      });
      // The update also fans out as conversation.updated; applying the ack
      // just makes this tab instant.
      if (ack.ok && ack.conversation) {
        useSessionsStore
          .getState()
          .applyConversation(identityId, ack.conversation);
      } else if (!ack.ok) {
        useSessionsStore
          .getState()
          .applyNotice(identityId, "error", ack.error ?? "Could not pin");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className={`${styles.pinChip} ${pinned ? (styles.pinChipActive ?? "") : ""}`}
      onClick={() => {
        void toggle();
      }}
      disabled={busy}
      title={pinned ? "Unpin — stop auto-rejoining" : "Pin — rejoin on connect"}
    >
      ⚲ {pinned ? "pinned" : "pin"}
    </button>
  );
}

/**
 * Room management for op+ viewers. The chip opens the room-settings window
 * (RoomSettingsWindow): invites and public/private (private rooms only —
 * RST/CIU have no meaning on official channels), plus the op tooling that
 * works everywhere: room mode (RMO), description (CDS), and the banlist
 * (CBL). F-Chat reports no open/closed state, so the window offers both
 * visibility actions and echoes the server's SYS response.
 */
function RoomChip({
  identityId,
  channelKey,
  convId,
  title,
  isPrivateRoom,
  mode,
  description,
}: {
  identityId: string;
  channelKey: string;
  convId: string;
  title: string;
  isPrivateRoom: boolean;
  mode: string;
  description: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className={styles.pinChip}
        onClick={() => {
          setOpen(true);
        }}
        title="Room settings — invites, visibility, bans"
      >
        ⚙ room
      </button>
      {open && (
        <RoomSettingsWindow
          identityId={identityId}
          channelKey={channelKey}
          convId={convId}
          title={title}
          isPrivateRoom={isPrivateRoom}
          mode={mode}
          description={description}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

/** A quiet pill on channels the running campaign posts into (M11 CM-F).
 * Subtle, never a banner; clicking opens the campaign status surface. */
function CampaignChip({
  identityId,
  channelKey,
}: {
  identityId: string;
  channelKey: string;
}) {
  const campaign = useSessionsStore(
    (s) => s.sessions[identityId]?.campaign ?? null,
  );
  // The clock ticks so the chip disappears when the hour runs out even
  // if the user never leaves the channel (audit HIGH: natural expiry
  // never sets stoppedAt).
  const [now, setNow] = useState(() => Date.now());
  const running =
    campaign !== null &&
    campaign.stoppedAt === undefined &&
    now < campaign.expiresAt;
  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, [running]);
  const posting =
    running &&
    campaign.channels.some(
      (c) =>
        c.key.toLowerCase() === channelKey.toLowerCase() &&
        c.state !== "removed",
    );
  if (!posting) {
    return null;
  }
  return (
    <button
      type="button"
      className={styles.campaignChip}
      title="A campaign posts ads here on its own — open its status"
      onClick={() => {
        useUiStore.getState().setCampaignOpen(true);
      }}
    >
      <span className={styles.campaignChipDot} aria-hidden />
      Campaign · posting here
    </button>
  );
}

export function ChannelHeader({
  identityId,
  channel,
}: {
  identityId: string;
  channel: ChannelView;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggleMembers = useUiStore((s) => s.toggleMembers);
  const ownCharacter = useSessionsStore(
    (s) => s.sessions[identityId]?.character ?? "",
  );
  const chatop = useSessionsStore(
    (s) => s.sessions[identityId]?.chatop ?? false,
  );
  const description = channel.description.trim();
  const clampable = description.length > DESCRIPTION_CLAMP;
  // Room management is an op+ affair (the commands are chanop-restricted
  // wire-side; the UI simply doesn't offer them to others). Chatops manage
  // any channel; the private-room actions (invite, open/close) only render
  // for ADH rooms.
  const canManageRoom =
    roleFor(ownCharacter, channel.oplist) !== null || chatop;

  return (
    <header className={styles.header}>
      <div className={styles.headerRow}>
        <span className={styles.headerGlyph}>#</span>
        <h1 className={styles.headerTitle}>{channel.title}</h1>
        <CampaignChip identityId={identityId} channelKey={channel.key} />
        {canManageRoom && (
          <RoomChip
            identityId={identityId}
            channelKey={channel.key}
            convId={channel.convId}
            title={channel.title}
            isPrivateRoom={channel.key.startsWith("ADH-")}
            mode={channel.mode}
            description={channel.description}
          />
        )}
        <span className={styles.headerSpacer} />
        <button
          className={styles.headerButton}
          title="Search this channel's log"
          aria-label="Search log"
          onClick={() => {
            useUiStore.getState().setSearchOpen(true);
          }}
        >
          <SearchGlyph />
        </button>
        <button
          className={styles.headerButton}
          onClick={toggleMembers}
          title="Toggle member list"
        >
          ☰ {channel.members.length}
        </button>
      </div>
      {description && (
        <div
          className={`${styles.description} ${expanded ? "" : (styles.descriptionClamped ?? "")}`}
        >
          <RichText bbcode={description} />{" "}
          {clampable && expanded && (
            <button
              className={styles.showMore}
              onClick={() => {
                setExpanded(false);
              }}
            >
              Show less
            </button>
          )}
        </div>
      )}
      {clampable && !expanded && (
        <button
          className={styles.showMore}
          onClick={() => {
            setExpanded(true);
          }}
        >
          Show more
        </button>
      )}
    </header>
  );
}

export function DmHeader({
  identityId,
  dm,
}: {
  identityId: string;
  dm: DmView;
}) {
  const dot = presenceDot(dm.online, dm.status);
  const navigate = useNavigate();
  const ownCharacter = useSessionsStore(
    (s) => s.sessions[identityId]?.character ?? "",
  );
  // DM profile-sidebar toggle (#170): same header slot as the channel's
  // "☰ members" button. On the wide layout it flips the persisted grid-column
  // pref; on narrow windows it opens/closes the overlay drawer.
  const narrow = useIsNarrow();
  const dmSidebarOpen = useUiStore((s) => s.dmSidebarOpen);
  const dmDrawerOpen = useUiStore((s) => s.dmDrawerOpen);
  const sidebarOn = narrow ? dmDrawerOpen : dmSidebarOpen;
  const [closing, setClosing] = useState(false);
  // The partner's identity menu (#167) — the same menu a member-list row
  // opens, anchored under the ⋮ button.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number }>();

  // Close the DM window (gateway pm.close): history is kept and the
  // conversation reopens on the next pm.open or inbound message; only the
  // sidebar row and this window go away. Navigate first — the fan-out
  // removes the row from the store, which would strand this route.
  async function close() {
    if (closing) {
      return;
    }
    setClosing(true);
    try {
      const ack = await gateway.cmd({
        identityId,
        action: "pm.close",
        d: { convId: dm.convId },
      });
      if (!ack.ok) {
        useSessionsStore
          .getState()
          .applyNotice(
            identityId,
            "error",
            ack.error ?? "Could not close the conversation",
          );
        return;
      }
      void navigate(identityPath(ownCharacter));
      if (ack.conversation) {
        useSessionsStore
          .getState()
          .applyConversation(identityId, ack.conversation);
      }
    } finally {
      setClosing(false);
    }
  }

  return (
    <header className={styles.header}>
      <div className={styles.headerRow}>
        <span
          className={styles.headerDot}
          style={{
            background:
              dot === "ok"
                ? "var(--eb-ok)"
                : dot === "warn"
                  ? "var(--eb-warn)"
                  : "var(--eb-faint)",
          }}
        />
        <h1 className={styles.headerTitle}>{dm.partner}</h1>
        <PinChip
          identityId={identityId}
          convId={dm.convId}
          pinned={dm.pinned}
        />
        <MuteChip identityId={identityId} convId={dm.convId} />
        <IgnoreChip identityId={identityId} character={dm.partner} />
        {/* Typing status moved onto the message bar (#336) — see the composer's
            typingLine. Showing it here too would duplicate the same info. */}
        <span className={styles.headerSpacer} />
        <button
          className={styles.headerButton}
          title="Search this conversation's log"
          aria-label="Search log"
          onClick={() => {
            useUiStore.getState().setSearchOpen(true);
          }}
        >
          <SearchGlyph />
        </button>
        <button
          className={styles.headerButton}
          title={
            sidebarOn ? "Hide the profile panel" : "Show the profile panel"
          }
          aria-label="Toggle profile panel"
          aria-pressed={sidebarOn}
          style={
            sidebarOn
              ? {
                  color: "var(--eb-accent)",
                  background: "var(--eb-accent-soft)",
                }
              : undefined
          }
          onClick={() => {
            if (narrow) {
              useUiStore.getState().toggleDmDrawer();
            } else {
              useUiStore.getState().toggleDmSidebar();
            }
          }}
        >
          ◨
        </button>
        <button
          className={styles.headerButton}
          title={`Actions for ${dm.partner}`}
          aria-label={`Actions for ${dm.partner}`}
          aria-haspopup="menu"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenuAt({ x: rect.left, y: rect.bottom + 4 });
          }}
        >
          ⋮
        </button>
        <button
          className={styles.headerButton}
          title="Close this conversation — history is kept"
          aria-label={`Close conversation with ${dm.partner}`}
          disabled={closing}
          onClick={() => {
            void close();
          }}
        >
          ✕
        </button>
      </div>
      {menuAt && (
        <MemberContextMenu
          identityId={identityId}
          ownCharacter={ownCharacter}
          channelTitle={`Conversation with ${dm.partner}`}
          member={{
            character: dm.partner,
            gender: "",
            status: dm.status,
            statusmsg: dm.statusmsg,
          }}
          position={menuAt}
          onClose={() => {
            setMenuAt(undefined);
          }}
        />
      )}
      {(dm.statusmsg || dm.status) && (
        <div className={styles.description}>
          {dm.online ? (
            <>
              {dm.status}
              {dm.statusmsg ? (
                <>
                  {" — "}
                  <RichText bbcode={dm.statusmsg} />
                </>
              ) : null}
            </>
          ) : (
            "offline"
          )}
        </div>
      )}
    </header>
  );
}
