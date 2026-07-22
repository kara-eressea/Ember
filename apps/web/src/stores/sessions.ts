// Per-identity live session state (architecture.md §Client, COMPONENTS.md
// state model): channels with member lists, DM rows with presence, session
// status. Mutated only by gateway/dispatch.ts applying server frames — the
// gateway protocol documents volatile events as at-least-once idempotent
// state operations, so every mutation here is an overwrite or a set
// add/remove, never a counter increment keyed to event arrival.

import { create } from "zustand";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import type {
  CampaignDto,
  OutboxItemDto,
  ConversationDto,
  GatewaySessionStatus,
  MemberDto,
  SeenMemberDto,
  SnapshotChannel,
  SnapshotDm,
  UserPrefs,
} from "@emberchat/protocol";

export interface ChannelView {
  convId: string;
  key: string;
  title: string;
  description: string;
  mode: string;
  /** First entry is the owner (may be ""). */
  oplist: string[];
  /** Set semantics — empty while we are not live in the channel. */
  members: MemberDto[];
  /** Previously-seen members not present now (#200), newest lastSeen
   * first. Server-persisted; retention/cap pruning is server-owned — the
   * client only mirrors live moves (part adds, rejoin removes). */
  seen: SeenMemberDto[];
  joined: boolean;
  pinned: boolean;
  unread: number;
  /** Unread messages naming this identity (server-counted at snapshot,
   * bumped client-side for live messages). */
  mentions: number;
  /** Last live mention (epoch ms, 0 = none) — the "bump to top" sort key
   * when the highlightBump pref is on. Volatile: cleared on visit, never
   * persisted or restored by snapshots. */
  highlightedAt: number;
  lastReadMessageId: number | null;
}

export interface DmView {
  convId: string;
  partner: string;
  title: string;
  online: boolean;
  status: string;
  statusmsg: string;
  pinned: boolean;
  /** TPN state: "typing" | "paused" | "clear". */
  typing: string;
  unread: number;
  /** Same bump sort key as ChannelView.highlightedAt. */
  highlightedAt: number;
  lastReadMessageId: number | null;
}

export interface IdentitySession {
  identityId: string;
  character: string;
  sessionStatus: GatewaySessionStatus;
  statusReason?: string;
  /** Our own F-Chat status (STA) — distinct from the session lifecycle. */
  ownStatus: string;
  ownStatusmsg: string;
  /** Ignore list (canonical casing). Messages from these characters stay
   * persisted but are hidden from render. */
  ignores: string[];
  /** Live server VARs (bytes) from the snapshot — composer limits. */
  limits: {
    chatMax: number;
    privMax: number;
    lfrpMax: number;
    lfrpFlood: number;
  };
  /** Channels where the server disallows [icon]/[eicon] (icon_blacklist). */
  iconBlacklist: string[];
  /** Own character is a chatop (global moderator) — unlocks the admin UI. */
  chatop: boolean;
  /** The user's delayed-send window (per-user; mirrored per slice). */
  sendDelaySeconds: number;
  /** The user's resolved preferences (per-user; mirrored per slice). */
  prefs: UserPrefs;
  /** Messages waiting in the server-side outbox for this identity. */
  outbox: OutboxItemDto[];
  /** The identity's ad-rotation campaign (M11); null = none exists. */
  campaign: CampaignDto | null;
  /** Keyed by channel key (events address channels by key). */
  channels: Record<string, ChannelView>;
  /** Keyed by conversation id. */
  dms: Record<string, DmView>;
  /** convId → channel key, for events keyed the other way around. */
  channelByConvId: Record<string, string>;
  /** Snapshot received — the sidebar can render. */
  synced: boolean;
  /** Latest transient global SYS / ERR, surfaced as a dismissable strip. */
  notice?: { kind: "sys" | "error"; text: string };
  /** Pending channel invitations (inbound CIU) — volatile, actionable rows
   * in the sidebar. A missed invite stays joinable via its key anyway. */
  invites: ChannelInvite[];
  /** Bookmarks/friends/requests (M6 step 7), lazily loaded through the
   * social REST endpoint (loadSocial). Absent until first fetched. */
  social?: SocialData;
}

/** One friend or bookmark row, presence-enriched by the server. */
export interface SocialCharacter {
  name: string;
  online: boolean;
  status: string;
  statusmsg: string;
}

export interface SocialData {
  bookmarks: SocialCharacter[];
  friends: SocialCharacter[];
  incoming: { id: number; name: string }[];
  outgoing: { id: number; name: string }[];
  fetchedAt: number;
}

export interface ChannelInvite {
  sender: string;
  title: string;
  key: string;
}

export interface IdentitySummary {
  id: string;
  name: string;
  /** Connect intent — gates the shell's connect-on-visit. The server
   * maintains it (connect sets, disconnect clears); mirrored locally when
   * this tab issues the cmd, and re-synced by the next ready frame. */
  autoConnect: boolean;
  /** Ready-time badge totals across the identity's conversations. Initial
   * paint only — once a slice is synced, the rail aggregates its live
   * per-conversation counters instead. */
  unread: number;
  mentions: number;
}

interface SessionsState {
  /** From the ready frame — everything the app account owns. */
  identities: IdentitySummary[] | undefined;
  sessions: Record<string, IdentitySession>;

  applyReady(identities: IdentitySummary[]): void;
  /** Local mirror maintenance for REST-driven identity CRUD (the picker):
   * `ready` is the authority but arrives only at socket connect, so an
   * identity created after the hello would otherwise not exist for this tab
   * until a reconnect. */
  upsertIdentity(identity: IdentitySummary): void;
  removeIdentity(identityId: string): void;
  setAutoConnect(identityId: string, value: boolean): void;
  /** Re-sorts the rail; ids missing from `order` keep their relative place
   * at the end (a create racing the reorder must not vanish). */
  applyIdentityOrder(order: string[]): void;
  applySnapshot(d: {
    identityId: string;
    self: {
      character: string;
      sessionStatus: GatewaySessionStatus;
      status: string;
      statusmsg: string;
      ignores: string[];
      limits: {
        chatMax: number;
        privMax: number;
        lfrpMax: number;
        lfrpFlood: number;
      };
      iconBlacklist: string[];
      chatop: boolean;
      sendDelaySeconds: number;
      prefs: UserPrefs;
      outbox: OutboxItemDto[];
      campaign: CampaignDto | null;
      social: {
        bookmarks: SocialCharacter[];
        friends: SocialCharacter[];
        incoming: { id: number; name: string }[];
        outgoing: { id: number; name: string }[];
      } | null;
    };
    channels: SnapshotChannel[];
    dms: SnapshotDm[];
  }): void;
  /** Full pending-outbox overwrite (outbox.updated / snapshot). */
  applyOutbox(identityId: string, items: OutboxItemDto[]): void;
  /** Full campaign overwrite (campaign.updated / snapshot). */
  applyCampaign(identityId: string, campaign: CampaignDto | null): void;
  applySendDelay(identityId: string, sendDelaySeconds: number): void;
  applySocial(identityId: string, social: SocialData): void;
  /** Full resolved-prefs overwrite (prefs.updated). */
  applyPrefs(
    identityId: string,
    d: { sendDelaySeconds: number; prefs: UserPrefs },
  ): void;
  /** Optimistic local prefs overwrite across every slice — prefs are per
   * user, so a pane edit must not wait for the per-identity fan-out. */
  applyPrefsLocal(prefs: UserPrefs): void;
  /** Full ignore-list overwrite (ignore.updated / snapshot). */
  applyIgnores(identityId: string, characters: string[]): void;
  applySessionStatus(
    identityId: string,
    status: GatewaySessionStatus,
    reason?: string,
  ): void;
  applyConversation(identityId: string, conversation: ConversationDto): void;
  applyMemberJoin(
    identityId: string,
    channelKey: string,
    member: MemberDto,
  ): void;
  applyMemberLeave(
    identityId: string,
    channelKey: string,
    character: string,
  ): void;
  applyChannelMembers(
    identityId: string,
    d: { key: string; mode: string; members: MemberDto[] },
  ): void;
  applyChannelInfo(
    identityId: string,
    d: {
      key: string;
      title?: string;
      description?: string;
      mode?: string;
      oplist?: string[];
    },
  ): void;
  applyPresence(
    identityId: string,
    d: {
      character: string;
      online: boolean;
      gender?: string;
      status?: string;
      statusmsg?: string;
    },
  ): void;
  /** One LIS roster batch — [name, gender, status, statusmsg]. */
  applyPresenceBulk(
    identityId: string,
    characters: [string, string, string, string][],
  ): void;
  applyTyping(identityId: string, character: string, status: string): void;
  applyNotice(identityId: string, kind: "sys" | "error", text: string): void;
  clearNotice(identityId: string): void;
  addInvite(identityId: string, invite: ChannelInvite): void;
  dismissInvite(identityId: string, key: string): void;
  bumpUnread(identityId: string, convId: string, mention?: boolean): void;
  /** Stamp the conversation's bump sort key (highlightBump pref). */
  bumpHighlight(identityId: string, convId: string): void;
  clearUnread(identityId: string, convId: string): void;
  reset(): void;
}

/**
 * The user's prefs from any synced slice — they are per app account and
 * identical across slices, so render code without an identity context
 * (RichText, previews) reads them here.
 */
export function useUserPrefs(): UserPrefs {
  return useSessionsStore((s) => {
    for (const session of Object.values(s.sessions)) {
      if (session.synced) {
        return session.prefs;
      }
    }
    return PREFS_DEFAULTS;
  });
}

function emptySession(identityId: string): IdentitySession {
  return {
    identityId,
    character: "",
    sessionStatus: "offline",
    ownStatus: "online",
    ownStatusmsg: "",
    ignores: [],
    // Placeholder until the snapshot delivers the live VARs.
    limits: { chatMax: 4096, privMax: 50000, lfrpMax: 50000, lfrpFlood: 600 },
    iconBlacklist: [],
    chatop: false,
    sendDelaySeconds: 0,
    prefs: PREFS_DEFAULTS,
    outbox: [],
    campaign: null,
    channels: {},
    dms: {},
    channelByConvId: {},
    invites: [],
    synced: false,
  };
}

/** F-Chat resolves character names case-insensitively (PM merge semantics). */
/** Applies one presence delta to social rows, case-insensitively (#218). */
function patchSocialPresence(
  social: SocialData,
  d: {
    character: string;
    online: boolean;
    status?: string;
    statusmsg?: string;
  },
): SocialData {
  const apply = (row: SocialCharacter): SocialCharacter =>
    sameCharacter(row.name, d.character)
      ? {
          ...row,
          online: d.online,
          status: d.online ? (d.status ?? row.status) : "offline",
          statusmsg: d.online ? (d.statusmsg ?? row.statusmsg) : "",
        }
      : row;
  return {
    ...social,
    bookmarks: social.bookmarks.map(apply),
    friends: social.friends.map(apply),
  };
}

/** LIS batches are partial: presence in the batch marks a row online;
 * absence proves nothing. */
function bulkRow(
  row: SocialCharacter,
  byLower: Map<string, { status: string; statusmsg: string }>,
): SocialCharacter {
  const presence = byLower.get(row.name.toLowerCase());
  return presence
    ? {
        ...row,
        online: true,
        status: presence.status,
        statusmsg: presence.statusmsg,
      }
    : row;
}

function sameCharacter(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The seen roster without one nick (case-insensitive; unchanged input when
 * absent, so untouched channels keep their array identity). */
function withoutSeen(
  seen: SeenMemberDto[],
  character: string,
): SeenMemberDto[] {
  return seen.some((entry) => sameCharacter(entry.character, character))
    ? seen.filter((entry) => !sameCharacter(entry.character, character))
    : seen;
}

/** On part: drop the nick from members and upsert it into seen (newest
 * first) with the gender the roster knew — a nick is never in both. */
function moveMemberToSeen(
  channel: ChannelView,
  character: string,
): ChannelView {
  const member = channel.members.find((m) =>
    sameCharacter(m.character, character),
  );
  return {
    ...channel,
    members: channel.members.filter(
      (m) => !sameCharacter(m.character, character),
    ),
    seen: [
      {
        character: member?.character ?? character,
        gender: member?.gender ?? "",
        lastSeen: Date.now(),
      },
      ...withoutSeen(channel.seen, character),
    ],
  };
}

export const useSessionsStore = create<SessionsState>()((set, get) => {
  /** Immutable single-session update; creates the session if unknown. */
  function patch(
    identityId: string,
    update: (session: IdentitySession) => IdentitySession,
  ): void {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [identityId]: update(
          state.sessions[identityId] ?? emptySession(identityId),
        ),
      },
    }));
  }

  /**
   * Volatile channel events (JCH/ICH/CDS/COL) fan out straight off the
   * session bus, while the conversation row that names the channel goes
   * through the sink's write queue — so they routinely arrive first. Create
   * the entry on miss (convId "" until conversation.updated fills it in)
   * rather than dropping the event.
   */
  function patchChannel(
    identityId: string,
    key: string,
    update: (channel: ChannelView) => ChannelView,
  ): void {
    patch(identityId, (session) => {
      const channel = session.channels[key] ?? {
        convId: "",
        key,
        title: key,
        description: "",
        mode: "both",
        oplist: [],
        members: [],
        seen: [],
        joined: false,
        pinned: false,
        unread: 0,
        mentions: 0,
        highlightedAt: 0,
        lastReadMessageId: null,
      };
      return {
        ...session,
        channels: { ...session.channels, [key]: update(channel) },
      };
    });
  }

  return {
    identities: undefined,
    sessions: {},

    applyReady(identities) {
      set({ identities });
    },

    upsertIdentity(identity) {
      set((state) => {
        const identities = state.identities ?? [];
        const existing = identities.findIndex((i) => i.id === identity.id);
        return {
          identities:
            existing === -1
              ? [...identities, identity]
              : identities.map((i, index) =>
                  index === existing ? { ...i, ...identity } : i,
                ),
        };
      });
    },

    removeIdentity(identityId) {
      set((state) => {
        // The session slice goes with the identity — a ghost slice would
        // resurface stale state if the id were ever reused via upsert.
        const sessions = { ...state.sessions };
        delete sessions[identityId];
        return {
          identities: state.identities?.filter((i) => i.id !== identityId),
          sessions,
        };
      });
    },

    setAutoConnect(identityId, value) {
      set((state) => ({
        identities: state.identities?.map((identity) =>
          identity.id === identityId
            ? { ...identity, autoConnect: value }
            : identity,
        ),
      }));
    },

    applyIdentityOrder(order) {
      set((state) => {
        if (!state.identities) {
          return {};
        }
        const rank = new Map(order.map((id, index) => [id, index]));
        const identities = [...state.identities].sort(
          (a, b) =>
            (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length),
        );
        return { identities };
      });
    },

    applySnapshot(d) {
      // A snapshot replaces all volatile state for the identity (§Resume
      // semantics: it is never patched, always rebuilt).
      const channels: Record<string, ChannelView> = {};
      const channelByConvId: Record<string, string> = {};
      for (const ch of d.channels) {
        channels[ch.key] = {
          ...ch,
          oplist: [...ch.oplist],
          members: [...ch.members],
          seen: [...ch.seen],
          highlightedAt: 0,
        };
        channelByConvId[ch.convId] = ch.key;
      }
      const dms: Record<string, DmView> = {};
      for (const dm of d.dms) {
        dms[dm.convId] = { ...dm, typing: "clear", highlightedAt: 0 };
      }
      patch(d.identityId, (session) => ({
        ...session,
        character: d.self.character,
        sessionStatus: d.self.sessionStatus,
        ownStatus: d.self.status,
        ownStatusmsg: d.self.statusmsg,
        ignores: [...d.self.ignores],
        limits: d.self.limits,
        iconBlacklist: [...d.self.iconBlacklist],
        chatop: d.self.chatop,
        sendDelaySeconds: d.self.sendDelaySeconds,
        prefs: d.self.prefs,
        outbox: [...d.self.outbox],
        campaign: d.self.campaign,
        channels,
        dms,
        channelByConvId,
        synced: true,
        // Server-cached social lists ride the snapshot (#194) — a fresh
        // device renders bookmarks/friends without any REST fetch. No
        // cache yet server-side keeps whatever this tab already had.
        ...(d.self.social
          ? { social: { ...d.self.social, fetchedAt: Date.now() } }
          : {}),
      }));
    },

    applyOutbox(identityId, items) {
      patch(identityId, (session) => ({ ...session, outbox: [...items] }));
    },

    applyCampaign(identityId, campaign) {
      patch(identityId, (session) => ({ ...session, campaign }));
    },

    applySocial(identityId, social) {
      patch(identityId, (session) => ({ ...session, social }));
    },

    applySendDelay(identityId, sendDelaySeconds) {
      patch(identityId, (session) => ({ ...session, sendDelaySeconds }));
    },

    applyPrefs(identityId, { sendDelaySeconds, prefs }) {
      patch(identityId, (session) => ({
        ...session,
        sendDelaySeconds,
        prefs,
      }));
    },

    applyPrefsLocal(prefs) {
      set((state) => ({
        sessions: Object.fromEntries(
          Object.entries(state.sessions).map(([id, session]) => [
            id,
            { ...session, prefs },
          ]),
        ),
      }));
    },

    applyIgnores(identityId, characters) {
      patch(identityId, (session) => ({
        ...session,
        ignores: [...characters],
      }));
    },

    applySessionStatus(identityId, status, reason) {
      patch(identityId, (session) => ({
        ...session,
        sessionStatus: status,
        statusReason: reason,
        // A session that went away has no live channel state; member lists
        // rebuild from ICH after the next connect + join.
        ...(status === "stopped" || status === "offline"
          ? {
              channels: Object.fromEntries(
                Object.entries(session.channels).map(([key, ch]) => [
                  key,
                  { ...ch, members: [] },
                ]),
              ),
            }
          : {}),
      }));
    },

    applyConversation(identityId, conversation) {
      patch(identityId, (session) => {
        if (conversation.kind === "channel") {
          const key = conversation.channelKey ?? "";
          const existing = session.channels[key];
          const channel: ChannelView = existing
            ? {
                ...existing,
                convId: conversation.id,
                title: conversation.title,
                joined: conversation.joined,
                pinned: conversation.pinned,
                lastReadMessageId: conversation.lastReadMessageId,
              }
            : {
                convId: conversation.id,
                key,
                title: conversation.title,
                description: "",
                mode: "both",
                oplist: [],
                members: [],
                seen: [],
                joined: conversation.joined,
                pinned: conversation.pinned,
                unread: 0,
                mentions: 0,
                highlightedAt: 0,
                lastReadMessageId: conversation.lastReadMessageId,
              };
          // The read cursor moved (this tab's ack or another's): drop the
          // badges — anything above the cursor is what the counters count.
          if (
            existing &&
            (conversation.lastReadMessageId ?? 0) >
              (existing.lastReadMessageId ?? 0)
          ) {
            channel.unread = 0;
            channel.mentions = 0;
            channel.highlightedAt = 0;
          }
          return {
            ...session,
            channels: { ...session.channels, [key]: channel },
            channelByConvId: {
              ...session.channelByConvId,
              [conversation.id]: key,
            },
          };
        }
        // For PMs the joined flag is the "window open" bit: pm.close drops
        // it (fan-out and ack both land here), removing the DM everywhere.
        if (!conversation.joined) {
          if (!(conversation.id in session.dms)) {
            return session;
          }
          const dms = { ...session.dms };
          delete dms[conversation.id];
          return { ...session, dms };
        }
        const existing = session.dms[conversation.id];
        // Serve-time presence (pm.open) seeds a fresh row's dot immediately
        // (#229); live NLN/STA keep folding through applyPresence afterwards.
        const presence = conversation.presence;
        const dm: DmView = existing
          ? {
              ...existing,
              title: conversation.title,
              pinned: conversation.pinned,
              lastReadMessageId: conversation.lastReadMessageId,
              ...(presence
                ? {
                    online: presence.online,
                    status: presence.status,
                    statusmsg: presence.statusmsg,
                  }
                : {}),
              ...((conversation.lastReadMessageId ?? 0) >
              (existing.lastReadMessageId ?? 0)
                ? { unread: 0, highlightedAt: 0 }
                : {}),
            }
          : {
              convId: conversation.id,
              partner: conversation.partnerCharacter ?? "",
              title: conversation.title,
              online: presence?.online ?? false,
              status: presence?.status ?? "",
              statusmsg: presence?.statusmsg ?? "",
              pinned: conversation.pinned,
              typing: "clear",
              unread: 0,
              highlightedAt: 0,
              lastReadMessageId: conversation.lastReadMessageId,
            };
        return { ...session, dms: { ...session.dms, [conversation.id]: dm } };
      });
    },

    applyMemberJoin(identityId, channelKey, member) {
      patchChannel(identityId, channelKey, (channel) => ({
        ...channel,
        // Set add: at-least-once delivery means a duplicate join must be a
        // no-op (gateway.ts contract).
        members: channel.members.some((m) => m.character === member.character)
          ? channel.members
          : [...channel.members, member],
        // A rejoin moves the nick out of "Seen recently" — never in both.
        seen: withoutSeen(channel.seen, member.character),
      }));
    },

    applyMemberLeave(identityId, channelKey, character) {
      const self = get().sessions[identityId]?.character ?? "";
      patchChannel(identityId, channelKey, (channel) =>
        sameCharacter(character, self)
          ? { ...channel, members: [] } // our own leave — the live list is gone
          : moveMemberToSeen(channel, character),
      );
    },

    applyChannelMembers(identityId, d) {
      patchChannel(identityId, d.key, (channel) => {
        // Present members leave the seen roster (never in both) — covers
        // rejoins folded into a full-state ICH overwrite.
        const present = new Set(
          d.members.map((m) => m.character.toLowerCase()),
        );
        return {
          ...channel,
          mode: d.mode,
          members: [...d.members],
          seen: channel.seen.filter(
            (entry) => !present.has(entry.character.toLowerCase()),
          ),
        };
      });
    },

    applyChannelInfo(identityId, d) {
      patchChannel(identityId, d.key, (channel) => ({
        ...channel,
        ...(d.title !== undefined ? { title: d.title } : {}),
        ...(d.description !== undefined ? { description: d.description } : {}),
        ...(d.mode !== undefined ? { mode: d.mode } : {}),
        ...(d.oplist !== undefined ? { oplist: [...d.oplist] } : {}),
      }));
    },

    applyPresence(identityId, d) {
      patch(identityId, (session) => {
        let channels = session.channels;
        if (!d.online) {
          // FLN is a global leave: the character drops out of every channel.
          channels = Object.fromEntries(
            Object.entries(channels).map(([key, ch]) => [
              key,
              ch.members.some((m) => m.character === d.character)
                ? moveMemberToSeen(ch, d.character)
                : ch,
            ]),
          );
        } else {
          channels = Object.fromEntries(
            Object.entries(channels).map(([key, ch]) => [
              key,
              {
                ...ch,
                members: ch.members.map((m) =>
                  m.character === d.character
                    ? {
                        ...m,
                        gender: d.gender ?? m.gender,
                        status: d.status ?? m.status,
                        statusmsg: d.statusmsg ?? m.statusmsg,
                      }
                    : m,
                ),
              },
            ]),
          );
        }
        const dms = Object.fromEntries(
          Object.entries(session.dms).map(([convId, dm]) => [
            convId,
            sameCharacter(dm.partner, d.character)
              ? {
                  ...dm,
                  online: d.online,
                  status: d.online ? (d.status ?? dm.status) : "",
                  statusmsg: d.online ? (d.statusmsg ?? dm.statusmsg) : "",
                }
              : dm,
          ]),
        );
        // Our own STA (set from any tab, or restored after a reconnect)
        // converges the MeBar/rail status everywhere.
        const own =
          d.online && sameCharacter(d.character, session.character)
            ? {
                ownStatus: d.status ?? session.ownStatus,
                ownStatusmsg: d.statusmsg ?? session.ownStatusmsg,
              }
            : {};
        // Bookmark/friend rows track the same global NLN/FLN/STA stream —
        // presence there must never freeze at fetch time (#218).
        const social = session.social
          ? patchSocialPresence(session.social, d)
          : undefined;
        return {
          ...session,
          channels,
          dms,
          ...own,
          ...(social ? { social } : {}),
        };
      });
    },

    applyPresenceBulk(identityId, characters) {
      patch(identityId, (session) => {
        const byLower = new Map(
          characters.map(([name, gender, status, statusmsg]) => [
            name.toLowerCase(),
            { gender, status, statusmsg },
          ]),
        );
        const dms = Object.fromEntries(
          Object.entries(session.dms).map(([convId, dm]) => {
            const presence = byLower.get(dm.partner.toLowerCase());
            return [
              convId,
              presence
                ? {
                    ...dm,
                    online: true,
                    status: presence.status,
                    statusmsg: presence.statusmsg,
                  }
                : dm,
            ];
          }),
        );
        const social = session.social
          ? {
              ...session.social,
              bookmarks: session.social.bookmarks.map((row) =>
                bulkRow(row, byLower),
              ),
              friends: session.social.friends.map((row) =>
                bulkRow(row, byLower),
              ),
            }
          : undefined;
        return { ...session, dms, ...(social ? { social } : {}) };
      });
    },

    applyTyping(identityId, character, status) {
      patch(identityId, (session) => ({
        ...session,
        dms: Object.fromEntries(
          Object.entries(session.dms).map(([convId, dm]) => [
            convId,
            sameCharacter(dm.partner, character)
              ? { ...dm, typing: status }
              : dm,
          ]),
        ),
      }));
    },

    applyNotice(identityId, kind, text) {
      patch(identityId, (session) => ({
        ...session,
        notice: { kind, text },
      }));
    },

    addInvite(identityId, invite) {
      patch(identityId, (session) => ({
        ...session,
        // Re-invites to the same room replace instead of stacking.
        invites: [
          ...session.invites.filter((entry) => entry.key !== invite.key),
          invite,
        ],
      }));
    },
    dismissInvite(identityId, key) {
      patch(identityId, (session) => ({
        ...session,
        invites: session.invites.filter((entry) => entry.key !== key),
      }));
    },
    clearNotice(identityId) {
      patch(identityId, (session) => ({ ...session, notice: undefined }));
    },

    bumpUnread(identityId, convId, mention = false) {
      patch(identityId, (session) => {
        const key = session.channelByConvId[convId];
        if (key !== undefined && session.channels[key]) {
          const channel = session.channels[key];
          return {
            ...session,
            channels: {
              ...session.channels,
              [key]: {
                ...channel,
                unread: channel.unread + 1,
                mentions: channel.mentions + (mention ? 1 : 0),
              },
            },
          };
        }
        const dm = session.dms[convId];
        if (dm) {
          return {
            ...session,
            dms: {
              ...session.dms,
              [convId]: { ...dm, unread: dm.unread + 1 },
            },
          };
        }
        return session;
      });
    },

    bumpHighlight(identityId, convId) {
      const stamp = Date.now();
      patch(identityId, (session) => {
        const key = session.channelByConvId[convId];
        if (key !== undefined && session.channels[key]) {
          return {
            ...session,
            channels: {
              ...session.channels,
              [key]: { ...session.channels[key], highlightedAt: stamp },
            },
          };
        }
        const dm = session.dms[convId];
        if (dm) {
          return {
            ...session,
            dms: { ...session.dms, [convId]: { ...dm, highlightedAt: stamp } },
          };
        }
        return session;
      });
    },

    clearUnread(identityId, convId) {
      patch(identityId, (session) => {
        const key = session.channelByConvId[convId];
        if (key !== undefined && session.channels[key]) {
          const channel = session.channels[key];
          if (
            channel.unread === 0 &&
            channel.mentions === 0 &&
            channel.highlightedAt === 0
          ) {
            return session;
          }
          return {
            ...session,
            channels: {
              ...session.channels,
              [key]: { ...channel, unread: 0, mentions: 0, highlightedAt: 0 },
            },
          };
        }
        const dm = session.dms[convId];
        if (dm && (dm.unread > 0 || dm.highlightedAt > 0)) {
          return {
            ...session,
            dms: {
              ...session.dms,
              [convId]: { ...dm, unread: 0, highlightedAt: 0 },
            },
          };
        }
        return session;
      });
    },

    reset() {
      set({ identities: undefined, sessions: {} });
    },
  };
});
