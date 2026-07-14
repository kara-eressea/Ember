// History REST: conversation list + cursor-paginated messages
// (architecture.md §REST). Cursor = messages.id (bigserial, arrival order):
// ?before=<msgId> walks toward older history, pages come back ascending so
// the client can prepend them directly.

import { and, desc, eq, lt } from "drizzle-orm";
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
  // .txt / .html / .json. Buffered in memory — fine at the current scale;
  // revisit with streaming alongside the M7 retention policies.
  app.get(
    "/:identityId/conversations/:conversationId/export",
    {
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
      const rows = await db
        .select({
          id: messages.id,
          senderCharacter: messages.senderCharacter,
          kind: messages.kind,
          bbcode: messages.bbcode,
          sentByUs: messages.sentByUs,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(eq(messages.conversationId, conversation.id))
        .orderBy(messages.id);

      const { format } = request.query;
      const filename = `${exportSlug(conversation.title)}.${format}`;
      const { contentType, body } = renderExport(
        format,
        conversation.title,
        rows,
      );
      return reply
        .header("content-type", contentType)
        .header("content-disposition", `attachment; filename="${filename}"`)
        .send(body);
    },
  );
}

interface ExportRow {
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

function renderExport(
  format: "txt" | "html" | "json",
  title: string,
  rows: ExportRow[],
): { contentType: string; body: string } {
  switch (format) {
    case "json":
      // Message bodies stay wire BBCode in every format — the export is the
      // log as it happened, not a re-render.
      return {
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(
          {
            title,
            exportedAt: new Date().toISOString(),
            messages: rows.map((row) => ({
              id: row.id,
              sender: row.senderCharacter,
              kind: row.kind,
              bbcode: row.bbcode,
              sentByUs: row.sentByUs,
              createdAt: row.createdAt.toISOString(),
            })),
          },
          null,
          2,
        ),
      };
    case "txt":
      return {
        contentType: "text/plain; charset=utf-8",
        body:
          rows
            .map((row) =>
              row.kind === "sys"
                ? `[${exportTimestamp(row.createdAt)}] * ${row.bbcode}`
                : `[${exportTimestamp(row.createdAt)}] ${row.senderCharacter}: ${row.bbcode}`,
            )
            .join("\n") + "\n",
      };
    case "html":
      return {
        contentType: "text/html; charset=utf-8",
        body: [
          "<!doctype html>",
          `<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>`,
          "<style>body{font-family:monospace;white-space:pre-wrap;margin:2em}time{color:#888}.sys{font-style:italic;color:#666}</style>",
          `</head><body><h1>${escapeHtml(title)}</h1>`,
          ...rows.map((row) =>
            row.kind === "sys"
              ? `<div class="sys"><time>[${exportTimestamp(row.createdAt)}]</time> * ${escapeHtml(row.bbcode)}</div>`
              : `<div><time>[${exportTimestamp(row.createdAt)}]</time> <b>${escapeHtml(row.senderCharacter)}</b>: ${escapeHtml(row.bbcode)}</div>`,
          ),
          "</body></html>",
        ].join("\n"),
      };
  }
}
