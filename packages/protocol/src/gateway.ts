// EmberChat gateway protocol (architecture.md §WebSocket /gateway).
//
// Envelope both directions: `{ t, id?, d? }` — `id` is a client request id,
// echoed in the server's ack. Client→server frames are zod-validated (the
// server never trusts a browser); server→client frames are plain types (the
// client trusts the server).

import { z } from "zod";
import {
  CLIENT_SETTABLE_STATUSES,
  TYPING_STATUSES,
} from "@emberchat/fchat-protocol";
import { FLIST_NAME_RE } from "./highlights.js";
import { userPrefsPatchSchema, type UserPrefs } from "./prefs.js";

// Re-exported so gateway consumers (the web app) can render status pickers
// without a direct fchat-protocol dependency.
export { CLIENT_SETTABLE_STATUSES, TYPING_STATUSES };
export type { ClientSettableStatus } from "@emberchat/fchat-protocol";

/** Exchanged in the hello handshake; bump on breaking protocol changes. */
export const PROTOCOL_VERSION = 1;

/** WebSocket close codes used by the gateway (4000–4999 = application). */
export const GATEWAY_CLOSE = {
  /** Malformed frame before the connection was established. */
  badRequest: 4400,
  /** hello token rejected. */
  unauthorized: 4401,
  /** No hello within the handshake window. */
  helloTimeout: 4408,
  /** hello protocolVersion does not match the server's. */
  versionMismatch: 4426,
  /** Send buffer overflow — the client cannot keep up with the fan-out. */
  slowConsumer: 4429,
  /** Inbound frame quota exceeded. */
  rateLimited: 4430,
  /** Browser Origin header not on the instance's allow-list. */
  badOrigin: 4403,
} as const;

/** The F-List character-name charset (FLIST_NAME_RE, highlights.ts). */
const characterName = z.string().min(1).max(64).regex(FLIST_NAME_RE);

// ── Client → server ──────────────────────────────────────────────────────────

/** Per-identity durable-resume cursors: conversationId → last seen messages.id. */
const resumeSchema = z
  .record(
    z.uuid(),
    z
      .object({
        convCursors: z.record(z.uuid(), z.number().int().positive()),
      })
      .refine((entry) => Object.keys(entry.convCursors).length <= 1024, {
        message: "too many conversation cursors",
      }),
  )
  .refine((resume) => Object.keys(resume).length <= 64, {
    message: "too many identities",
  });

/**
 * Gateway commands (M1 core + M2 `conv.pin` + M3 `status.set`/
 * `ignore.add/remove` + M4 `msg.send` markdown, `outbox.recall`,
 * `prefs.set`, `typing.set`).
 */
const cmdSchema = z.discriminatedUnion("action", [
  z.object({
    identityId: z.uuid(),
    action: z.literal("ignore.add"),
    d: z.object({ character: characterName }),
  }),
  z.object({
    identityId: z.uuid(),
    action: z.literal("ignore.remove"),
    d: z.object({ character: characterName }),
  }),
  z.object({
    identityId: z.uuid(),
    action: z.literal("status.set"),
    // "crown" is server-set (RWD), deliberately not settable. The 255 cap is
    // the official client's status-message limit (no VAR exists for it).
    d: z.object({
      status: z.enum(CLIENT_SETTABLE_STATUSES),
      statusmsg: z.string().max(255),
    }),
  }),
  z.object({
    identityId: z.uuid(),
    action: z.literal("session.connect"),
  }),
  z.object({
    identityId: z.uuid(),
    action: z.literal("session.disconnect"),
  }),
  z.object({
    identityId: z.uuid(),
    action: z.literal("channel.join"),
    d: z.object({ key: z.string().min(1).max(128) }),
  }),
  z.object({
    identityId: z.uuid(),
    action: z.literal("channel.leave"),
    d: z.object({ key: z.string().min(1).max(128) }),
  }),
  z.object({
    identityId: z.uuid(),
    // CCR: the title of the new private room (the server mints the ADH- id;
    // 64 is the wire's channel-title ceiling — ERR 67 past it).
    action: z.literal("channel.create"),
    d: z.object({ title: z.string().min(1).max(64) }),
  }),
  z.object({
    identityId: z.uuid(),
    action: z.literal("channel.invite"),
    d: z.object({ key: z.string().min(1).max(128), character: characterName }),
  }),
  z.object({
    identityId: z.uuid(),
    // RST: public = listed + freely joinable, private = unlisted + invite-only.
    action: z.literal("channel.status"),
    d: z.object({
      key: z.string().min(1).max(128),
      status: z.enum(["public", "private"]),
    }),
  }),
  // ── Channel moderation (M6 op tooling). All chanop-restricted on the
  // wire; the UI additionally gates by viewer role. Errors come back as
  // ERR events, SYS acks as persisted SystemLines.
  z.object({
    identityId: z.uuid(),
    action: z.literal("channel.kick"),
    d: z.object({ key: z.string().min(1).max(128), character: characterName }),
  }),
  z.object({
    identityId: z.uuid(),
    action: z.literal("channel.ban"),
    d: z.object({ key: z.string().min(1).max(128), character: characterName }),
  }),
  z.object({
    identityId: z.uuid(),
    action: z.literal("channel.unban"),
    d: z.object({ key: z.string().min(1).max(128), character: characterName }),
  }),
  z.object({
    identityId: z.uuid(),
    // CTU: the wire caps timeouts at 1-90 minutes.
    action: z.literal("channel.timeout"),
    d: z.object({
      key: z.string().min(1).max(128),
      character: characterName,
      minutes: z.number().int().min(1).max(90),
    }),
  }),
  z.object({
    identityId: z.uuid(),
    action: z.literal("channel.promote"),
    d: z.object({ key: z.string().min(1).max(128), character: characterName }),
  }),
  z.object({
    identityId: z.uuid(),
    action: z.literal("channel.demote"),
    d: z.object({ key: z.string().min(1).max(128), character: characterName }),
  }),
  z.object({
    identityId: z.uuid(),
    // CSO: hand the room to a new owner (current owner only).
    action: z.literal("channel.owner"),
    d: z.object({ key: z.string().min(1).max(128), character: characterName }),
  }),
  z.object({
    identityId: z.uuid(),
    // CDS: change the room description (chanop).
    action: z.literal("channel.describe"),
    d: z.object({
      key: z.string().min(1).max(128),
      description: z.string().max(50_000),
    }),
  }),
  z.object({
    identityId: z.uuid(),
    // RMO: room mode — chat (MSG only), ads (LRP only), or both.
    action: z.literal("channel.mode"),
    d: z.object({
      key: z.string().min(1).max(128),
      mode: z.enum(["chat", "ads", "both"]),
    }),
  }),
  z.object({
    identityId: z.uuid(),
    // CBL: the banlist arrives as a channel SYS (persisted SystemLine).
    action: z.literal("channel.banlist"),
    d: z.object({ key: z.string().min(1).max(128) }),
  }),
  z.object({
    identityId: z.uuid(),
    action: z.literal("msg.send"),
    // The live chat_max/priv_max/lfrp_max VARs are enforced by the session
    // at send time; this is only an anti-abuse ceiling, far above any real
    // limit. `markdown` is the pre-translation source: stored with a delayed
    // send so ArrowUp recall returns what the user typed, not the wire form.
    // kind "lrp" = a roleplay ad (channel conversations only).
    d: z.object({
      convId: z.uuid(),
      bbcode: z.string().min(1).max(65_536),
      markdown: z.string().max(65_536).optional(),
      kind: z.enum(["msg", "lrp"]).optional(),
    }),
  }),
  z.object({
    identityId: z.uuid(),
    // RLL: "bottle" or a dice expression ("2d6", "1d20+5", …). The server
    // validates the grammar and broadcasts the computed result.
    action: z.literal("channel.roll"),
    d: z.object({
      key: z.string().min(1).max(128),
      dice: z.string().min(1).max(128),
    }),
  }),
  z.object({
    identityId: z.uuid(),
    // Alert Staff (SFC): report a character to F-List's global moderators.
    // The report text is composed client-side (official-client shape:
    // tab + reported user + complaint); logs cannot be uploaded by
    // third-party clients, so the text is the whole report.
    action: z.literal("user.report"),
    d: z.object({
      character: characterName,
      report: z.string().min(1).max(4096),
    }),
  }),
  z.object({
    identityId: z.uuid(),
    // PM typing telemetry (TPN). Channels have no typing on F-Chat.
    action: z.literal("typing.set"),
    d: z.object({
      character: characterName,
      status: z.enum(TYPING_STATUSES),
    }),
  }),
  z.object({
    identityId: z.uuid(),
    action: z.literal("outbox.recall"),
    d: z.object({ outboxId: z.uuid() }),
  }),
  z.object({
    identityId: z.uuid(),
    // Per-user (not per-identity) preferences; identityId routes the ack.
    // `prefs` is a shallow patch — only the supplied keys change (M5).
    action: z.literal("prefs.set"),
    d: z
      .object({
        sendDelaySeconds: z.number().int().min(0).max(300).optional(),
        prefs: userPrefsPatchSchema.optional(),
      })
      .refine(
        (d) => d.sendDelaySeconds !== undefined || d.prefs !== undefined,
        { message: "empty prefs patch" },
      ),
  }),
  z.object({
    identityId: z.uuid(),
    action: z.literal("pm.open"),
    d: z.object({ character: characterName }),
  }),
  z.object({
    identityId: z.uuid(),
    action: z.literal("conv.pin"),
    d: z.object({ convId: z.uuid(), pinned: z.boolean() }),
  }),
]);

export const clientFrameSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    d: z.object({
      token: z.string().min(1),
      protocolVersion: z.number().int(),
      resume: resumeSchema.optional(),
    }),
  }),
  z.object({ t: z.literal("sub"), d: z.object({ identityId: z.uuid() }) }),
  z.object({ t: z.literal("unsub"), d: z.object({ identityId: z.uuid() }) }),
  z.object({
    t: z.literal("cmd"),
    id: z.number().int().optional(),
    d: cmdSchema,
  }),
  z.object({
    t: z.literal("ack"),
    d: z.object({
      identityId: z.uuid(),
      convId: z.uuid(),
      messageId: z.number().int().positive(),
    }),
  }),
  z.object({ t: z.literal("ping") }),
]);

export type ClientFrame = z.infer<typeof clientFrameSchema>;
export type GatewayCmd = z.infer<typeof cmdSchema>;
export type ResumeCursors = z.infer<typeof resumeSchema>;

// ── Shared DTOs ──────────────────────────────────────────────────────────────

/** FchatSession status, plus "offline" for identities with no session at all. */
export type GatewaySessionStatus =
  | "offline"
  | "idle"
  | "acquiring_ticket"
  | "connecting"
  | "identifying"
  | "online"
  | "backoff"
  | "stopped";

export interface MemberDto {
  character: string;
  gender: string;
  status: string;
  statusmsg: string;
}

export interface ConversationDto {
  id: string;
  kind: "channel" | "pm";
  channelKey: string | null;
  partnerCharacter: string | null;
  title: string;
  pinned: boolean;
  joined: boolean;
  lastReadMessageId: number | null;
}

export interface MessageDto {
  /** messages.id — the durable resume cursor. */
  id: number;
  senderCharacter: string;
  kind: "msg" | "lrp" | "rll" | "sys" | "pm";
  bbcode: string;
  sentByUs: boolean;
  /** Stamped at persist time by the server-side highlight matcher (own
   * nick + the user's rules) — the client never re-matches. */
  mention: boolean;
  /** ISO timestamp. */
  createdAt: string;
}

/** A message waiting in the delayed-send outbox (M4). */
export interface OutboxItemDto {
  id: string;
  convId: string;
  /** What the user typed — ArrowUp recall returns this to the composer. */
  markdown: string;
  /** The translated wire form that will be sent at release. */
  bbcode: string;
  /** ISO timestamp of the scheduled release. */
  releaseAt: string;
  /** ISO timestamp of the send — ArrowUp recalls the newest-created. */
  createdAt: string;
  state: "scheduled" | "failed";
  /** Why a failed row failed, for the pending-row label. */
  failureReason?: string;
}

export interface SnapshotChannel {
  convId: string;
  key: string;
  title: string;
  description: string;
  mode: string;
  /** First entry is the owner (may be ""). */
  oplist: string[];
  /** Empty while the session is not online. */
  members: MemberDto[];
  joined: boolean;
  pinned: boolean;
  unread: number;
  /** Unread inbound messages matching the identity's character name (word
   * boundary, case-insensitive; M5 highlight rules extend this). Counted
   * within the same capped window as `unread`. DMs carry no mention count —
   * every DM is already directed at the user. */
  mentions: number;
  lastReadMessageId: number | null;
}

export interface SnapshotDm {
  convId: string;
  partner: string;
  title: string;
  online: boolean;
  status: string;
  statusmsg: string;
  pinned: boolean;
  unread: number;
  lastReadMessageId: number | null;
}

// ── Server → client ──────────────────────────────────────────────────────────

/**
 * Volatile per-identity events fanned out from the live session.
 *
 * Delivery is at-least-once around a `snapshot`: events that land while the
 * snapshot is being built are already reflected in it AND replayed after it.
 * Every volatile kind is therefore an idempotent state operation — presence,
 * channel.info and channel.members are full-state overwrites; member.join /
 * member.leave are set add/remove (clients MUST treat member lists as sets).
 * Only message.new is exactly-once (deduped server-side by messages.id).
 */
export type GatewayEvent =
  | {
      kind: "message.new";
      d: { convId: string; message: MessageDto };
    }
  | { kind: "conversation.updated"; d: { conversation: ConversationDto } }
  | { kind: "member.join"; d: { channelKey: string; member: MemberDto } }
  | { kind: "member.leave"; d: { channelKey: string; character: string } }
  | {
      kind: "channel.members";
      d: { key: string; mode: string; members: MemberDto[] };
    }
  | {
      kind: "channel.info";
      d: {
        key: string;
        title?: string;
        description?: string;
        mode?: string;
        oplist?: string[];
      };
    }
  | {
      kind: "presence";
      d: {
        character: string;
        online: boolean;
        gender?: string;
        status?: string;
        statusmsg?: string;
      };
    }
  | {
      kind: "presence.bulk";
      /** One LIS roster batch ([name, gender, status, statusmsg]) — the
       * already-online world streams in AFTER identify, so a snapshot taken
       * while it streams would otherwise show everyone offline until their
       * next status change. */
      d: { characters: [string, string, string, string][] };
    }
  | {
      kind: "channel.invite";
      /** Inbound CIU: `sender` invited this identity to room `key`
       * (ADH- id), displayed as `title`. Volatile — an invite missed while
       * detached is joinable later via the key anyway. */
      d: { sender: string; title: string; key: string };
    }
  | { kind: "typing"; d: { character: string; status: string } }
  | {
      kind: "session.status";
      d: { status: GatewaySessionStatus; reason?: string };
    }
  | { kind: "identity.updated"; d: { autoConnect: boolean } }
  | {
      kind: "ignore.updated";
      /** The full ignore list after a change (IGN init/add/delete) — an
       * idempotent overwrite like every other volatile event. */
      d: { characters: string[] };
    }
  | {
      kind: "identities.reordered";
      /** The user's full identity order (rail order). Broadcast to every
       * identity's subscribers, so a tab subscribed to all of them applies
       * the same order several times — idempotent by construction. */
      d: { order: string[] };
    }
  | {
      kind: "outbox.updated";
      /** The identity's full pending outbox after any change (schedule,
       * release, recall, failure) — an idempotent overwrite that keeps
       * every attached device's pending indicators in sync. */
      d: { items: OutboxItemDto[] };
    }
  | {
      kind: "prefs.updated";
      /** Per-user preference change, broadcast to each identity's
       * subscribers (idempotent duplicates across identities). Carries the
       * full resolved state after the patch — an idempotent overwrite. */
      d: { sendDelaySeconds: number; prefs: UserPrefs };
    }
  | { kind: "sys"; d: { message: string } }
  // Real-time bridge: website events (notes, friend requests, comment
  // replies) pushed over the chat socket. Volatile — the website remains
  // the place to read/act; the client surfaces a notice + notification.
  | {
      kind: "rtb";
      d: { type: string; character?: string; subject?: string };
    }
  | { kind: "error"; d: { number: number; message: string } };

export type ServerFrame =
  | {
      t: "ready";
      d: {
        userId: string;
        identities: {
          id: string;
          name: string;
          sessionStatus: GatewaySessionStatus;
          /** Intent flag: this identity should be online when possible.
           * Maintained implicitly — set by identity creation and explicit
           * session.connect, cleared by explicit session.disconnect. Unlock
           * reconnects every autoConnect identity on the account. */
          autoConnect: boolean;
          /** Badge totals across the identity's conversations, so the rail
           * paints before (or without) a sub. Sums of the same capped
           * per-conversation windows the snapshot counts — a signal, not an
           * exact figure; the client clamps display at 99+. Kept live
           * client-side by aggregating subscribed slices; these are the
           * initial values. */
          unread: number;
          mentions: number;
        }[];
      };
    }
  | {
      t: "snapshot";
      d: {
        identityId: string;
        self: {
          character: string;
          sessionStatus: GatewaySessionStatus;
          /** Our own F-Chat status (the session's desired status — restored
           * across reconnects). "online"/"" while no session is live. */
          status: string;
          statusmsg: string;
          /** The identity's ignore list (persisted mirror — served with or
           * without a live session). Messages from these characters are
           * hidden from render client-side but still persisted. */
          ignores: string[];
          /** Live server VARs (bytes) — composer limits, never hardcoded. */
          limits: { chatMax: number; privMax: number; lfrpMax: number };
          /** Channels where the server disallows [icon]/[eicon] (the
           * icon_blacklist VAR) — the composer warns before inserting. */
          iconBlacklist: string[];
          /** Own character is a chatop (global moderator, ADL at login) —
           * unlocks the admin UI everywhere. Snapshot-only: promotions are
           * rare enough that a reconnect picking it up is fine. */
          chatop: boolean;
          /** The user's delayed-send window (user_preferences). */
          sendDelaySeconds: number;
          /** The user's resolved preferences (user_preferences.prefs). */
          prefs: UserPrefs;
          /** Messages still waiting in the delayed-send outbox. */
          outbox: OutboxItemDto[];
        };
        channels: SnapshotChannel[];
        dms: SnapshotDm[];
      };
    }
  | { t: "event"; d: { identityId: string } & GatewayEvent }
  | {
      t: "catchup";
      d: {
        identityId: string;
        convId: string;
        messages: MessageDto[];
        done: boolean;
      };
    }
  | {
      t: "ack";
      id: number;
      d: {
        ok: boolean;
        error?: string;
        /** pm.open / conv.pin result: the affected conversation row. */
        conversation?: ConversationDto;
        /** outbox.recall result: what the user typed, back to the composer. */
        markdown?: string;
      };
    }
  | { t: "pong" }
  | { t: "error"; d: { message: string } };
