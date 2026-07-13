// EmberChat gateway protocol (architecture.md §WebSocket /gateway).
//
// Envelope both directions: `{ t, id?, d? }` — `id` is a client request id,
// echoed in the server's ack. Client→server frames are zod-validated (the
// server never trusts a browser); server→client frames are plain types (the
// client trusts the server).

import { z } from "zod";

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
} as const;

/** Matches the F-List character-name charset (see chat3client avatarURL). */
const characterName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_\-\s]+$/);

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
 * Gateway commands, M1 subset. `status.set`, `typing.set` and
 * `ignore.add/remove` join in their milestones.
 */
const cmdSchema = z.discriminatedUnion("action", [
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
    action: z.literal("msg.send"),
    // The live chat_max/priv_max VARs are enforced by the session at send
    // time; this is only an anti-abuse ceiling, far above any real limit.
    d: z.object({ convId: z.uuid(), bbcode: z.string().min(1).max(65_536) }),
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
  /** ISO timestamp. */
  createdAt: string;
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
  | { kind: "typing"; d: { character: string; status: string } }
  | {
      kind: "session.status";
      d: { status: GatewaySessionStatus; reason?: string };
    }
  | { kind: "sys"; d: { message: string } }
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
        }[];
      };
    }
  | {
      t: "snapshot";
      d: {
        identityId: string;
        self: { character: string; sessionStatus: GatewaySessionStatus };
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
        /** pm.open result: the found-or-created conversation. */
        conversation?: ConversationDto;
      };
    }
  | { t: "pong" }
  | { t: "error"; d: { message: string } };
