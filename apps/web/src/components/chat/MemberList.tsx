// MemberList (COMPONENTS.md §9): grouped Owner · Admins · Online · Idle.
// Channel member lists only ever contain present characters (ICH/JCH/LCH),
// so there is no Offline group. Avatars are the real F-List images,
// lazy-loaded with the initial-on-color fallback (decisions.md §6).
// Rows are interactive (M6): left-click opens the profile on the server
// website, right-click opens the MemberContextMenu.

import { useState, type MouseEvent as ReactMouseEvent } from "react";
import type { MemberDto } from "@emberchat/protocol";
import { presenceDot } from "../../lib/presence.js";
import type { ChannelView } from "../../stores/sessions.js";
import { Avatar } from "../common/Avatar.js";
import { MemberContextMenu } from "./MemberContextMenu.js";
import { roleFor, type ChannelRole } from "./member-roles.js";
import styles from "./chat.module.css";

const DOT_COLOR = {
  ok: "var(--eb-ok)",
  warn: "var(--eb-warn)",
  faint: "var(--eb-faint)",
} as const;

/** Keep the ~204px menu inside the viewport — member rows hug the right edge. */
const MENU_WIDTH = 216;

interface Group {
  label: string;
  members: MemberDto[];
  role: ChannelRole;
}

function groupMembers(channel: ChannelView): Group[] {
  const byName = (a: MemberDto, b: MemberDto) =>
    a.character.localeCompare(b.character);

  const groups: Group[] = [
    { label: "Owner", role: "owner", members: [] },
    { label: "Admins", role: "op", members: [] },
    { label: "Online", role: null, members: [] },
    { label: "Idle", role: null, members: [] },
  ];
  for (const member of channel.members) {
    const role = roleFor(member.character, channel.oplist);
    if (role === "owner") {
      groups[0]!.members.push(member);
    } else if (role === "op") {
      groups[1]!.members.push(member);
    } else if (presenceDot(true, member.status) === "ok") {
      groups[2]!.members.push(member);
    } else {
      groups[3]!.members.push(member);
    }
  }
  for (const group of groups) {
    group.members.sort(byName);
  }
  return groups.filter((group) => group.members.length > 0);
}

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
        {groupMembers(channel).map((group) => (
          <div key={group.label}>
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
          member={menu.member}
          role={menu.role}
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
  return (
    // Left-click = profile on the server website (§9); right-click = menu.
    <a
      className={styles.memberRow}
      role="listitem"
      href={`https://www.f-list.net/c/${encodeURIComponent(member.character)}`}
      target="_blank"
      rel="noopener noreferrer"
      onContextMenu={onContextMenu}
    >
      <span className={styles.memberAvatar}>
        <Avatar name={member.character} size={22} />
        <span
          className={styles.memberDot}
          style={{ background: DOT_COLOR[dot] }}
        />
      </span>
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
      >
        {member.character}
      </span>
      {member.statusmsg && (
        <span className={styles.memberStatus} title={member.statusmsg}>
          {member.statusmsg}
        </span>
      )}
    </a>
  );
}
