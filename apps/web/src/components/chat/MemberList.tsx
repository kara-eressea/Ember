// MemberList (COMPONENTS.md §9): grouped Owner · Admins · Online · Idle.
// Channel member lists only ever contain present characters (ICH/JCH/LCH),
// so there is no Offline group. Avatars are the real F-List images,
// lazy-loaded with the initial-on-color fallback (decisions.md §6).

import type { MemberDto } from "@emberchat/protocol";
import { presenceDot } from "../../lib/presence.js";
import type { ChannelView } from "../../stores/sessions.js";
import { Avatar } from "../common/Avatar.js";
import styles from "./chat.module.css";

const DOT_COLOR = {
  ok: "var(--eb-ok)",
  warn: "var(--eb-warn)",
  faint: "var(--eb-faint)",
} as const;

interface Group {
  label: string;
  members: MemberDto[];
  role: "owner" | "admin" | "member";
}

function groupMembers(channel: ChannelView): Group[] {
  const owner = channel.oplist[0] ?? "";
  const admins = new Set(channel.oplist.slice(1));
  const byName = (a: MemberDto, b: MemberDto) =>
    a.character.localeCompare(b.character);

  const groups: Group[] = [
    { label: "Owner", role: "owner", members: [] },
    { label: "Admins", role: "admin", members: [] },
    { label: "Online", role: "member", members: [] },
    { label: "Idle", role: "member", members: [] },
  ];
  for (const member of channel.members) {
    if (member.character === owner) {
      groups[0]!.members.push(member);
    } else if (admins.has(member.character)) {
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

export function MemberList({ channel }: { channel: ChannelView }) {
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
              />
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}

function MemberRow({
  member,
  role,
}: {
  member: MemberDto;
  role: "owner" | "admin" | "member";
}) {
  const dot = presenceDot(true, member.status);
  return (
    <div className={styles.memberRow} role="listitem">
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
      {role === "admin" && (
        <span className={`${styles.roleGlyph} ${styles.roleAdmin ?? ""}`}>
          @
        </span>
      )}
      <span
        className={`${styles.memberNick} ${role === "member" ? "" : (styles.op ?? "")}`}
      >
        {member.character}
      </span>
      {member.statusmsg && (
        <span className={styles.memberStatus} title={member.statusmsg}>
          {member.statusmsg}
        </span>
      )}
    </div>
  );
}
