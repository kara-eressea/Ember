// Per-identity live session state (architecture.md §Client, COMPONENTS.md
// state model): channels with member lists, DM rows with presence, session
// status. Mutated only by gateway/dispatch.ts applying server frames — the
// gateway protocol documents volatile events as at-least-once idempotent
// state operations, so every mutation here is an overwrite or a set
// add/remove, never a counter increment keyed to event arrival.

import { create } from "zustand";
import type {
  ConversationDto,
  GatewaySessionStatus,
  MemberDto,
  SnapshotChannel,
  SnapshotDm,
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
  joined: boolean;
  unread: number;
  /** Unread messages naming this identity (server-counted at snapshot). */
  mentions: number;
  lastReadMessageId: number | null;
}

export interface DmView {
  convId: string;
  partner: string;
  title: string;
  online: boolean;
  status: string;
  statusmsg: string;
  /** TPN state: "typing" | "paused" | "clear". */
  typing: string;
  unread: number;
  lastReadMessageId: number | null;
}

export interface IdentitySession {
  identityId: string;
  character: string;
  sessionStatus: GatewaySessionStatus;
  statusReason?: string;
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
}

export interface IdentitySummary {
  id: string;
  name: string;
  /** Connect intent — gates the shell's connect-on-visit. The server
   * maintains it (connect sets, disconnect clears); mirrored locally when
   * this tab issues the cmd, and re-synced by the next ready frame. */
  autoConnect: boolean;
}

interface SessionsState {
  /** From the ready frame — everything the app account owns. */
  identities: IdentitySummary[] | undefined;
  sessions: Record<string, IdentitySession>;

  applyReady(identities: IdentitySummary[]): void;
  setAutoConnect(identityId: string, value: boolean): void;
  applySnapshot(d: {
    identityId: string;
    self: { character: string; sessionStatus: GatewaySessionStatus };
    channels: SnapshotChannel[];
    dms: SnapshotDm[];
  }): void;
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
  applyTyping(identityId: string, character: string, status: string): void;
  applyNotice(identityId: string, kind: "sys" | "error", text: string): void;
  clearNotice(identityId: string): void;
  bumpUnread(identityId: string, convId: string): void;
  clearUnread(identityId: string, convId: string): void;
  reset(): void;
}

function emptySession(identityId: string): IdentitySession {
  return {
    identityId,
    character: "",
    sessionStatus: "offline",
    channels: {},
    dms: {},
    channelByConvId: {},
    synced: false,
  };
}

/** F-Chat resolves character names case-insensitively (PM merge semantics). */
function sameCharacter(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
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
        joined: false,
        unread: 0,
        mentions: 0,
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

    setAutoConnect(identityId, value) {
      set((state) => ({
        identities: state.identities?.map((identity) =>
          identity.id === identityId
            ? { ...identity, autoConnect: value }
            : identity,
        ),
      }));
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
        };
        channelByConvId[ch.convId] = ch.key;
      }
      const dms: Record<string, DmView> = {};
      for (const dm of d.dms) {
        dms[dm.convId] = { ...dm, typing: "clear" };
      }
      patch(d.identityId, (session) => ({
        ...session,
        character: d.self.character,
        sessionStatus: d.self.sessionStatus,
        channels,
        dms,
        channelByConvId,
        synced: true,
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
                joined: conversation.joined,
                unread: 0,
                mentions: 0,
                lastReadMessageId: conversation.lastReadMessageId,
              };
          // The read cursor moved (this tab's ack or another's): drop the
          // badge — anything above the cursor is what unread counts.
          if (
            existing &&
            (conversation.lastReadMessageId ?? 0) >
              (existing.lastReadMessageId ?? 0)
          ) {
            channel.unread = 0;
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
        const existing = session.dms[conversation.id];
        const dm: DmView = existing
          ? {
              ...existing,
              title: conversation.title,
              lastReadMessageId: conversation.lastReadMessageId,
              unread:
                (conversation.lastReadMessageId ?? 0) >
                (existing.lastReadMessageId ?? 0)
                  ? 0
                  : existing.unread,
            }
          : {
              convId: conversation.id,
              partner: conversation.partnerCharacter ?? "",
              title: conversation.title,
              online: false,
              status: "",
              statusmsg: "",
              typing: "clear",
              unread: 0,
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
      }));
    },

    applyMemberLeave(identityId, channelKey, character) {
      const self = get().sessions[identityId]?.character ?? "";
      patchChannel(identityId, channelKey, (channel) => ({
        ...channel,
        members: sameCharacter(character, self)
          ? [] // our own leave — the whole live list is gone
          : channel.members.filter((m) => m.character !== character),
      }));
    },

    applyChannelMembers(identityId, d) {
      patchChannel(identityId, d.key, (channel) => ({
        ...channel,
        mode: d.mode,
        members: [...d.members],
      }));
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
                ? {
                    ...ch,
                    members: ch.members.filter(
                      (m) => m.character !== d.character,
                    ),
                  }
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
        return { ...session, channels, dms };
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

    clearNotice(identityId) {
      patch(identityId, (session) => ({ ...session, notice: undefined }));
    },

    bumpUnread(identityId, convId) {
      patch(identityId, (session) => {
        const key = session.channelByConvId[convId];
        if (key !== undefined && session.channels[key]) {
          const channel = session.channels[key];
          return {
            ...session,
            channels: {
              ...session.channels,
              [key]: { ...channel, unread: channel.unread + 1 },
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

    clearUnread(identityId, convId) {
      patch(identityId, (session) => {
        const key = session.channelByConvId[convId];
        if (key !== undefined && session.channels[key]) {
          const channel = session.channels[key];
          if (channel.unread === 0) {
            return session;
          }
          return {
            ...session,
            channels: {
              ...session.channels,
              [key]: { ...channel, unread: 0 },
            },
          };
        }
        const dm = session.dms[convId];
        if (dm && dm.unread > 0) {
          return {
            ...session,
            dms: { ...session.dms, [convId]: { ...dm, unread: 0 } },
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
