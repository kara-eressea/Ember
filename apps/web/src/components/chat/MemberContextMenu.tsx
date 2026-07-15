// MemberContextMenu (COMPONENTS.md §10): right-click popover on a member
// row. Header = avatar + nick + role tag; items are gated by the target
// relationship (own row loses Message/Ignore; an ignored target offers
// Unignore). The admin section (kick/timeout/ban/promote/demote/set-owner,
// each dim with a mono `admin` tag) renders only for op+ viewers and
// mirrors the wire rules via modPowers. Social items (bookmark, friend
// request) land with M6 step 7.

import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useNavigate } from "react-router";
import type { MemberDto } from "@emberchat/protocol";
import { gateway } from "../../gateway/socket.js";
import { dmPath } from "../../lib/routes.js";
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
  member,
  role,
  viewerRole,
  viewerChatop,
  position,
  onClose,
}: {
  identityId: string;
  /** The viewing identity's character (self rows lose Message/Ignore). */
  ownCharacter: string;
  channelKey: string;
  member: MemberDto;
  role: ChannelRole;
  viewerRole: ChannelRole;
  viewerChatop: boolean;
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement>(null);
  const self = member.character.toLowerCase() === ownCharacter.toLowerCase();
  const powers = modPowers({
    viewer: viewerRole,
    viewerChatop,
    target: role,
    self,
  });
  const anyPower =
    powers.remove || powers.promote || powers.demote || powers.setOwner;
  const ignored = useSessionsStore((s) =>
    (s.sessions[identityId]?.ignores ?? []).some(
      (name) => name.toLowerCase() === member.character.toLowerCase(),
    ),
  );

  useEffect(() => {
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

  // Menus move focus into themselves; arrow keys walk the enabled items.
  useEffect(() => {
    enabledItems(menuRef.current)[0]?.focus();
  }, []);

  function onMenuKeyDown(event: ReactKeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
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
          <span className={styles.memberMenuRole}>{roleTag(role)}</span>
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
        <a
          className={styles.memberMenuItem}
          role="menuitem"
          href={`https://www.f-list.net/c/${encodeURIComponent(member.character)}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onClose}
        >
          View profile <span className={styles.memberMenuHint}>↗ website</span>
        </a>
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
