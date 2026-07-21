// MemberList (COMPONENTS.md §9): grouped Owner · Admins · Online · Idle.
// Channel member lists only ever contain present characters (ICH/JCH/LCH),
// so there is no Offline group. Avatars are the real F-List images,
// lazy-loaded with the initial-on-color fallback (decisions.md §6).
// Rows are interactive: left-click opens the mini profile card (M8),
// right-click opens the MemberContextMenu — the f-list.net website link
// lives there.

import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { MemberDto } from "@emberchat/protocol";
import { bbcodeToText } from "@emberchat/markdown-bbcode";
import { presenceDot } from "../../lib/presence.js";
import { loadSocial } from "../../lib/social.js";
import { openCardFrom } from "../../stores/profile.js";
import { useSessionsStore, type ChannelView } from "../../stores/sessions.js";
import { genderColorVar } from "../../theme/tokens.js";
import { Avatar } from "../common/Avatar.js";
import { MemberContextMenu } from "./MemberContextMenu.js";
import { groupMembers, nameSet } from "./member-sort.js";
import { roleFor, type ChannelRole } from "./member-roles.js";
import styles from "./chat.module.css";

const DOT_COLOR = {
  ok: "var(--eb-ok)",
  warn: "var(--eb-warn)",
  faint: "var(--eb-faint)",
} as const;

/** Rough pre-clamp so the menu doesn't flash off-screen for a frame; the
 * menu itself re-clamps against its measured size once rendered. */
const MENU_WIDTH = 216;

interface MenuState {
  member: MemberDto;
  role: ChannelRole;
  position: { x: number; y: number };
}

export function MemberList({
  identityId,
  ownCharacter,
  channel,
}: {
  identityId: string;
  ownCharacter: string;
  channel: ChannelView;
}) {
  const [menu, setMenu] = useState<MenuState>();
  const viewerChatop = useSessionsStore(
    (s) => s.sessions[identityId]?.chatop ?? false,
  );
  const social = useSessionsStore((s) => s.sessions[identityId]?.social);
  const viewerRole = roleFor(ownCharacter, channel.oplist);

  // Friends/bookmarks drive the sort tiers (#178); lazily loaded, so ask once.
  useEffect(() => {
    void loadSocial(identityId);
  }, [identityId]);

  const groups = groupMembers({
    members: channel.members,
    oplist: channel.oplist,
    friends: nameSet(social?.friends),
    bookmarks: nameSet(social?.bookmarks),
  });

  function openMenu(
    event: ReactMouseEvent,
    member: MemberDto,
    role: ChannelRole,
  ) {
    event.preventDefault();
    setMenu({
      member,
      role,
      position: {
        x: Math.min(event.clientX, window.innerWidth - MENU_WIDTH),
        y: Math.min(event.clientY, window.innerHeight - 160),
      },
    });
  }

  return (
    <aside className={styles.members} aria-label="Members">
      <div className={styles.membersHeader}>
        Members{" "}
        <span className={styles.membersCount}>{channel.members.length}</span>
      </div>
      <div className={styles.membersScroll} role="list">
        {groups.map((group) => (
          <div key={group.key}>
            <div className={styles.memberGroup}>{group.label}</div>
            {group.members.map((member) => (
              <MemberRow
                key={member.character}
                member={member}
                role={group.role}
                onContextMenu={(event) => {
                  openMenu(event, member, group.role);
                }}
              />
            ))}
          </div>
        ))}
      </div>
      {menu && (
        <MemberContextMenu
          identityId={identityId}
          ownCharacter={ownCharacter}
          channelKey={channel.key}
          channelTitle={channel.title}
          member={menu.member}
          role={menu.role}
          viewerRole={viewerRole}
          viewerChatop={viewerChatop}
          position={menu.position}
          onClose={() => {
            setMenu(undefined);
          }}
        />
      )}
    </aside>
  );
}

function MemberRow({
  member,
  role,
  onContextMenu,
}: {
  member: MemberDto;
  role: ChannelRole;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  const dot = presenceDot(true, member.status);
  // Status shows on a second line under the name (#217). BBCode is stripped to
  // its text content — one-line/dense context, raw tags must never show (#210).
  const status = member.statusmsg ? bbcodeToText(member.statusmsg) : "";
  // Gender tint is supplementary (#177): the name keeps AA contrast regardless,
  // so it stays fully readable without the colour.
  const genderColor = genderColorVar(member.gender);
  return (
    // Left-click = mini profile card anchored to the row (§13);
    // right-click = menu.
    <button
      type="button"
      className={styles.memberRow}
      role="listitem"
      onClick={(event) => {
        openCardFrom(event.currentTarget, member.character);
      }}
      onContextMenu={onContextMenu}
    >
      <span className={styles.memberAvatar}>
        <Avatar name={member.character} size={30} />
        <span
          className={styles.memberDot}
          style={{ background: DOT_COLOR[dot] }}
          data-dot={dot}
        />
      </span>
      <span className={styles.memberBody}>
        <span className={styles.memberNickLine}>
          {role === "owner" && (
            <span className={`${styles.roleGlyph} ${styles.roleOwner ?? ""}`}>
              ~
            </span>
          )}
          {role === "op" && (
            <span className={`${styles.roleGlyph} ${styles.roleAdmin ?? ""}`}>
              @
            </span>
          )}
          <span
            className={`${styles.memberNick} ${role === null ? "" : (styles.op ?? "")}`}
            style={genderColor ? { color: genderColor } : undefined}
          >
            {member.character}
          </span>
        </span>
        {status && (
          <span className={styles.memberStatus} title={status}>
            {status}
          </span>
        )}
      </span>
    </button>
  );
}
