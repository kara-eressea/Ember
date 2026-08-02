// ChannelHeader / DmHeader (COMPONENTS.md §5) — one compact toolbar row.
//
// Identity (glyph · name · topic) on the left, then icon-chip actions, the
// inline search field and the view toggles on the right. The row runs on the
// composer toolbar's own IconBtn + divider language (chat.module.css
// .iconBtn/.tbDivider) so the top and bottom of a conversation read as the
// same instrument.
//
// F-Chat channels carry one CDS description — that fills the topic slot; the
// separate editable TOPIC row has no wire counterpart and is omitted. The TPN
// typing state rests on the message bar (#336), rendered by the composer's
// typingLine.

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useNavigate } from "react-router";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { gateway } from "../../gateway/socket.js";
import { useIsNarrow } from "../../lib/dm-sidebar.js";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import { clockTitle, localClock } from "../../lib/local-time.js";
import { presenceDot } from "../../lib/presence.js";
import { identityPath } from "../../lib/routes.js";
import { useMinuteClock } from "../../lib/useMinuteClock.js";
import { decodeWireEntities } from "../../lib/wire-text.js";
import { useProfileStore } from "../../stores/profile.js";
import {
  useSessionsStore,
  type ChannelView,
  type DmView,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { patchPrefs } from "../prefs/patch.js";
import { MemberContextMenu } from "./MemberContextMenu.js";
import { RoomSettingsWindow } from "./RoomSettingsWindow.js";
import {
  BanGlyph,
  BellGlyph,
  BellOffGlyph,
  ClockGlyph,
  CloseGlyph,
  GearGlyph,
  MembersGlyph,
  MoreGlyph,
  PanelRightGlyph,
  PinGlyph,
  SearchGlyph,
} from "../icons/Glyphs.js";
import { InboxChip } from "./NotificationInbox.js";
import { RichText } from "./RichText.js";
import { SearchPanel } from "./SearchPanel.js";
import { useLogSearch } from "./log-search.js";
import { roleFor } from "./member-roles.js";
import styles from "./chat.module.css";

/** Toolbar chip: the composer's IconBtn, with the toggled state spelled out. */
function chipClass(on = false, danger = false): string {
  return [
    styles.iconBtn,
    on ? styles.iconBtnOn : "",
    on && danger ? styles.iconBtnDanger : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The topic slot — a channel's CDS description or a DM partner's status, set
 * inline beside the name and clipped to the row. The inline copy is inert:
 * BBCode topics carry links, `[user]` chips and eicons that are unusable at
 * one truncated line, so clicking the slot opens the same content live in a
 * popover (this replaces the old second row's Show more / Show less).
 */
function HeaderTopic({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // On the shared Escape stack as an overlay (#442), so an armed ambient
  // action — MessageLog's "mark caught up" — cannot steal the first press.
  useEscapeToClose(() => {
    setOpen(false);
  }, open);

  function activate(event: ReactKeyboardEvent) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen((value) => !value);
    }
  }

  return (
    <span className={styles.topicSlot}>
      {/* A span, not a <button>: RichText renders its own buttons (link
          chips, #channel, [user]) and nesting those is invalid HTML — the
          SearchPanel hit rows solve it the same way. */}
      <span
        role="button"
        tabIndex={0}
        className={styles.topic}
        aria-label={`${label} — show in full`}
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
        onKeyDown={activate}
      >
        <span className={styles.topicInline} inert>
          {children}
        </span>
      </span>
      {open && (
        <>
          <div
            className={styles.topicOverlay}
            onClick={() => {
              setOpen(false);
            }}
          />
          <div className={styles.topicPopover} role="dialog" aria-label={label}>
            {children}
          </div>
        </>
      )}
    </span>
  );
}

/**
 * The inline search field (COMPONENTS.md §5), wearing the sidebar filter's
 * pill so the app has one search shape. One input for one search: the field
 * owns the query, the panel below it is the result list. Focusing the field
 * opens the panel; the header is keyed per conversation, so leaving one
 * closes its search.
 */
function HeaderSearch({
  identityId,
  convId,
}: {
  identityId: string;
  convId: string;
}) {
  const open = useUiStore((s) => s.searchOpen);
  const session = useSessionsStore((s) => s.sessions[identityId]);
  const [query, setQuery] = useState("");
  const search = useLogSearch(identityId, convId);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      useUiStore.getState().setSearchOpen(false);
    },
    [],
  );

  return (
    <div className={styles.searchAnchor}>
      <form
        className={styles.searchField}
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          search.submit(query);
        }}
        // Collapsed to a magnifier on narrow windows the input has no width
        // of its own, so the pill has to hand focus over.
        onClick={() => {
          inputRef.current?.focus();
        }}
      >
        <SearchGlyph />
        <input
          ref={inputRef}
          className={styles.searchFieldInput}
          value={query}
          placeholder="Search log"
          aria-label="Search log"
          title={
            'Search this conversation — filters: from:"Name", before:/after:YYYY-MM-DD'
          }
          onFocus={() => {
            useUiStore.getState().setSearchOpen(true);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </form>
      {open && session !== undefined && (
        <SearchPanel
          session={session}
          convId={convId}
          search={search}
          onClose={() => {
            useUiStore.getState().setSearchOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * DM ignore toggle (M3). Ignoring is server-stored (IGN) and render-side
 * here: history keeps the messages, the log hides them. State follows the
 * `ignore.updated` fan-out, so no optimistic flip is needed.
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
      type="button"
      className={chipClass(ignored, true)}
      onClick={() => {
        void toggle();
      }}
      disabled={busy}
      aria-pressed={ignored}
      aria-label={ignored ? "Unignore" : "Ignore"}
      title={
        ignored
          ? "Unignore — show their messages again"
          : "Ignore — hide their messages (history is kept)"
      }
    >
      <BanGlyph />
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
      type="button"
      className={chipClass(muted)}
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
      aria-pressed={muted}
      aria-label={muted ? "Unmute conversation" : "Mute conversation"}
      title={
        muted
          ? "Unmute — sounds and notifications again"
          : "Mute — no sounds or notifications (badges still count)"
      }
    >
      {muted ? <BellOffGlyph /> : <BellGlyph />}
    </button>
  );
}

const EMPTY_MUTES = PREFS_DEFAULTS.mutedConvIds;

/**
 * COMPONENTS.md §5 pin chip: pinned channels are what an explicit reconnect
 * rejoins (decisions.md §9), pinned DMs surface under the sidebar's Pinned
 * section.
 */
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
      type="button"
      className={chipClass(pinned)}
      onClick={() => {
        void toggle();
      }}
      disabled={busy}
      aria-pressed={pinned}
      aria-label={pinned ? "Unpin" : "Pin"}
      title={pinned ? "Unpin — stop auto-rejoining" : "Pin — rejoin on connect"}
    >
      <PinGlyph />
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
        type="button"
        className={chipClass()}
        onClick={() => {
          setOpen(true);
        }}
        aria-label="Room settings"
        title="Room settings — invites, visibility, bans"
      >
        <GearGlyph />
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
      Campaign
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
  const toggleMembers = useUiStore((s) => s.toggleMembers);
  const membersOpen = useUiStore((s) => s.membersOpen);
  const ownCharacter = useSessionsStore(
    (s) => s.sessions[identityId]?.character ?? "",
  );
  const chatop = useSessionsStore(
    (s) => s.sessions[identityId]?.chatop ?? false,
  );
  const description = channel.description.trim();
  // Room management is an op+ affair (the commands are chanop-restricted
  // wire-side; the UI simply doesn't offer them to others). Chatops manage
  // any channel; the private-room actions (invite, open/close) only render
  // for ADH rooms.
  const canManageRoom =
    roleFor(ownCharacter, channel.oplist) !== null || chatop;

  // Room titles are wire text the server entity-escapes (#350); decode for the
  // plain-text header + chip tooltip. The description goes through RichText,
  // which decodes on its own path — so it is left untouched here.
  const title = decodeWireEntities(channel.title);
  return (
    <header className={styles.header}>
      <div className={styles.headerIdentity}>
        <span className={styles.headerGlyph} aria-hidden>
          #
        </span>
        <h1 className={styles.headerTitle}>{title}</h1>
        {description !== "" && (
          <>
            <span className={styles.headerHairline} aria-hidden />
            <HeaderTopic label={`#${title} description`}>
              <RichText bbcode={description} />
            </HeaderTopic>
          </>
        )}
      </div>
      <CampaignChip identityId={identityId} channelKey={channel.key} />
      <div className={styles.headerCluster}>
        <PinChip
          identityId={identityId}
          convId={channel.convId}
          pinned={channel.pinned}
        />
        <MuteChip identityId={identityId} convId={channel.convId} />
        {canManageRoom && (
          <RoomChip
            identityId={identityId}
            channelKey={channel.key}
            convId={channel.convId}
            title={title}
            isPrivateRoom={channel.key.startsWith("ADH-")}
            mode={channel.mode}
            description={channel.description}
          />
        )}
      </div>
      <span className={styles.tbDivider} aria-hidden />
      <button
        type="button"
        className={chipClass(membersOpen)}
        onClick={toggleMembers}
        aria-pressed={membersOpen}
        aria-label="Toggle member list"
        title="Toggle member list"
      >
        <MembersGlyph />
        <span className={styles.headerCount}>{channel.members.length}</span>
      </button>
      {/* The notification inbox (#466) is per identity, not per conversation
          — it rides the right-hand cluster beside search because that is the
          one row always on screen while a conversation is open. */}
      <InboxChip identityId={identityId} />
      {/* Search sits last, flush to the app's right edge — the toolbar now
          spans the member column, so this is where a search box belongs. */}
      <HeaderSearch identityId={identityId} convId={channel.convId} />
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
  // member-list button. On the wide layout it flips the persisted grid-column
  // pref; on narrow windows it opens/closes the overlay drawer.
  const narrow = useIsNarrow();
  const dmSidebarOpen = useUiStore((s) => s.dmSidebarOpen);
  const dmDrawerOpen = useUiStore((s) => s.dmDrawerOpen);
  const sidebarOn = narrow ? dmDrawerOpen : dmSidebarOpen;
  const [closing, setClosing] = useState(false);
  // The partner's identity menu (#167) — the same menu a member-list row
  // opens, anchored under the ⋮ button.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number }>();
  // Their local clock rides the cached profile (user-set zone first, else the
  // profile's own UTC offset). Read-only: the DM sidebar owns the fetch, so a
  // collapsed sidebar simply means no clock rather than a background request
  // — and a profile view the user never asked for.
  const response = useProfileStore(
    (s) => s.profiles[dm.partner.toLowerCase()]?.response,
  );
  const clock = localClock(
    useMinuteClock(),
    response?.timezone,
    response?.profile.timezone,
  );

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

  const status = dm.online ? dm.status : "offline";
  return (
    <header className={styles.header}>
      <div className={styles.headerIdentity}>
        <span
          className={styles.headerDot}
          aria-hidden
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
        {(dm.statusmsg !== "" || dm.status !== "") && (
          <>
            <span className={styles.headerHairline} aria-hidden />
            <HeaderTopic label={`${dm.partner} — status`}>
              <span className={styles.topicStatus}>{status}</span>
              {dm.online && dm.statusmsg ? (
                <>
                  {" — "}
                  <RichText bbcode={dm.statusmsg} />
                </>
              ) : null}
            </HeaderTopic>
          </>
        )}
        {/* Their local time (#439) sits outside the topic slot on purpose: it
            is a two-glance fact, and inside the slot it would be the first
            thing an overlong status truncated away. */}
        {clock && (
          <span
            className={styles.headerClock}
            title={clockTitle(clock, dm.partner)}
          >
            <ClockGlyph />
            {clock.time}
          </span>
        )}
      </div>
      {/* Typing status moved onto the message bar (#336) — see the composer's
          typingLine. Showing it here too would duplicate the same info. */}
      <div className={styles.headerCluster}>
        <PinChip
          identityId={identityId}
          convId={dm.convId}
          pinned={dm.pinned}
        />
        <MuteChip identityId={identityId} convId={dm.convId} />
        <IgnoreChip identityId={identityId} character={dm.partner} />
      </div>
      <span className={styles.tbDivider} aria-hidden />
      <button
        type="button"
        className={chipClass(sidebarOn)}
        title={sidebarOn ? "Hide the profile panel" : "Show the profile panel"}
        aria-label="Toggle profile panel"
        aria-pressed={sidebarOn}
        onClick={() => {
          if (narrow) {
            useUiStore.getState().toggleDmDrawer();
          } else {
            useUiStore.getState().toggleDmSidebar();
          }
        }}
      >
        <PanelRightGlyph />
      </button>
      <button
        type="button"
        className={chipClass()}
        title={`Actions for ${dm.partner}`}
        aria-label={`Actions for ${dm.partner}`}
        aria-haspopup="menu"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenuAt({ x: rect.left, y: rect.bottom + 4 });
        }}
      >
        <MoreGlyph />
      </button>
      <button
        type="button"
        className={chipClass()}
        title="Close this conversation — history is kept"
        aria-label={`Close conversation with ${dm.partner}`}
        disabled={closing}
        onClick={() => {
          void close();
        }}
      >
        <CloseGlyph />
      </button>
      <InboxChip identityId={identityId} />
      {/* Search sits last, flush to the app's right edge — the toolbar now
          spans the profile column, so this is where a search box belongs. */}
      <HeaderSearch identityId={identityId} convId={dm.convId} />
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
    </header>
  );
}
