// Notification inbox (#466) — the conversation toolbar's tray chip and the
// dropdown behind it.
//
// It is a LOG, not a to-do list: entries stay after they are read or acted
// on, and opening the panel marks everything seen at once (the Discord model
// the user chose). The badge counts unseen entries that are allowed to alert
// — a mention in a muted conversation is still logged, it just never badges
// (decisions.md §10, the same rule the favicon indicator follows).
//
// Paging direction is deliberate and inverted relative to the message log:
// newest at the TOP, older loaded as you scroll DOWN. A dropdown that grew
// upward from its anchor would push its own newest row off the top edge on
// every page.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { NotificationDto } from "@emberchat/protocol";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import { channelPath, dmPath, identityPath } from "../../lib/routes.js";
import { useMessagesStore } from "../../stores/messages.js";
import {
  UNSEEN_DISPLAY_CAP,
  useNotificationsStore,
} from "../../stores/notifications.js";
import {
  useSessionsStore,
  type IdentitySession,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { ago } from "../profile/time.js";
import { InboxGlyph } from "../icons/Glyphs.js";
import styles from "./chat.module.css";

/**
 * Where a website event is actually read and acted on — the site, as the
 * notice copy has always said. Notes have a real inbox; comment replies do
 * not travel with enough of a target on the wire (RTB carries no
 * `target_type`/`target_id` for us) to deep-link the thread, so that one
 * lands on the site and says so.
 */
const FLIST_NOTES_URL = "https://www.f-list.net/messages.php";
const FLIST_HOME_URL = "https://www.f-list.net/";

/** Text glyph per kind — the sidebar's own vocabulary (★ ⚑ ♥ rows). */
const KIND_GLYPH: Record<NotificationDto["kind"], string> = {
  mention: "@",
  friendrequest: "♥",
  note: "✉",
  comment: "❝",
};

/** The conversation a mention points at, for the row's "in #Room" label. */
function conversationLabel(
  session: IdentitySession | undefined,
  convId: string | undefined,
): string | undefined {
  if (session === undefined || convId === undefined) {
    return undefined;
  }
  const key = session.channelByConvId[convId];
  if (key !== undefined) {
    return `#${session.channels[key]?.title ?? key}`;
  }
  const partner = session.dms[convId]?.partner;
  return partner === undefined ? undefined : `@${partner}`;
}

/** One row's headline. The excerpt renders underneath when there is one. */
export function notificationLine(
  entry: NotificationDto,
  conversation: string | undefined,
): string {
  const who = entry.character === "" ? "Someone" : entry.character;
  switch (entry.kind) {
    case "mention":
      return conversation === undefined
        ? `${who} mentioned you`
        : `${who} mentioned you in ${conversation}`;
    case "friendrequest":
      return `${who} sent a friend request`;
    case "note":
      return `New note from ${who}`;
    case "comment":
      return `${who} replied to a comment thread you follow`;
  }
}

function InboxRow({
  entry,
  session,
  unseen,
  onActivate,
}: {
  entry: NotificationDto;
  session: IdentitySession | undefined;
  unseen: boolean;
  onActivate: (entry: NotificationDto) => void;
}) {
  const conversation = conversationLabel(session, entry.convId);
  const line = notificationLine(entry, conversation);
  return (
    <button
      type="button"
      className={`${styles.inboxRow} ${unseen ? (styles.inboxRowUnseen ?? "") : ""}`}
      onClick={() => {
        onActivate(entry);
      }}
    >
      <span className={styles.inboxRowGlyph} aria-hidden>
        {KIND_GLYPH[entry.kind]}
      </span>
      <span className={styles.inboxRowText}>
        <span className={styles.inboxRowLine}>{line}</span>
        {entry.excerpt !== "" && (
          <span className={styles.inboxRowExcerpt}>{entry.excerpt}</span>
        )}
      </span>
      <span className={styles.inboxRowTime}>
        {ago(Date.parse(entry.createdAt))}
      </span>
    </button>
  );
}

function InboxPanel({
  identityId,
  onClose,
}: {
  identityId: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const inbox = useNotificationsStore((s) => s.byIdentity[identityId]);
  const session = useSessionsStore((s) => s.sessions[identityId]);
  const [error, setError] = useState<string>();
  // The watermark AS OF THE OPEN: the open marks everything seen, so reading
  // the store's live copy would erase the "these are new" styling under the
  // user's eyes in the very frame the panel appears. Captured once at mount
  // — the panel is mounted only while open.
  const [watermark] = useState(
    () =>
      useNotificationsStore.getState().byIdentity[identityId]?.lastSeenId ?? 0,
  );

  // On the shared Escape stack as an overlay (#442) — one press closes this
  // and nothing else. No focus trap: this is a light popover, exactly the
  // ceremony SearchPanel has.
  useEscapeToClose(onClose);

  useEffect(() => {
    void useNotificationsStore
      .getState()
      .load(identityId)
      .then(() => useNotificationsStore.getState().markSeen(identityId))
      .catch(() => {
        setError("Couldn't load your notifications.");
      });
  }, [identityId]);

  function activate(entry: NotificationDto) {
    // Close first: the panel hangs over the top of the log, which is exactly
    // where a jumped-to message and its "Back to present" banner land.
    onClose();
    if (entry.kind === "mention") {
      if (entry.convId === undefined || entry.messageId === undefined) {
        return;
      }
      void useMessagesStore
        .getState()
        .jumpTo(identityId, entry.convId, entry.messageId)
        .catch(() => {
          useSessionsStore
            .getState()
            .applyNotice(identityId, "error", "Couldn't load that page");
        });
      if (session !== undefined && entry.convId !== undefined) {
        const key = session.channelByConvId[entry.convId];
        const partner = session.dms[entry.convId]?.partner;
        const path =
          key !== undefined
            ? channelPath(session.character, key)
            : partner !== undefined
              ? dmPath(session.character, partner)
              : undefined;
        if (path !== undefined) {
          void navigate(path);
        }
      }
      return;
    }
    if (entry.kind === "friendrequest") {
      // The requests surface is the sidebar's own: accept/deny live there,
      // and it is per identity, so land on the identity first.
      if (session !== undefined) {
        void navigate(identityPath(session.character));
      }
      useUiStore.getState().revealFriendRequests();
      return;
    }
    window.open(
      entry.kind === "note" ? FLIST_NOTES_URL : FLIST_HOME_URL,
      "_blank",
      "noopener,noreferrer",
    );
  }

  const items = inbox?.items ?? [];
  return (
    <div className={styles.inboxPanel} role="dialog" aria-label="Notifications">
      <div className={styles.inboxHead}>
        <span className={styles.inboxTitle}>Notifications</span>
        <span className={styles.inboxHint}>Newest first</span>
      </div>
      <div
        className={styles.inboxBody}
        onScroll={(event) => {
          // Older entries load DOWNWARD (see the file header). Ask when the
          // tail comes within a screenful.
          const el = event.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
            void useNotificationsStore.getState().loadOlder(identityId);
          }
        }}
      >
        {error !== undefined && (
          <div className={styles.inboxNote} role="alert">
            {error}
          </div>
        )}
        {items.map((entry) => (
          <InboxRow
            key={entry.id}
            entry={entry}
            session={session}
            unseen={entry.id > watermark}
            onActivate={activate}
          />
        ))}
        {items.length === 0 && error === undefined && (
          <div className={styles.inboxNote}>
            {inbox?.loaded === true
              ? "Nothing here yet. Mentions, friend requests, notes and comment replies land here."
              : "Loading…"}
          </div>
        )}
        {inbox?.loading === true && items.length > 0 && (
          <div className={styles.inboxNote}>Loading older…</div>
        )}
      </div>
    </div>
  );
}

/**
 * The toolbar chip. Same 30×30 IconBtn language as the pin and mute chips
 * beside it, with the unseen count riding the corner.
 */
export function InboxChip({ identityId }: { identityId: string }) {
  const [open, setOpen] = useState(false);
  const unseen = useNotificationsStore(
    (s) => s.byIdentity[identityId]?.unseen ?? 0,
  );
  const anchorRef = useRef<HTMLDivElement>(null);

  // Click-away without an overlay that swallows the click (the mini card's
  // approach): pressing another chip closes this AND performs that action.
  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && anchorRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  const label =
    unseen > 0 ? `Notifications — ${String(unseen)} unseen` : "Notifications";
  return (
    <div className={styles.inboxAnchor} ref={anchorRef}>
      <button
        type="button"
        className={`${styles.iconBtn} ${open ? (styles.iconBtnOn ?? "") : ""}`}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Notifications — mentions, friend requests, notes"
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <InboxGlyph />
        {unseen > 0 && (
          <span className={styles.inboxBadge} aria-hidden>
            {unseen > UNSEEN_DISPLAY_CAP
              ? `${String(UNSEEN_DISPLAY_CAP)}+`
              : unseen}
          </span>
        )}
      </button>
      {open && (
        <InboxPanel
          identityId={identityId}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
