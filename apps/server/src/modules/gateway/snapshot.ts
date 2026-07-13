// Snapshot + catchup queries (architecture.md §Resume semantics). Volatile
// state (members, presence, modes) comes fresh from session-state on every
// sub; durable state (messages) resumes via per-conversation messages.id
// cursors read straight from the messages table — it *is* the resume log.

import { and, asc, eq, gt, sql } from "drizzle-orm";
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

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Per-conversation unread + mention counts past the read cursor, computed in
 * one pass. The inner ORDER BY + LIMIT caps the rows *scanned* per
 * conversation at UNREAD_CAP, newest first (a deterministic window walking
 * the (conversation_id, id desc) index and stopping early) — a busy channel
 * with 40k unread costs the same as one with 99. Own sends never count as
 * unread (matching the client's live bump). Mentions are counted within the
 * same window: a word-boundary, case-insensitive match of the identity's
 * character name in inbound channel messages (M5 highlight rules will
 * extend the matcher). DMs carry no mention count — every DM is already
 * directed at the user.
 */
async function conversationCounts(
  db: Db,
  identityId: string,
  character: string,
): Promise<Map<string, { unread: number; mentions: number }>> {
  // Explicit ASCII word-boundary classes, NOT Postgres \m/\M: it keeps the
  // semantics byte-identical with the client matcher (lib/mention.ts, JS \w
  // is ASCII) and works for names with leading/trailing hyphens, which have
  // no \m/\M boundary at all. "Amber Vale" still never matches inside
  // "Amber Valery".
  const pattern = `(^|[^a-zA-Z0-9_])${escapeRegex(character)}([^a-zA-Z0-9_]|$)`;
  const result = await db.execute(sql`
    select c.id as conv_id,
           u.unread::int as unread,
           u.mentions::int as mentions
    from conversations c
    cross join lateral (
      select count(*) as unread,
             count(*) filter (where t.mention) as mentions
      from (
        select (m.kind = 'msg' and m.bbcode ~* ${pattern}) as mention
        from messages m
        where m.conversation_id = c.id
          and m.id > coalesce(c.last_read_message_id, 0)
          and not m.sent_by_us
        order by m.id desc
        limit ${UNREAD_CAP}
      ) t
    ) u
    where c.identity_id = ${identityId}
  `);
  const rows = result.rows as {
    conv_id: string;
    unread: number;
    mentions: number;
  }[];
  return new Map(
    rows.map((row) => [
      row.conv_id,
      { unread: row.unread, mentions: row.mentions },
    ]),
  );
}

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
  character: string,
  session: FchatSession | undefined,
): Promise<SnapshotData> {
  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.identityId, identityId))
    .orderBy(conversations.createdAt);

  const counts = await conversationCounts(db, identityId, character);

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
        pinned: row.pinned,
        unread: counts.get(row.id)?.unread ?? 0,
        mentions: counts.get(row.id)?.mentions ?? 0,
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
        pinned: row.pinned,
        unread: counts.get(row.id)?.unread ?? 0,
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
  // Correlated max, not a join+groupBy: O(1) per conversation via the
  // (conversation_id, id desc) index instead of aggregating every message
  // row the identity owns on each sub. Static identifiers on purpose —
  // drizzle renders interpolated columns in selected fields unqualified,
  // which mis-scopes the correlated outer reference. mapWith(Number)
  // because max(bigint) comes back from node-postgres as a string.
  const rows = await db
    .select({
      id: conversations.id,
      lastRead: conversations.lastReadMessageId,
      maxId:
        sql<number>`(select coalesce(max(m.id), 0) from messages m where m.conversation_id = conversations.id)`.mapWith(
          Number,
        ),
    })
    .from(conversations)
    .where(eq(conversations.identityId, identityId));

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
