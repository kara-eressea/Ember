// Snapshot + catchup queries (architecture.md §Resume semantics). Volatile
// state (members, presence, modes) comes fresh from session-state on every
// sub; durable state (messages) resumes via per-conversation messages.id
// cursors read straight from the messages table — it *is* the resume log.

import { and, asc, count, eq, gt, sql } from "drizzle-orm";
import type {
  MemberDto,
  MessageDto,
  SnapshotChannel,
  SnapshotDm,
} from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import { conversations, messages } from "../../db/schema.js";
import type { MessageRow } from "../history/sink.js";
import type { FchatSession } from "../session-engine/fchat-session.js";
import type { SessionState } from "../session-engine/session-state.js";

/** Unread counts are capped server-side; the client renders 99 as "99+". */
export const UNREAD_CAP = 99;

export interface SnapshotData {
  channels: SnapshotChannel[];
  dms: SnapshotDm[];
}

export function memberDto(state: SessionState, character: string): MemberDto {
  const presence = state.characters.get(character);
  return {
    character,
    gender: presence?.gender ?? "",
    status: presence?.status ?? "",
    statusmsg: presence?.statusmsg ?? "",
  };
}

export function messageDto(row: MessageRow): MessageDto {
  return {
    id: row.id,
    senderCharacter: row.senderCharacter,
    kind: row.kind,
    bbcode: row.bbcode,
    sentByUs: row.sentByUs,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function buildSnapshot(
  db: Db,
  identityId: string,
  session: FchatSession | undefined,
): Promise<SnapshotData> {
  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.identityId, identityId))
    .orderBy(conversations.createdAt);

  const unreadRows = await db
    .select({ convId: messages.conversationId, unread: count() })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.identityId, identityId),
        gt(messages.id, sql`coalesce(${conversations.lastReadMessageId}, 0)`),
      ),
    )
    .groupBy(messages.conversationId);
  const unread = new Map(
    unreadRows.map((r) => [r.convId, Math.min(r.unread, UNREAD_CAP)]),
  );

  const channels: SnapshotChannel[] = [];
  const dms: SnapshotDm[] = [];
  for (const row of rows) {
    if (row.kind === "channel") {
      const key = row.channelKey ?? "";
      const state = session?.state;
      const live = state?.channels.get(key);
      channels.push({
        convId: row.id,
        key,
        title: live?.title ?? row.title,
        description: live?.description ?? "",
        mode: live?.mode ?? "both",
        oplist: live ? [...live.oplist] : [],
        members:
          live && state
            ? [...live.members].map((name) => memberDto(state, name))
            : [],
        joined: row.joined,
        unread: unread.get(row.id) ?? 0,
        lastReadMessageId: row.lastReadMessageId,
      });
    } else {
      const partner = row.partnerCharacter ?? "";
      const presence = session?.state.characters.get(partner);
      dms.push({
        convId: row.id,
        partner,
        title: row.title,
        online: presence !== undefined,
        status: presence?.status ?? "",
        statusmsg: presence?.statusmsg ?? "",
        unread: unread.get(row.id) ?? 0,
        lastReadMessageId: row.lastReadMessageId,
      });
    }
  }
  return { channels, dms };
}

export interface CatchupPlanEntry {
  convId: string;
  /** Replay strictly-after this messages.id. */
  afterId: number;
}

/**
 * Which conversations to replay on sub, and from where. Two regimes:
 *
 * - The client sent a cursor: it holds a contiguous buffer up to that id, so
 *   replay everything past it — this is the headline catch-up path. Cursors
 *   for foreign or deleted conversations are silently dropped (the plan is
 *   built from the identity's own rows).
 * - No cursor (conversation created or first seen while this client was
 *   detached, or a fresh device): replay only the unread tail — from
 *   lastReadMessageId, floored at `maxId - batchSize`. Ids are global across
 *   conversations, so that floor is an id-space bound: at most `batchSize`
 *   rows, usually fewer. A fully-read conversation replays nothing, and deep
 *   history stays with REST backfill on open; replaying from id 0 would
 *   stream entire histories to every new device.
 */
export async function catchupPlan(
  db: Db,
  identityId: string,
  cursors: Record<string, number>,
  batchSize: number,
): Promise<CatchupPlanEntry[]> {
  const rows = await db
    .select({
      id: conversations.id,
      lastRead: conversations.lastReadMessageId,
      maxId: sql<number>`coalesce(max(${messages.id}), 0)`,
    })
    .from(conversations)
    .leftJoin(messages, eq(messages.conversationId, conversations.id))
    .where(eq(conversations.identityId, identityId))
    .groupBy(conversations.id);

  const plan: CatchupPlanEntry[] = [];
  for (const row of rows) {
    const cursor = cursors[row.id];
    if (cursor !== undefined) {
      plan.push({ convId: row.id, afterId: cursor });
      continue;
    }
    const afterId = Math.max(row.lastRead ?? 0, row.maxId - batchSize);
    if (afterId < row.maxId) {
      plan.push({ convId: row.id, afterId });
    }
  }
  return plan;
}

/** One ascending catchup batch: messages strictly after the cursor. */
export async function fetchMessagesAfter(
  db: Db,
  conversationId: string,
  afterId: number,
  limit: number,
): Promise<MessageRow[]> {
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        gt(messages.id, afterId),
      ),
    )
    .orderBy(asc(messages.id))
    .limit(limit);
}
