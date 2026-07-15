// ChannelHeader (COMPONENTS.md §5). F-Chat channels carry one CDS
// description — it fills the collapsed description row; the separate
// editable TOPIC row has no wire counterpart and is omitted. For DMs the
// header shows the partner with presence and the TPN typing state.

import { useState } from "react";
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
import { RichText } from "./RichText.js";
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

export function ChannelHeader({
  identityId,
  channel,
}: {
  identityId: string;
  channel: ChannelView;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggleMembers = useUiStore((s) => s.toggleMembers);
  const description = channel.description.trim();
  const clampable = description.length > DESCRIPTION_CLAMP;

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
        <span className={styles.headerSpacer} />
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
