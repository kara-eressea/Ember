// History REST: conversation list + cursor-paginated messages
// (architecture.md §REST). Cursor = messages.id (bigserial, arrival order):
// ?before=<msgId> walks toward older history, pages come back ascending so
// the client can prepend them directly.

import { Readable } from "node:stream";
import { and, desc, eq, gt, lt } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Db } from "../../db/index.js";
import {
  conversations,
  flistAccounts,
  identities,
  messages,
} from "../../db/schema.js";

const conversationResponse = z.object({
  id: z.string(),
  kind: z.enum(["channel", "pm"]),
  channelKey: z.string().nullable(),
  partnerCharacter: z.string().nullable(),
  title: z.string(),
  pinned: z.boolean(),
  joined: z.boolean(),
  lastReadMessageId: z.number().nullable(),
});

const messageResponse = z.object({
  id: z.number(),
  senderCharacter: z.string(),
  kind: z.enum(["msg", "lrp", "rll", "sys", "pm"]),
  bbcode: z.string(),
  sentByUs: z.boolean(),
  mention: z.boolean(),
  createdAt: z.date(),
});

const errorResponse = z.object({ error: z.string() });

export interface HistoryRoutesOptions {
  db: Db;
}

// eslint-disable-next-line @typescript-eslint/require-await -- fastify async plugin signature
export async function historyRoutes(
  instance: FastifyInstance,
  options: HistoryRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const { db } = options;

  app.addHook("preHandler", app.authenticate);

  /** The identity, only if it belongs to the requesting user. */
  async function findOwnedIdentity(identityId: string, userId: string) {
    const [row] = await db
      .select({ id: identities.id })
      .from(identities)
      .innerJoin(flistAccounts, eq(identities.flistAccountId, flistAccounts.id))
      .where(
        and(eq(identities.id, identityId), eq(flistAccounts.userId, userId)),
      )
      .limit(1);
    return row;
  }

  app.get(
    "/:identityId/conversations",
    {
      schema: {
        params: z.object({ identityId: z.uuid() }),
        response: {
          200: z.object({ conversations: z.array(conversationResponse) }),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const identity = await findOwnedIdentity(
        request.params.identityId,
        request.user.sub,
      );
      if (!identity) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      const rows = await db
        .select({
          id: conversations.id,
          kind: conversations.kind,
          channelKey: conversations.channelKey,
          partnerCharacter: conversations.partnerCharacter,
          title: conversations.title,
          pinned: conversations.pinned,
          joined: conversations.joined,
          lastReadMessageId: conversations.lastReadMessageId,
        })
        .from(conversations)
        .where(eq(conversations.identityId, identity.id))
        .orderBy(conversations.createdAt);
      return reply.send({ conversations: rows });
    },
  );

  app.get(
    "/:identityId/conversations/:conversationId/messages",
    {
      schema: {
        params: z.object({
          identityId: z.uuid(),
          conversationId: z.uuid(),
        }),
        querystring: z.object({
          /** Return messages with id strictly below this cursor. */
          before: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: {
          200: z.object({
            messages: z.array(messageResponse),
            hasMore: z.boolean(),
          }),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const identity = await findOwnedIdentity(
        request.params.identityId,
        request.user.sub,
      );
      if (!identity) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      const [conversation] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, request.params.conversationId),
            eq(conversations.identityId, identity.id),
          ),
        )
        .limit(1);
      if (!conversation) {
        return reply.code(404).send({ error: "Conversation not found" });
      }

      const { before, limit } = request.query;
      // limit+1 newest-first tells us whether older history remains; the
      // page itself is returned ascending for direct prepending.
      const page = await db
        .select({
          id: messages.id,
          senderCharacter: messages.senderCharacter,
          kind: messages.kind,
          bbcode: messages.bbcode,
          sentByUs: messages.sentByUs,
          mention: messages.mention,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversation.id),
            before === undefined ? undefined : lt(messages.id, before),
          ),
        )
        .orderBy(desc(messages.id))
        .limit(limit + 1);
      const hasMore = page.length > limit;
      return reply.send({
        messages: page.slice(0, limit).reverse(),
        hasMore,
      });
    },
  );

  // Log export (M5, developer policy: log location must be known and
  // accessible to the user). Whole-conversation download, ascending, as
  // .txt / .html / .json — streamed in id-keyset pages (M7), so a years-long
  // log never materializes in memory.
  app.get(
    "/:identityId/conversations/:conversationId/export",
    {
      // Streaming still reads the whole conversation from Postgres — the
      // limit keeps repeated large exports from monopolizing the pool.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        params: z.object({
          identityId: z.uuid(),
          conversationId: z.uuid(),
        }),
        querystring: z.object({
          format: z.enum(["txt", "html", "json"]),
        }),
        // No response schema: the 200 body is a raw text/html/json document,
        // not a JSON-serialized object.
      },
    },
    async (request, reply) => {
      const identity = await findOwnedIdentity(
        request.params.identityId,
        request.user.sub,
      );
      if (!identity) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      const [conversation] = await db
        .select({
          id: conversations.id,
          kind: conversations.kind,
          title: conversations.title,
        })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, request.params.conversationId),
            eq(conversations.identityId, identity.id),
          ),
        )
        .limit(1);
      if (!conversation) {
        return reply.code(404).send({ error: "Conversation not found" });
      }
      const { format } = request.query;
      const filename = `${exportSlug(conversation.title)}.${format}`;
      const readPage = (afterId: number) =>
        db
          .select({
            id: messages.id,
            senderCharacter: messages.senderCharacter,
            kind: messages.kind,
            bbcode: messages.bbcode,
            sentByUs: messages.sentByUs,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversation.id),
              gt(messages.id, afterId),
            ),
          )
          .orderBy(messages.id)
          .limit(EXPORT_PAGE_SIZE);
      return reply
        .header("content-type", EXPORT_CONTENT_TYPES[format])
        .header("content-disposition", `attachment; filename="${filename}"`)
        .send(
          Readable.from(exportChunks(format, conversation.title, readPage)),
        );
    },
  );
}

export interface ExportRow {
  id: number;
  senderCharacter: string;
  kind: string;
  bbcode: string;
  sentByUs: boolean;
  createdAt: Date;
}

/** Filesystem-safe name from a conversation title. */
function exportSlug(title: string): string {
  const slug = title
    .replace(/[^a-zA-Z0-9_\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return slug === "" ? "conversation" : slug;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** `2026-07-14 12:04:33` (UTC) — stable and grep-friendly. */
function exportTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/** Messages fetched per streamed page (keyset on messages.id). */
export const EXPORT_PAGE_SIZE = 1000;

const EXPORT_CONTENT_TYPES = {
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8",
} as const;

function renderTxtRow(row: ExportRow): string {
  return row.kind === "sys"
    ? `[${exportTimestamp(row.createdAt)}] * ${row.bbcode}`
    : `[${exportTimestamp(row.createdAt)}] ${row.senderCharacter}: ${row.bbcode}`;
}

function renderHtmlRow(row: ExportRow): string {
  return row.kind === "sys"
    ? `<div class="sys"><time>[${exportTimestamp(row.createdAt)}]</time> * ${escapeHtml(row.bbcode)}</div>`
    : `<div><time>[${exportTimestamp(row.createdAt)}]</time> <b>${escapeHtml(row.senderCharacter)}</b>: ${escapeHtml(row.bbcode)}</div>`;
}

function renderJsonRow(row: ExportRow): string {
  // Message bodies stay wire BBCode in every format — the export is the
  // log as it happened, not a re-render.
  return JSON.stringify({
    id: row.id,
    sender: row.senderCharacter,
    kind: row.kind,
    bbcode: row.bbcode,
    sentByUs: row.sentByUs,
    createdAt: row.createdAt.toISOString(),
  });
}

/** Streams the export document: header → keyset pages → footer. */
export async function* exportChunks(
  format: "txt" | "html" | "json",
  title: string,
  readPage: (afterId: number) => Promise<ExportRow[]>,
  pageSize = EXPORT_PAGE_SIZE,
): AsyncGenerator<string> {
  if (format === "json") {
    yield `{\n  "title": ${JSON.stringify(title)},\n  "exportedAt": ${JSON.stringify(new Date().toISOString())},\n  "messages": [`;
  } else if (format === "html") {
    yield [
      "<!doctype html>",
      `<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>`,
      "<style>body{font-family:monospace;white-space:pre-wrap;margin:2em}time{color:#888}.sys{font-style:italic;color:#666}</style>",
      `</head><body><h1>${escapeHtml(title)}</h1>`,
      "",
    ].join("\n");
  }
  let afterId = 0;
  let first = true;
  for (;;) {
    const rows = await readPage(afterId);
    if (rows.length > 0) {
      afterId = rows[rows.length - 1]!.id;
      switch (format) {
        case "txt":
          yield rows.map(renderTxtRow).join("\n") + "\n";
          break;
        case "html":
          yield rows.map(renderHtmlRow).join("\n") + "\n";
          break;
        case "json":
          yield (first ? "\n    " : ",\n    ") +
            rows.map(renderJsonRow).join(",\n    ");
          break;
      }
      first = false;
    }
    if (rows.length < pageSize) {
      break;
    }
  }
  if (format === "json") {
    yield "\n  ]\n}\n";
  } else if (format === "html") {
    yield "</body></html>\n";
  }
}
