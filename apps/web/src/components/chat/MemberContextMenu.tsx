// MemberContextMenu (COMPONENTS.md §10): right-click popover on a member
// row. Header = avatar + nick + role tag; items are gated by the target
// relationship (own row loses Message/Ignore; an ignored target offers
// Unignore). The admin-only section (kick/ban/promote…) and the social
// items (bookmark, friend request) land with M6 steps 6–7 — this is the
// foundation the gating hangs off.

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
import { roleTag, type ChannelRole } from "./member-roles.js";
import styles from "./chat.module.css";

export function MemberContextMenu({
  identityId,
  ownCharacter,
  member,
  role,
  position,
  onClose,
}: {
  identityId: string;
  /** The viewing identity's character (self rows lose Message/Ignore). */
  ownCharacter: string;
  member: MemberDto;
  role: ChannelRole;
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement>(null);
  const self = member.character.toLowerCase() === ownCharacter.toLowerCase();
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
      </div>
    </>
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
