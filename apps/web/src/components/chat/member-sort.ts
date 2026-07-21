// Member-list grouping + ordering (#178). One pure function turns a channel's
// members into ordered, labelled groups: channel ops/mods first (owner, then
// admins), then friends, then bookmarks, then everyone else — alphabetical
// within each group. Friends/bookmarks come from the social store.
//
// Grouping is deliberately precedence-based and data-driven so the ladder is
// easy to extend (e.g. an "Offline" tier for #200) without touching callers:
// add a rung to GROUP_ORDER and a case to classify(). Kept side-effect free
// and self-contained for unit testing.

import type { MemberDto } from "@emberchat/protocol";
import { roleFor, type ChannelRole } from "./member-roles.js";

export type MemberGroupKey = "owner" | "op" | "friend" | "bookmark" | "member";

export interface MemberGroup {
  readonly key: MemberGroupKey;
  readonly label: string;
  /** Role glyph the rows in this group carry (owner ~ / admin @ / none). */
  readonly role: ChannelRole;
  readonly members: MemberDto[];
}

/** Highest precedence first — a friend who is also an op sorts as an op. */
const GROUP_ORDER: readonly {
  key: MemberGroupKey;
  label: string;
  role: ChannelRole;
}[] = [
  { key: "owner", label: "Owner", role: "owner" },
  { key: "op", label: "Admins", role: "op" },
  { key: "friend", label: "Friends", role: null },
  { key: "bookmark", label: "Bookmarks", role: null },
  { key: "member", label: "Members", role: null },
];

export interface SortInput {
  members: readonly MemberDto[];
  /** COL oplist, owner-first (see member-roles). */
  oplist: readonly string[];
  /** Lower-cased friend character names. */
  friends: ReadonlySet<string>;
  /** Lower-cased bookmark character names. */
  bookmarks: ReadonlySet<string>;
}

function classify(member: MemberDto, input: SortInput): MemberGroupKey {
  const role = roleFor(member.character, input.oplist);
  if (role === "owner") {
    return "owner";
  }
  if (role === "op") {
    return "op";
  }
  const needle = member.character.toLowerCase();
  if (input.friends.has(needle)) {
    return "friend";
  }
  if (input.bookmarks.has(needle)) {
    return "bookmark";
  }
  return "member";
}

/**
 * Groups and orders a channel's members. Returns only non-empty groups, in
 * precedence order, alphabetical (case-insensitive) within each.
 */
export function groupMembers(input: SortInput): MemberGroup[] {
  const buckets = new Map<MemberGroupKey, MemberDto[]>(
    GROUP_ORDER.map((g) => [g.key, []]),
  );
  for (const member of input.members) {
    buckets.get(classify(member, input))!.push(member);
  }
  const byName = (a: MemberDto, b: MemberDto) =>
    a.character.localeCompare(b.character, undefined, { sensitivity: "base" });
  return GROUP_ORDER.flatMap((g) => {
    const members = buckets.get(g.key)!;
    if (members.length === 0) {
      return [];
    }
    members.sort(byName);
    return [{ ...g, members }];
  });
}

/** Lower-cased name set from social rows, for the sort's friend/bookmark tiers. */
export function nameSet(
  rows: readonly { name: string }[] | undefined,
): Set<string> {
  return new Set((rows ?? []).map((r) => r.name.toLowerCase()));
}
