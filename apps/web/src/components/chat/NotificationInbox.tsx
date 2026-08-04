// Notification inbox (#467) — the conversation toolbar's tray chip and the
// dropdown behind it.
//
// It is a LOG, not a to-do list: entries stay after they are read or acted
// on, and opening the panel marks everything seen at once (the Discord model
// the user chose). The badge counts unseen entries that are allowed to alert
// — a mention in a muted conversation is still logged, it just never badges
// (decisions.md §10, the same rule the favicon indicator follows).
//
// Two things a row can do, both trailing the text (#505/#506):
//
//   • A friend request is answerable here — ✓ / ✕ — through the same social
//     endpoint the sidebar's request rows call. Pending-vs-resolved is
//     DERIVED from the live request list rather than stored on the row: the
//     lists are already kept current on every device (snapshot seed +
//     `social.updated` fan-out, #199/#364), so an accept on a phone, or on
//     f-list.net itself, resolves this entry with no verdict to write, no
//     column to migrate and no row mutated in a log that promises not to
//     mutate. See friendRequestState for the exact ladder.
//   • Every row can be deleted. That removes the LOG LINE and nothing else —
//     a deleted friend-request entry leaves the request itself pending on
//     its other surfaces.
//
// Paging direction is deliberate and inverted relative to the message log:
// newest at the TOP, older loaded as you scroll DOWN. A dropdown that grew
// upward from its anchor would push its own newest row off the top edge on
// every page.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { NotificationDto } from "@emberchat/protocol";
import { api } from "../../lib/api.js";
import { loadSocial } from "../../lib/social.js";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import { channelPath, dmPath, identityPath } from "../../lib/routes.js";
import { useMessagesStore } from "../../stores/messages.js";
import {
  UNSEEN_DISPLAY_CAP,
  useNotificationsStore,
  type FriendRequestVerdict,
} from "../../stores/notifications.js";
import {
  useSessionsStore,
  type IdentitySession,
  type SocialData,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { ago } from "../profile/time.js";
import {
  CheckGlyph,
  CloseGlyph,
  InboxGlyph,
  TrashGlyph,
} from "../icons/Glyphs.js";
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

/** Trailing glyph buttons: 15px in a small square, the sidebar's row scale
 * rather than the toolbar's 17px IconBtn — these annotate a two-line row. */
const ROW_GLYPH_SIZE = 15;

/**
 * Where a friend-request entry stands right now (#505).
 *
 * `unknown` is not a failure state: it is what an entry says before this
 * device has fetched the social lists, and the honest answer then is neither
 * buttons (which might act on a request that is long gone) nor a verdict
 * (which would be a guess).
 */
export type RequestState =
  | { status: "pending"; requestId: number }
  | { status: "accepted" }
  | { status: "declined" }
  | { status: "unknown" };

/**
 * The ladder, in the order it is read:
 *
 *  1. A verdict this client just handed down wins for the seconds the social
 *     refresh takes — during those, the request has left `incoming` and has
 *     not yet reached `friends`, so every other rung would answer "declined"
 *     to a click that said accept.
 *  2. Still in `incoming` → pending, and the requestId to act with comes
 *     from there. This is the source of truth for "is there anything to do",
 *     and it is live on every device.
 *  3. Gone from `incoming` and present in `friends` → accepted. Covers the
 *     other device, the other surface, and f-list.net.
 *  4. Gone from both → declined.
 *
 * The known give in rung 4: a request accepted long ago and unfriended since
 * reads "Declined" on a device that did not see the accept. Distinguishing
 * the two would mean storing a verdict per row — a mutable column on a log
 * that is append-only by design, which would still be blind to anything done
 * on the website. A stale label on a months-old log line is the cheaper
 * wrong answer, and the row's real state is one glance at the friends list.
 */
export function friendRequestState(
  entry: NotificationDto,
  social: SocialData | undefined,
  actioned: FriendRequestVerdict | undefined,
): RequestState {
  if (entry.kind !== "friendrequest") {
    return { status: "unknown" };
  }
  if (actioned !== undefined) {
    return { status: actioned };
  }
  const who = entry.character.toLowerCase();
  if (social === undefined || who === "") {
    return { status: "unknown" };
  }
  // F-Chat resolves names case-insensitively and the JSON API's casing can
  // differ from the chat socket's (#265) — fold both sides before matching.
  const pending = social.incoming.find(
    (request) => request.name.toLowerCase() === who,
  );
  if (pending !== undefined) {
    return { status: "pending", requestId: pending.id };
  }
  return social.friends.some((friend) => friend.name.toLowerCase() === who)
    ? { status: "accepted" }
    : { status: "declined" };
}

function InboxRow({
  entry,
  session,
  unseen,
  request,
  onActivate,
  onRespond,
  onRemove,
}: {
  entry: NotificationDto;
  session: IdentitySession | undefined;
  unseen: boolean;
  request: RequestState;
  onActivate: (entry: NotificationDto) => void;
  onRespond: (
    entry: NotificationDto,
    requestId: number,
    action: "accept" | "deny",
  ) => void;
  onRemove: (entry: NotificationDto) => void;
}) {
  const conversation = conversationLabel(session, entry.convId);
  const line = notificationLine(entry, conversation);
  const who = entry.character === "" ? "this character" : entry.character;
  return (
    <div
      className={`${styles.inboxRow} ${unseen ? (styles.inboxRowUnseen ?? "") : ""}`}
    >
      <button
        type="button"
        className={styles.inboxRowMain}
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
      <span className={styles.inboxRowTrail}>
        {request.status === "pending" && (
          <>
            <button
              type="button"
              className={`${styles.inboxAction} ${styles.inboxActionAccept ?? ""}`}
              aria-label={`Accept friend request from ${who}`}
              title="Accept"
              onClick={() => {
                onRespond(entry, request.requestId, "accept");
              }}
            >
              <CheckGlyph size={ROW_GLYPH_SIZE} />
            </button>
            <button
              type="button"
              className={`${styles.inboxAction} ${styles.inboxActionReject ?? ""}`}
              aria-label={`Decline friend request from ${who}`}
              title="Decline"
              onClick={() => {
                onRespond(entry, request.requestId, "deny");
              }}
            >
              <CloseGlyph size={ROW_GLYPH_SIZE} />
            </button>
          </>
        )}
        {(request.status === "accepted" || request.status === "declined") && (
          <span className={styles.inboxRowVerdict}>
            {request.status === "accepted" ? "Accepted" : "Declined"}
          </span>
        )}
        <button
          type="button"
          className={`${styles.inboxAction} ${styles.inboxActionRemove ?? ""}`}
          // Quiet until the row is pointed at, and permanently drawn where
          // nothing can hover (base.css §5-F) — the row keeps its width for
          // it either way, so nothing shifts under the pointer.
          data-eb-hover-reveal
          aria-label="Remove notification"
          title="Remove notification"
          onClick={() => {
            onRemove(entry);
          }}
        >
          <TrashGlyph size={ROW_GLYPH_SIZE} />
        </button>
      </span>
    </div>
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
    // Friend-request entries read their pending/resolved state off the social
    // lists (#505), and this panel can be the first surface on a device to
    // want them — on a phone the sidebar that normally loads them is a pane
    // away. Cached and single-flighted, so an already-loaded identity pays
    // nothing; a failure just leaves those rows without their buttons.
    loadSocial(identityId).catch(() => undefined);
  }, [identityId]);

  /** Answer a friend request, through the endpoint the sidebar rows use. */
  function respond(
    entry: NotificationDto,
    requestId: number,
    action: "accept" | "deny",
  ) {
    const notifications = useNotificationsStore.getState();
    // Optimistic and local: the row resolves on the click, and the lists it
    // actually derives from catch up over the next few seconds.
    notifications.markActioned(
      identityId,
      entry.id,
      action === "accept" ? "accepted" : "declined",
    );
    setError(undefined);
    void api
      .postFriendRequest(identityId, { action, requestId })
      // The upstream effects (a new friend, a request gone) are not
      // patchable from here — force the refetch, as the sidebar does.
      .then(() => loadSocial(identityId, true))
      .catch(() => {
        notifications.clearActioned(identityId, entry.id);
        setError("Couldn't answer that friend request.");
      });
  }

  /** Delete one log line. Never touches what the line was about (#506). */
  function remove(entry: NotificationDto) {
    setError(undefined);
    void useNotificationsStore
      .getState()
      .remove(identityId, entry.id)
      .catch(() => {
        setError("Couldn't remove that notification.");
      });
  }

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
      // The row itself now answers the request (#505); this is the second
      // surface the issue kept for v1 — the sidebar's request rows, which
      // are per identity, so land on the identity first.
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
    <div
      className={styles.inboxPanel}
      data-eb-surface
      role="dialog"
      aria-label="Notifications"
    >
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
            request={friendRequestState(
              entry,
              session?.social,
              inbox?.actioned[entry.id],
            )}
            onActivate={activate}
            onRespond={respond}
            onRemove={remove}
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
