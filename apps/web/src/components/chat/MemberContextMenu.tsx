// MemberContextMenu (COMPONENTS.md §10): right-click popover on a member
// row. Header = avatar + nick + role tag; items are gated by the target
// relationship (own row loses Message/Ignore; an ignored target offers
// Unignore). The admin section (kick/timeout/ban/promote/demote/set-owner,
// each dim with a mono `admin` tag) renders only for op+ viewers and
// mirrors the wire rules via modPowers. The social items (bookmark, friend
// request) are relationship-aware off the lazily-loaded social lists.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useNavigate } from "react-router";
import type { MemberDto } from "@emberchat/protocol";
import { gateway } from "../../gateway/socket.js";
import { api } from "../../lib/api.js";
import { dmPath } from "../../lib/routes.js";
import { loadSocial } from "../../lib/social.js";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import { useProfileStore } from "../../stores/profile.js";
import { useSessionsStore } from "../../stores/sessions.js";
import { Avatar } from "../common/Avatar.js";
import { modPowers, roleTag, type ChannelRole } from "./member-roles.js";
import styles from "./chat.module.css";

/** Menu-triggered timeouts use one sensible default; finer control lives
 * in the composer's /timeout command (1-90 minutes on the wire). */
const MENU_TIMEOUT_MINUTES = 30;

export function MemberContextMenu({
  identityId,
  ownCharacter,
  channelKey,
  channelTitle,
  member,
  role = null,
  viewerRole = null,
  viewerChatop = false,
  present = true,
  position,
  onClose,
}: {
  identityId: string;
  /** The viewing identity's character (self rows lose Message/Ignore). */
  ownCharacter: string;
  /** Absent outside a channel (sidebar rows, DM header) — the admin
   * section needs a channel to act on and stays hidden without one. */
  channelKey?: string;
  /** Display title — SFC reports carry this, not the key: private rooms'
   * keys are opaque ADH- ids moderators can't recognize (M7 audit).
   * Outside a channel it names the surface ("Conversation with X"). */
  channelTitle: string;
  member: MemberDto;
  role?: ChannelRole;
  viewerRole?: ChannelRole;
  viewerChatop?: boolean;
  /** False for "Seen recently" targets (#200): the admin section acts on a
   * live channel role an absent member doesn't hold, so it never renders —
   * gated on presence, not just viewer role. Everything else is identical. */
  present?: boolean;
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement>(null);
  const [reporting, setReporting] = useState(false);
  const [reportText, setReportText] = useState("");

  // Clamp against the *measured* menu — a full social+admin menu is 2–3×
  // the old fixed guess and could run off-screen (M6 audit). DOM write,
  // not state: the pre-paint nudge must not re-render. Re-runs when the
  // report form expands the menu.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) {
      return;
    }
    const margin = 8;
    const rect = el.getBoundingClientRect();
    const left = Math.min(position.x, window.innerWidth - rect.width - margin);
    const top = Math.min(position.y, window.innerHeight - rect.height - margin);
    el.style.left = `${String(Math.max(margin, left))}px`;
    el.style.top = `${String(Math.max(margin, top))}px`;
  }, [position, reporting]);
  const self = member.character.toLowerCase() === ownCharacter.toLowerCase();
  const powers = modPowers({
    viewer: viewerRole,
    viewerChatop,
    target: role,
    self,
  });
  const anyPower =
    present &&
    channelKey !== undefined &&
    (powers.remove || powers.promote || powers.demote || powers.setOwner);
  const ignored = useSessionsStore((s) =>
    (s.sessions[identityId]?.ignores ?? []).some(
      (name) => name.toLowerCase() === member.character.toLowerCase(),
    ),
  );
  // Relationship-aware social items (§10): the lists load lazily; until
  // they arrive the items simply don't render (right-click again).
  const social = useSessionsStore((s) => s.sessions[identityId]?.social);
  const lower = member.character.toLowerCase();
  const bookmarked =
    social?.bookmarks.some((row) => row.name.toLowerCase() === lower) ?? false;
  const friend =
    social?.friends.some((row) => row.name.toLowerCase() === lower) ?? false;
  const incomingRequest = social?.incoming.find(
    (row) => row.name.toLowerCase() === lower,
  );
  const outgoingRequest = social?.outgoing.find(
    (row) => row.name.toLowerCase() === lower,
  );

  useEffect(() => {
    loadSocial(identityId).catch(() => {
      // The social items just stay hidden.
    });
  }, [identityId]);

  // While drafting a report, the first Escape collapses the form back to the
  // menu (so a reflexive tap doesn't discard the complaint); a second Escape
  // closes the menu as usual. Either way the event is claimed by the shared
  // stack so MessageLog's jump/mark-read doesn't also fire.
  useEscapeToClose(() => {
    if (reporting) {
      setReporting(false);
      setReportText("");
      return;
    }
    onClose();
  });

  // Menus move focus into themselves; arrow keys walk the enabled items.
  useEffect(() => {
    enabledItems(menuRef.current)[0]?.focus();
  }, []);

  function onMenuKeyDown(event: ReactKeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    // Don't hijack arrow keys from the report textarea — the user is moving
    // the caret through their complaint, not walking the menu.
    if ((event.target as HTMLElement).tagName === "TEXTAREA") {
      return;
    }
    event.preventDefault();
    const items = enabledItems(menuRef.current);
    if (items.length === 0) {
      return;
    }
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? (current + 1) % items.length
        : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  function message() {
    onClose();
    void gateway
      .cmd({
        identityId,
        action: "pm.open",
        d: { character: member.character },
      })
      .then((ack) => {
        if (!ack.ok || !ack.conversation) {
          useSessionsStore
            .getState()
            .applyNotice(
              identityId,
              "error",
              ack.error ?? "Could not open the conversation",
            );
          return;
        }
        // Reopened conversations arrive only in the ack (cf. NewDmForm).
        useSessionsStore
          .getState()
          .applyConversation(identityId, ack.conversation);
        void navigate(
          dmPath(ownCharacter, ack.conversation.partnerCharacter ?? ""),
        );
      });
  }

  /** One shape for every moderation item: close, send, surface refusals. */
  function moderate(
    action:
      | "channel.ban"
      | "channel.demote"
      | "channel.kick"
      | "channel.owner"
      | "channel.promote"
      | "channel.timeout",
  ) {
    if (channelKey === undefined) {
      return;
    }
    onClose();
    const d =
      action === "channel.timeout"
        ? {
            key: channelKey,
            character: member.character,
            minutes: MENU_TIMEOUT_MINUTES,
          }
        : { key: channelKey, character: member.character };
    void gateway.cmd({ identityId, action, d } as never).then((ack) => {
      if (!ack.ok) {
        useSessionsStore
          .getState()
          .applyNotice(identityId, "error", ack.error ?? "Command failed");
      }
    });
  }

  /** Social mutations: close, call, refresh the lists, surface failures. */
  function mutateSocial(run: () => Promise<unknown>) {
    onClose();
    void run()
      .then(() => loadSocial(identityId, true))
      .catch((error: unknown) => {
        useSessionsStore
          .getState()
          .applyNotice(
            identityId,
            "error",
            error instanceof Error ? error.message : "Request failed",
          );
      });
  }

  /** Alert Staff (SFC, M7). The report rides the official-client shape —
   * tab, reported user, complaint — because that's what moderators' tooling
   * expects; third-party clients cannot attach log uploads. */
  function submitReport(event: FormEvent) {
    event.preventDefault();
    const complaint = reportText.trim();
    if (complaint === "") {
      return;
    }
    onClose();
    void gateway
      .cmd({
        identityId,
        action: "user.report",
        d: {
          character: member.character,
          report: `Current Tab/Channel: ${channelTitle} | Reporting User: ${member.character} | ${complaint}`,
        },
      })
      .then((ack) => {
        if (!ack.ok) {
          useSessionsStore
            .getState()
            .applyNotice(
              identityId,
              "error",
              ack.error ?? "Could not send the report",
            );
        }
        // Success needs no local notice — the server answers with a SYS
        // ("The moderators have been alerted.") that surfaces as usual.
      });
  }

  function toggleIgnore() {
    onClose();
    void gateway
      .cmd({
        identityId,
        action: ignored ? "ignore.remove" : "ignore.add",
        d: { character: member.character },
      })
      .then((ack) => {
        if (!ack.ok) {
          useSessionsStore
            .getState()
            .applyNotice(
              identityId,
              "error",
              ack.error ?? "Could not update the ignore list",
            );
        }
      });
  }

  return (
    <>
      <div
        className={styles.memberMenuOverlay}
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        className={styles.memberMenu}
        role="menu"
        aria-label={`${member.character} menu`}
        style={{ left: position.x, top: position.y }}
        onKeyDown={onMenuKeyDown}
      >
        <div className={styles.memberMenuHead}>
          <Avatar name={member.character} size={26} />
          <span className={styles.memberMenuNick}>{member.character}</span>
          {channelKey !== undefined && (
            <span className={styles.memberMenuRole}>{roleTag(role)}</span>
          )}
        </div>
        {!self && (
          <button
            className={styles.memberMenuItem}
            role="menuitem"
            onClick={message}
          >
            Message
          </button>
        )}
        <button
          className={styles.memberMenuItem}
          role="menuitem"
          onClick={() => {
            useProfileStore.getState().open(member.character);
            onClose();
          }}
        >
          View profile
        </button>
        <a
          className={styles.memberMenuItem}
          role="menuitem"
          href={`https://www.f-list.net/c/${encodeURIComponent(member.character)}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onClose}
        >
          Open on f-list.net{" "}
          <span className={styles.memberMenuHint}>↗ website</span>
        </a>
        {!self && social !== undefined && (
          <>
            <div className={styles.memberMenuDivider} />
            <button
              className={styles.memberMenuItem}
              role="menuitem"
              onClick={() => {
                mutateSocial(() =>
                  api.postBookmark(
                    identityId,
                    bookmarked ? "remove" : "add",
                    member.character,
                  ),
                );
              }}
            >
              {bookmarked ? "Remove bookmark" : "Add bookmark"}
            </button>
            {friend ? (
              <button
                className={styles.memberMenuItem}
                role="menuitem"
                onClick={() => {
                  mutateSocial(() =>
                    api.postFriendRequest(identityId, {
                      action: "remove-friend",
                      character: member.character,
                    }),
                  );
                }}
              >
                Remove friend
              </button>
            ) : incomingRequest ? (
              <button
                className={styles.memberMenuItem}
                role="menuitem"
                onClick={() => {
                  mutateSocial(() =>
                    api.postFriendRequest(identityId, {
                      action: "accept",
                      requestId: incomingRequest.id,
                    }),
                  );
                }}
              >
                Accept friend request
              </button>
            ) : outgoingRequest ? (
              <button
                className={styles.memberMenuItem}
                role="menuitem"
                onClick={() => {
                  mutateSocial(() =>
                    api.postFriendRequest(identityId, {
                      action: "cancel",
                      requestId: outgoingRequest.id,
                    }),
                  );
                }}
              >
                Cancel friend request
              </button>
            ) : (
              <button
                className={styles.memberMenuItem}
                role="menuitem"
                onClick={() => {
                  mutateSocial(() =>
                    api.postFriendRequest(identityId, {
                      action: "send",
                      character: member.character,
                    }),
                  );
                }}
              >
                Add friend
              </button>
            )}
          </>
        )}
        {!self && (
          <>
            <div className={styles.memberMenuDivider} />
            <button
              className={`${styles.memberMenuItem} ${styles.memberMenuDanger ?? ""}`}
              role="menuitem"
              onClick={toggleIgnore}
            >
              {ignored ? "Unignore" : "Ignore"}
            </button>
            {reporting ? (
              <form className={styles.reportForm} onSubmit={submitReport}>
                <textarea
                  className={styles.reportInput}
                  aria-label={`Report ${member.character} to staff`}
                  placeholder="What happened? This goes to F-List's moderators."
                  value={reportText}
                  maxLength={2000}
                  rows={3}
                  autoFocus
                  onChange={(e) => {
                    setReportText(e.target.value);
                  }}
                />
                <button
                  className={styles.reportSend}
                  type="submit"
                  disabled={reportText.trim() === ""}
                >
                  Send report
                </button>
              </form>
            ) : (
              <button
                className={`${styles.memberMenuItem} ${styles.memberMenuDanger ?? ""}`}
                role="menuitem"
                onClick={() => {
                  setReporting(true);
                }}
              >
                Report to staff…
              </button>
            )}
          </>
        )}
        {anyPower && (
          <>
            <div className={styles.memberMenuDivider} />
            {powers.remove && (
              <>
                <AdminItem
                  label="Kick"
                  onClick={() => {
                    moderate("channel.kick");
                  }}
                />
                <AdminItem
                  label={`Timeout ${String(MENU_TIMEOUT_MINUTES)}m`}
                  onClick={() => {
                    moderate("channel.timeout");
                  }}
                />
                <AdminItem
                  label="Ban"
                  onClick={() => {
                    moderate("channel.ban");
                  }}
                />
              </>
            )}
            {powers.promote && (
              <AdminItem
                label="Make channel op"
                onClick={() => {
                  moderate("channel.promote");
                }}
              />
            )}
            {powers.demote && (
              <AdminItem
                label="Remove channel op"
                onClick={() => {
                  moderate("channel.demote");
                }}
              />
            )}
            {powers.setOwner && (
              <AdminItem
                label="Make owner"
                onClick={() => {
                  moderate("channel.owner");
                }}
              />
            )}
          </>
        )}
      </div>
    </>
  );
}

/** §10 admin item: dim label, right-aligned mono `admin` tag. */
function AdminItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      className={`${styles.memberMenuItem} ${styles.memberMenuAdmin ?? ""}`}
      role="menuitem"
      onClick={onClick}
    >
      {label} <span className={styles.memberMenuAdminTag}>admin</span>
    </button>
  );
}

function enabledItems(root: HTMLDivElement | null): HTMLElement[] {
  return root
    ? [
        ...root.querySelectorAll<HTMLElement>(
          '[role="menuitem"]:not(:disabled)',
        ),
      ]
    : [];
}
