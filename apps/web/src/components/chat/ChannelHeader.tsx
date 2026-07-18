// ChannelHeader (COMPONENTS.md §5). F-Chat channels carry one CDS
// description — it fills the collapsed description row; the separate
// editable TOPIC row has no wire counterpart and is omitted. For DMs the
// header shows the partner with presence and the TPN typing state.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { gateway } from "../../gateway/socket.js";
import { presenceDot } from "../../lib/presence.js";
import {
  useSessionsStore,
  type ChannelView,
  type DmView,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { patchPrefs } from "../prefs/patch.js";
import { adViewFor, setChannelAdView, type AdView } from "./ads.js";
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

/** The Chat/Ads/Both view selector (M10, CD spec §4) — shown only when the
 * room's server mode is "both". Chat hides ad rows, Ads hides chat rows;
 * filtered rows stay in history and ads never count toward unread. The
 * choice persists per channel (pruned when it restates the default). */
function ShowSelector({
  identityId,
  channelKey,
}: {
  identityId: string;
  channelKey: string;
}) {
  const prefs = useSessionsStore(
    (s) => s.sessions[identityId]?.prefs ?? PREFS_DEFAULTS,
  );
  const view = adViewFor(prefs, channelKey);
  const options: { value: AdView; label: string }[] = [
    { value: "chat", label: "Chat" },
    { value: "ads", label: "Ads" },
    { value: "both", label: "Both" },
  ];

  return (
    <span className={styles.showSelector}>
      <span className={styles.showLabel} aria-hidden>
        SHOW
      </span>
      <span
        className={styles.showSeg}
        role="radiogroup"
        aria-label="Show chat, ads, or both"
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={view === option.value}
            className={`${styles.showSegButton} ${view === option.value ? (styles.showSegOn ?? "") : ""}`}
            title={
              option.value === "chat"
                ? "Hide roleplay ads in this channel"
                : option.value === "ads"
                  ? "Show only roleplay ads (the box composes ads here)"
                  : "Show chat and ads together"
            }
            onClick={() => {
              void patchPrefs(
                identityId,
                setChannelAdView(prefs, channelKey, option.value),
              );
            }}
          >
            {option.label}
          </button>
        ))}
      </span>
    </span>
  );
}

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
 * Room management for op+ viewers: invites and public/private (private
 * rooms only — RST/CIU have no meaning on official channels), plus the op
 * tooling that works everywhere: room mode (RMO), description (CDS), and
 * the banlist (CBL — the answer lands in the log as a SystemLine). F-Chat
 * has no command reporting the open/closed state, so both of those actions
 * are always offered — the server's SYS response says what happened.
 */
function RoomChip({
  identityId,
  channelKey,
  isPrivateRoom,
  mode,
  description,
}: {
  identityId: string;
  channelKey: string;
  isPrivateRoom: boolean;
  mode: string;
  description: string;
}) {
  const [open, setOpen] = useState(false);
  const [character, setCharacter] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string>();
  const [draft, setDraft] = useState<string>();
  const containerRef = useRef<HTMLSpanElement>(null);

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

  async function invite(event: FormEvent) {
    event.preventDefault();
    const target = character.trim();
    if (!target || busy) {
      return;
    }
    setBusy(true);
    setInfo(undefined);
    try {
      const ack = await gateway.cmd({
        identityId,
        action: "channel.invite",
        d: { key: channelKey, character: target },
      });
      if (ack.ok) {
        setCharacter("");
        setInfo(`Invite sent to ${target}`);
      } else {
        setInfo(ack.error ?? "Could not invite");
      }
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: "public" | "private") {
    if (busy) {
      return;
    }
    setBusy(true);
    setInfo(undefined);
    try {
      const ack = await gateway.cmd({
        identityId,
        action: "channel.status",
        d: { key: channelKey, status },
      });
      setInfo(
        ack.ok
          ? status === "public"
            ? "Room is now open and listed"
            : "Room is now invite-only"
          : (ack.error ?? "Could not change the room status"),
      );
    } finally {
      setBusy(false);
    }
  }

  /** Shared shape for the op commands whose feedback is just the result. */
  async function run(
    label: string,
    command: Parameters<typeof gateway.cmd>[0],
  ) {
    if (busy) {
      return;
    }
    setBusy(true);
    setInfo(undefined);
    try {
      const ack = await gateway.cmd(command);
      setInfo(ack.ok ? label : (ack.error ?? "Command failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={styles.roomChipWrap} ref={containerRef}>
      <button
        className={styles.pinChip}
        onClick={() => {
          setOpen(!open);
          setInfo(undefined);
        }}
        title="Room settings — invites and visibility"
      >
        ⚙ room
      </button>
      {open && (
        <div
          className={styles.roomMenu}
          role="dialog"
          aria-label="Room settings"
        >
          {isPrivateRoom && (
            <>
              <form
                className={styles.roomMenuForm}
                onSubmit={(event) => {
                  void invite(event);
                }}
              >
                <input
                  className={styles.miniInput}
                  value={character}
                  onChange={(e) => {
                    setCharacter(e.target.value);
                  }}
                  placeholder="Invite a character…"
                  aria-label="Invite a character"
                />
                <button
                  className={styles.miniButton}
                  type="submit"
                  disabled={busy}
                >
                  Invite
                </button>
              </form>
              <div className={styles.roomMenuActions}>
                <button
                  className={styles.miniButton}
                  disabled={busy}
                  onClick={() => {
                    void setStatus("public");
                  }}
                >
                  Make open
                </button>
                <button
                  className={styles.miniButton}
                  disabled={busy}
                  onClick={() => {
                    void setStatus("private");
                  }}
                >
                  Make invite-only
                </button>
              </div>
            </>
          )}
          {/* Room mode (RMO): which message kinds the room accepts. The
              active segment reflects the live mode via channel.info. */}
          <div
            className={styles.roomMenuActions}
            role="radiogroup"
            aria-label="Room mode"
          >
            {(["chat", "ads", "both"] as const).map((option) => (
              <button
                key={option}
                className={`${styles.miniButton} ${mode === option ? (styles.miniButtonActive ?? "") : ""}`}
                role="radio"
                aria-checked={mode === option}
                disabled={busy || mode === option}
                onClick={() => {
                  void run(`Room mode set to ${option}`, {
                    identityId,
                    action: "channel.mode",
                    d: { key: channelKey, mode: option },
                  });
                }}
              >
                {option}
              </button>
            ))}
          </div>
          <form
            className={styles.roomMenuForm}
            onSubmit={(event) => {
              event.preventDefault();
              void run("Description updated", {
                identityId,
                action: "channel.describe",
                d: { key: channelKey, description: draft ?? description },
              });
            }}
          >
            <textarea
              className={styles.roomMenuTextarea}
              value={draft ?? description}
              onChange={(e) => {
                setDraft(e.target.value);
              }}
              rows={3}
              aria-label="Channel description"
            />
            <button className={styles.miniButton} type="submit" disabled={busy}>
              Save
            </button>
          </form>
          <div className={styles.roomMenuActions}>
            <button
              className={styles.miniButton}
              disabled={busy}
              onClick={() => {
                setOpen(false);
                void run("", {
                  identityId,
                  action: "channel.banlist",
                  d: { key: channelKey },
                });
              }}
            >
              View banlist
            </button>
          </div>
          {info && (
            <p className={styles.roomMenuInfo} role="status">
              {info}
            </p>
          )}
        </div>
      )}
    </span>
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
        <PinChip
          identityId={identityId}
          convId={channel.convId}
          pinned={channel.pinned}
        />
        <MuteChip identityId={identityId} convId={channel.convId} />
        {channel.mode === "both" && (
          <ShowSelector identityId={identityId} channelKey={channel.key} />
        )}
        {canManageRoom && (
          <RoomChip
            identityId={identityId}
            channelKey={channel.key}
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
          ⌕
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
        {dm.typing === "typing" && (
          <span className={styles.typing}>is typing…</span>
        )}
        <span className={styles.headerSpacer} />
        <button
          className={styles.headerButton}
          title="Search this conversation's log"
          aria-label="Search log"
          onClick={() => {
            useUiStore.getState().setSearchOpen(true);
          }}
        >
          ⌕
        </button>
      </div>
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
