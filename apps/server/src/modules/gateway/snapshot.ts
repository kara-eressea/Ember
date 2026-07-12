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
} from "@emberline/protocol";
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

/** The identity's conversation ids among `convIds` — resume cursors for
 * anything else (foreign or deleted conversations) are silently dropped. */
export async function ownedConversationIds(
  db: Db,
  identityId: string,
  convIds: string[],
): Promise<Set<string>> {
  if (convIds.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.identityId, identityId));
  const owned = new Set(rows.map((r) => r.id));
  return new Set(convIds.filter((id) => owned.has(id)));
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
