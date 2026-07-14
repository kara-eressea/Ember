// One GatewayConnection per browser WebSocket. Owns the connection-level
// protocol: hello handshake (token auth, protocol version), sub → snapshot →
// catchup → live, cmd dispatch with acks, read-cursor acks, ping/pong.
//
// Inbound frames are processed strictly in order through a serial queue —
// except msg.send, whose flood-gate wait must not stall the connection; its
// ack fires when the gate resolves. Outbound frames go through send(), which
// disconnects slow consumers instead of buffering without bound.

import { Buffer } from "node:buffer";
import type WebSocket from "ws";
import { and, eq, sql } from "drizzle-orm";
import { DEFAULT_SERVER_VARS } from "@emberchat/fchat-protocol";
import {
  clientFrameSchema,
  GATEWAY_CLOSE,
  PROTOCOL_VERSION,
  resolvePrefs,
  type ClientFrame,
  type ConversationDto,
  type GatewayCmd,
  type GatewayEvent,
  type ResumeCursors,
  type ServerFrame,
  type UserPrefs,
  type UserPrefsPatch,
} from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import {
  conversations,
  flistAccounts,
  identities,
  userPreferences,
} from "../../db/schema.js";
import {
  ConversationLimitError,
  type ConversationRow,
  type HistorySink,
} from "../history/sink.js";
import { connectIdentity } from "../session-engine/connect-identity.js";
import type {
  FchatSession,
  SessionLogger,
} from "../session-engine/fchat-session.js";
import type { Outbox } from "../outbox/outbox.js";
import type { SessionRegistry } from "../session-engine/registry.js";
import type { GatewayHub } from "./gateway.js";
import {
  buildSnapshot,
  catchupPlan,
  fetchMessagesAfter,
  identityBadgeTotals,
  messageDto,
} from "./snapshot.js";

/** Close the socket if no hello arrived within this window. */
export const HELLO_TIMEOUT_MS = 10_000;
/** Outbound backlog beyond this is a slow consumer — disconnect, don't buffer. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
/** Messages per catchup frame. */
export const CATCHUP_BATCH_SIZE = 200;
/**
 * Idle re-verification interval: a read-only listener sends no frames, so
 * without this a revoked session would keep receiving fan-out forever.
 * (Frames re-verify on every sub/cmd/ack, like REST does per request.)
 */
export const AUTH_RECHECK_MS = 30_000;
/** Inbound frame quota — generous for humans, a wall for loops. */
export const MAX_FRAMES_PER_MINUTE = 600;

export interface GatewayConnectionContext {
  readonly db: Db;
  readonly sessions: SessionRegistry;
  readonly history: HistorySink;
  readonly hub: GatewayHub;
  readonly outbox: Outbox;
  readonly verifyToken: (
    token: string,
  ) => Promise<{ userId: string; sid: string } | undefined>;
  /** True while the auth session row exists and is unexpired. */
  readonly sessionAlive: (sid: string) => Promise<boolean>;
  readonly log: SessionLogger;
}

interface OwnedIdentity {
  readonly id: string;
  readonly character: string;
  readonly accountId: string;
  readonly accountName: string;
}

interface Subscription {
  /** Live events buffered while snapshot + catchup are streaming; undefined
   * once the subscription is live and events flow straight through. */
  pending:
    { t: "event"; d: { identityId: string } & GatewayEvent }[] | undefined;
  /** Highest messages.id already delivered per conversation (resume cursor,
   * advanced by catchup) — used to drop duplicates when pending is flushed. */
  readonly delivered: Map<string, number>;
}

export class GatewayConnection {
  readonly #socket: WebSocket;
  readonly #ctx: GatewayConnectionContext;
  readonly #log: SessionLogger;

  #userId: string | undefined;
  #sid: string | undefined;
  #resume: ResumeCursors = {};
  /** Ownership cache — positive entries only; misses always re-query. */
  readonly #owned = new Map<string, OwnedIdentity>();
  readonly #subscriptions = new Map<string, Subscription>();
  /** Serial inbound queue — frames are handled in arrival order. */
  #inbound: Promise<void> = Promise.resolve();
  #helloTimer: NodeJS.Timeout | undefined;
  #authTimer: NodeJS.Timeout | undefined;
  #frameWindowStart = 0;
  #framesInWindow = 0;

  constructor(socket: WebSocket, ctx: GatewayConnectionContext) {
    this.#socket = socket;
    this.#ctx = ctx;
    this.#log = ctx.log;

    this.#helloTimer = setTimeout(() => {
      this.#close(GATEWAY_CLOSE.helloTimeout, "no hello");
    }, HELLO_TIMEOUT_MS);

    socket.on("message", (data: WebSocket.RawData) => {
      this.#enqueue(() => this.#handleRaw(data));
    });
    socket.on("error", (error) => {
      this.#log.warn({ err: error }, "gateway socket error");
    });
    socket.on("close", () => {
      this.#teardown();
    });
  }

  /** True while this connection wants events for the identity. */
  isSubscribed(identityId: string): boolean {
    return this.#subscriptions.has(identityId);
  }

  /** Hub fan-out entry point: buffers during snapshot/catchup, dedupes
   * against the delivered cursor, then streams. */
  deliver(identityId: string, event: GatewayEvent): void {
    const sub = this.#subscriptions.get(identityId);
    if (!sub) {
      return;
    }
    const frame = { t: "event" as const, d: { identityId, ...event } };
    if (sub.pending) {
      sub.pending.push(frame);
      return;
    }
    if (this.#isDuplicate(sub, event)) {
      return;
    }
    this.#send(frame);
  }

  #isDuplicate(sub: Subscription, event: GatewayEvent): boolean {
    if (event.kind !== "message.new") {
      return false;
    }
    const seen = sub.delivered.get(event.d.convId);
    if (seen !== undefined && event.d.message.id <= seen) {
      return true;
    }
    sub.delivered.set(event.d.convId, event.d.message.id);
    return false;
  }

  #enqueue(task: () => Promise<void>): void {
    this.#inbound = this.#inbound.then(task).catch((error: unknown) => {
      this.#log.error({ err: error }, "gateway frame handling failed");
    });
  }

  /** Sliding one-minute frame quota; loops get cut, humans never notice. */
  #withinFrameQuota(): boolean {
    const now = Date.now();
    if (now - this.#frameWindowStart >= 60_000) {
      this.#frameWindowStart = now;
      this.#framesInWindow = 0;
    }
    this.#framesInWindow += 1;
    return this.#framesInWindow <= MAX_FRAMES_PER_MINUTE;
  }

  async #handleRaw(data: WebSocket.RawData): Promise<void> {
    if (!this.#withinFrameQuota()) {
      this.#close(GATEWAY_CLOSE.rateLimited, "frame quota exceeded");
      return;
    }
    let json: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- ws RawData is Buffer/ArrayBuffer, toString is the decode
      json = JSON.parse(data.toString()) as unknown;
    } catch {
      this.#protocolError("frame is not valid JSON");
      return;
    }
    const parsed = clientFrameSchema.safeParse(json);
    if (!parsed.success) {
      this.#protocolError("malformed frame");
      return;
    }
    await this.#handleFrame(parsed.data);
  }

  #protocolError(message: string): void {
    if (this.#userId === undefined) {
      // Before hello there is no session to preserve — just drop it.
      this.#close(GATEWAY_CLOSE.badRequest, message);
      return;
    }
    this.#send({ t: "error", d: { message } });
  }

  async #handleFrame(frame: ClientFrame): Promise<void> {
    if (frame.t === "hello") {
      await this.#handleHello(frame.d);
      return;
    }
    if (frame.t === "ping") {
      this.#send({ t: "pong" });
      return;
    }
    if (this.#userId === undefined) {
      this.#close(GATEWAY_CLOSE.unauthorized, "hello first");
      return;
    }
    if (!(await this.#authStillValid())) {
      return; // #authStillValid already closed the socket
    }
    switch (frame.t) {
      case "sub":
        await this.#handleSub(frame.d.identityId);
        return;
      case "unsub":
        this.#subscriptions.delete(frame.d.identityId);
        this.#ctx.hub.unsubscribe(frame.d.identityId, this);
        return;
      case "cmd":
        try {
          await this.#handleCmd(frame.d, frame.id);
        } catch (error) {
          this.#log.error({ err: error }, "gateway cmd failed");
          this.#ack(frame.id, { ok: false, error: "internal error" });
        }
        return;
      case "ack":
        await this.#handleReadAck(frame.d);
        return;
    }
  }

  async #handleHello(d: {
    token: string;
    protocolVersion: number;
    resume?: ResumeCursors;
  }): Promise<void> {
    if (this.#userId !== undefined) {
      this.#send({ t: "error", d: { message: "already identified" } });
      return;
    }
    if (d.protocolVersion !== PROTOCOL_VERSION) {
      this.#close(
        GATEWAY_CLOSE.versionMismatch,
        `server speaks protocol ${String(PROTOCOL_VERSION)}`,
      );
      return;
    }
    const auth = await this.#ctx.verifyToken(d.token);
    if (!auth) {
      this.#close(GATEWAY_CLOSE.unauthorized, "invalid token");
      return;
    }
    if (this.#helloTimer) {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = undefined;
    }
    this.#userId = auth.userId;
    this.#sid = auth.sid;
    // A read-only listener never sends frames, so the per-frame recheck
    // alone would let a revoked session keep receiving fan-out forever.
    this.#authTimer = setInterval(() => {
      void this.#authStillValid();
    }, AUTH_RECHECK_MS);
    this.#resume = d.resume ?? {};

    const rows = await this.#ctx.db
      .select({
        id: identities.id,
        character: identities.characterName,
        accountId: flistAccounts.id,
        accountName: flistAccounts.accountName,
        autoConnect: identities.autoConnect,
      })
      .from(identities)
      .innerJoin(flistAccounts, eq(identities.flistAccountId, flistAccounts.id))
      .where(eq(flistAccounts.userId, auth.userId))
      .orderBy(identities.sortOrder, identities.createdAt);
    for (const row of rows) {
      this.#owned.set(row.id, {
        id: row.id,
        character: row.character,
        accountId: row.accountId,
        accountName: row.accountName,
      });
    }
    // Rail badges must paint from ready alone — a background identity may
    // never be subscribed by this client. Each total walks capped
    // per-conversation windows, so the cost is bounded per identity.
    const totals = await Promise.all(
      rows.map((row) =>
        identityBadgeTotals(this.#ctx.db, row.id, row.character),
      ),
    );
    this.#send({
      t: "ready",
      d: {
        userId: auth.userId,
        identities: rows.map((row, index) => ({
          id: row.id,
          name: row.character,
          sessionStatus:
            this.#ctx.sessions.get(row.id)?.status ?? ("offline" as const),
          autoConnect: row.autoConnect,
          unread: totals[index]?.unread ?? 0,
          mentions: totals[index]?.mentions ?? 0,
        })),
      },
    });
  }

  /**
   * Re-verifies the auth session (one indexed query — the same cost REST
   * pays per request, bounded here by the frame quota). Returns false after
   * closing the socket when the session has been revoked — logout must cut
   * gateway access, not just REST.
   */
  async #authStillValid(): Promise<boolean> {
    if (this.#sid === undefined) {
      return false;
    }
    if (await this.#ctx.sessionAlive(this.#sid)) {
      return true;
    }
    this.#close(GATEWAY_CLOSE.unauthorized, "session revoked");
    return false;
  }

  /**
   * The identity row, only if it belongs to this connection's user. Only
   * positive results are cached (a stream of random ids must not grow the
   * map); pass `fresh` for mutating commands where a stale row would act on
   * a deleted identity.
   */
  async #ownedIdentity(
    identityId: string,
    { fresh = false } = {},
  ): Promise<OwnedIdentity | undefined> {
    if (!fresh) {
      const cached = this.#owned.get(identityId);
      if (cached !== undefined) {
        return cached;
      }
    }
    const [row] = await this.#ctx.db
      .select({
        id: identities.id,
        character: identities.characterName,
        accountId: flistAccounts.id,
        accountName: flistAccounts.accountName,
      })
      .from(identities)
      .innerJoin(flistAccounts, eq(identities.flistAccountId, flistAccounts.id))
      .where(
        and(
          eq(identities.id, identityId),
          eq(flistAccounts.userId, this.#userId ?? ""),
        ),
      )
      .limit(1);
    if (row) {
      this.#owned.set(identityId, row);
    } else {
      this.#owned.delete(identityId);
    }
    return row;
  }

  /** Hub callback when an identity is deleted: drop cache + subscription. */
  dropIdentity(identityId: string): void {
    this.#owned.delete(identityId);
    this.#subscriptions.delete(identityId);
  }

  // ── sub: snapshot → catchup → live ─────────────────────────────────────────

  async #handleSub(identityId: string): Promise<void> {
    const identity = await this.#ownedIdentity(identityId);
    if (!identity) {
      this.#send({ t: "error", d: { message: "identity not found" } });
      return;
    }
    // Re-sub is a resync: start buffering again from a clean slate.
    const sub: Subscription = { pending: [], delivered: new Map() };
    this.#subscriptions.set(identityId, sub);
    this.#ctx.hub.subscribe(identityId, this);

    const session = this.#ctx.sessions.get(identityId);
    const snapshot = await buildSnapshot(
      this.#ctx.db,
      identityId,
      identity.character,
      session,
    );
    const vars = session?.state.vars ?? DEFAULT_SERVER_VARS;
    const ownStatus = session?.ownStatus ?? { status: "online", statusmsg: "" };
    // Live session state once this connection's IGN init has seeded it —
    // the DB mirror trails it by the sink's queue. The mirror covers the
    // rest: no session, or a session still mid-handshake.
    const ignores = session?.state.ignoresSeeded
      ? [...session.state.ignores.values()].sort((a, b) => a.localeCompare(b))
      : await this.#ctx.history.listIgnores(identityId);
    const { sendDelaySeconds, prefs } = await this.#userPrefs();
    this.#send({
      t: "snapshot",
      d: {
        identityId,
        self: {
          character: identity.character,
          sessionStatus: session?.status ?? "offline",
          status: ownStatus.status,
          statusmsg: ownStatus.statusmsg,
          ignores,
          limits: { chatMax: vars.chat_max, privMax: vars.priv_max },
          iconBlacklist: [...(session?.state.vars.icon_blacklist ?? [])],
          sendDelaySeconds,
          prefs,
          outbox: await this.#ctx.outbox.list(identityId),
        },
        channels: snapshot.channels,
        dms: snapshot.dms,
      },
    });

    await this.#sendCatchup(identityId, sub);

    // Flush events that arrived during the sync, minus catchup duplicates.
    const pending = sub.pending ?? [];
    sub.pending = undefined;
    for (const frame of pending) {
      if (
        this.#subscriptions.get(identityId) === sub &&
        !this.#isDuplicate(sub, frame.d)
      ) {
        this.#send(frame);
      }
    }
  }

  async #sendCatchup(identityId: string, sub: Subscription): Promise<void> {
    const cursors = this.#resume[identityId]?.convCursors ?? {};
    const plan = await catchupPlan(
      this.#ctx.db,
      identityId,
      cursors,
      CATCHUP_BATCH_SIZE,
    );
    for (const { convId, afterId: planStart } of plan) {
      let afterId = planStart;
      sub.delivered.set(convId, afterId);
      for (;;) {
        if (this.#subscriptions.get(identityId) !== sub) {
          return; // unsubscribed (or resynced) mid-catchup
        }
        const rows = await fetchMessagesAfter(
          this.#ctx.db,
          convId,
          afterId,
          CATCHUP_BATCH_SIZE,
        );
        const done = rows.length < CATCHUP_BATCH_SIZE;
        this.#send({
          t: "catchup",
          d: {
            identityId,
            convId,
            messages: rows.map(messageDto),
            done,
          },
        });
        const last = rows.at(-1);
        if (last) {
          afterId = last.id;
          sub.delivered.set(convId, last.id);
        }
        if (done) {
          break;
        }
      }
    }
  }

  // ── cmd dispatch ───────────────────────────────────────────────────────────

  async #handleCmd(cmd: GatewayCmd, id: number | undefined): Promise<void> {
    // session.connect bypasses the ownership cache: acting on a stale row
    // would resurrect a just-deleted identity as an orphaned F-Chat session
    // no client could ever see or stop.
    const identity = await this.#ownedIdentity(cmd.identityId, {
      fresh: cmd.action === "session.connect",
    });
    if (!identity) {
      this.#ack(id, { ok: false, error: "identity not found" });
      return;
    }
    switch (cmd.action) {
      case "session.connect":
        // Scenario selection, seeding and the deferred reconcile live in
        // connectIdentity (shared with the REST connect route).
        await connectIdentity(this.#ctx, {
          identityId: identity.id,
          character: identity.character,
          accountId: identity.accountId,
          accountName: identity.accountName,
        });
        this.#ctx.hub.broadcast(identity.id, {
          kind: "identity.updated",
          d: { autoConnect: true },
        });
        this.#ack(id, { ok: true });
        return;
      case "session.disconnect":
        // Flag first, stop second: clients react to the stopped status
        // event, and a tab whose autoConnect mirror still says true would
        // auto-resurrect the session the user just logged off.
        await this.#setAutoConnect(identity.id, false);
        this.#ctx.sessions.stop(identity.id, "disconnected by user");
        this.#ack(id, { ok: true });
        return;
      case "channel.join": {
        const session = this.#requireSession(identity.id, id);
        if (session) {
          session.joinChannel(cmd.d.key);
          this.#ack(id, { ok: true });
        }
        return;
      }
      case "channel.leave": {
        const session = this.#requireSession(identity.id, id);
        if (session) {
          session.leaveChannel(cmd.d.key);
          this.#ack(id, { ok: true });
        }
        return;
      }
      case "pm.open": {
        try {
          const row = await this.#ctx.history.ensurePmConversation(
            identity.id,
            cmd.d.character,
          );
          this.#ack(id, { ok: true, conversation: conversationDto(row) });
        } catch (error) {
          if (error instanceof ConversationLimitError) {
            this.#ack(id, { ok: false, error: error.message });
            return;
          }
          throw error;
        }
        return;
      }
      case "status.set": {
        const session = this.#requireSession(identity.id, id);
        if (session) {
          try {
            await session.setStatus(cmd.d.status, cmd.d.statusmsg);
            this.#ack(id, { ok: true });
          } catch (error) {
            this.#ack(id, {
              ok: false,
              error:
                error instanceof Error ? error.message : "status set failed",
            });
          }
        }
        return;
      }
      case "ignore.add":
      case "ignore.remove": {
        const session = this.#requireSession(identity.id, id);
        if (session) {
          try {
            // State, persistence and fan-out all follow the server's IGN
            // acknowledgement — the cmd only puts the request on the wire.
            if (cmd.action === "ignore.add") {
              await session.ignore(cmd.d.character);
            } else {
              await session.unignore(cmd.d.character);
            }
            this.#ack(id, { ok: true });
          } catch (error) {
            this.#ack(id, {
              ok: false,
              error:
                error instanceof Error ? error.message : "ignore change failed",
            });
          }
        }
        return;
      }
      case "conv.pin": {
        const row = await this.#ctx.history.setPinned(
          identity.id,
          cmd.d.convId,
          cmd.d.pinned,
        );
        if (row) {
          this.#ack(id, { ok: true, conversation: conversationDto(row) });
        } else {
          this.#ack(id, { ok: false, error: "conversation not found" });
        }
        return;
      }
      case "msg.send":
        await this.#handleMsgSend(identity.id, cmd.d, id);
        return;
      case "typing.set": {
        const session = this.#requireSession(identity.id, id);
        if (session) {
          session.sendTyping(cmd.d.character, cmd.d.status);
          this.#ack(id, { ok: true });
        }
        return;
      }
      case "outbox.recall": {
        const recalled = await this.#ctx.outbox.recall(
          identity.id,
          cmd.d.outboxId,
        );
        if (recalled) {
          this.#ack(id, { ok: true, markdown: recalled.markdown });
        } else {
          // Released, already recalled, or never this identity's row.
          this.#ack(id, { ok: false, error: "outbox item not found" });
        }
        return;
      }
      case "prefs.set": {
        await this.#patchPrefs(cmd.d);
        this.#ack(id, { ok: true });
        return;
      }
    }
  }

  /** The user's preferences; absent row = all defaults. */
  async #userPrefs(): Promise<{
    sendDelaySeconds: number;
    prefs: UserPrefs;
  }> {
    if (this.#userId === undefined) {
      return { sendDelaySeconds: 0, prefs: resolvePrefs({}) };
    }
    const [row] = await this.#ctx.db
      .select({
        sendDelaySeconds: userPreferences.sendDelaySeconds,
        prefs: userPreferences.prefs,
      })
      .from(userPreferences)
      .where(eq(userPreferences.userId, this.#userId))
      .limit(1);
    return {
      sendDelaySeconds: row?.sendDelaySeconds ?? 0,
      prefs: resolvePrefs(row?.prefs),
    };
  }

  /**
   * Applies a prefs patch and converges every identity's tabs. The jsonb
   * merge happens in SQL (`prefs || patch`) so two devices patching
   * different keys concurrently both land — no read-modify-write race.
   */
  async #patchPrefs(d: {
    sendDelaySeconds?: number;
    prefs?: UserPrefsPatch;
  }): Promise<void> {
    if (this.#userId === undefined) {
      return;
    }
    const patch = d.prefs ?? {};
    await this.#ctx.db
      .insert(userPreferences)
      .values({
        userId: this.#userId,
        sendDelaySeconds: d.sendDelaySeconds ?? 0,
        prefs: patch,
      })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          ...(d.sendDelaySeconds === undefined
            ? {}
            : { sendDelaySeconds: d.sendDelaySeconds }),
          prefs: sql`${userPreferences.prefs} || ${JSON.stringify(patch)}::jsonb`,
          updatedAt: new Date(),
        },
      });
    // Broadcast the full resolved state, not the patch — every tab applies
    // it as an idempotent overwrite regardless of what it missed.
    const state = await this.#userPrefs();
    const rows = await this.#ctx.db
      .select({ id: identities.id })
      .from(identities)
      .innerJoin(flistAccounts, eq(identities.flistAccountId, flistAccounts.id))
      .where(eq(flistAccounts.userId, this.#userId));
    for (const row of rows) {
      this.#ctx.hub.broadcast(row.id, {
        kind: "prefs.updated",
        d: state,
      });
    }
  }

  async #handleMsgSend(
    identityId: string,
    d: { convId: string; bbcode: string; markdown?: string },
    id: number | undefined,
  ): Promise<void> {
    const session = this.#requireSession(identityId, id);
    if (!session) {
      return;
    }
    const [conversation] = await this.#ctx.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, d.convId),
          eq(conversations.identityId, identityId),
        ),
      )
      .limit(1);
    if (!conversation) {
      this.#ack(id, { ok: false, error: "conversation not found" });
      return;
    }
    // A non-zero send delay parks the message in the server-side outbox —
    // the release worker puts it on the wire when due, tab or no tab.
    const { sendDelaySeconds: delaySeconds } = await this.#userPrefs();
    if (delaySeconds > 0) {
      // Validate against the live VAR limit NOW, like the immediate path —
      // deferring the check to release time would fail silently long after
      // the user could react (audit).
      const limit =
        conversation.kind === "channel"
          ? session.state.vars.chat_max
          : session.state.vars.priv_max;
      if (Buffer.byteLength(d.bbcode, "utf8") > limit) {
        this.#ack(id, {
          ok: false,
          error: `Message exceeds the server's ${String(limit)}-byte limit`,
        });
        return;
      }
      await this.#ctx.outbox.schedule({
        identityId,
        conversationId: conversation.id,
        // Recall restores what the user typed; raw-BBCode sends have no
        // separate source form.
        markdown: d.markdown ?? d.bbcode,
        bbcode: d.bbcode,
        releaseAt: new Date(Date.now() + delaySeconds * 1000),
      });
      this.#ack(id, { ok: true });
      return;
    }
    const send =
      conversation.kind === "channel"
        ? session.sendChannelMessage(conversation.channelKey ?? "", d.bbcode)
        : session.sendPrivateMessage(
            conversation.partnerCharacter ?? "",
            d.bbcode,
          );
    // Deliberately not awaited: the flood gate can hold a frame for seconds
    // and must not stall the inbound queue. The promise is always handled —
    // its outcome becomes the ack.
    send.then(
      () => {
        this.#ack(id, { ok: true });
      },
      (error: unknown) => {
        this.#ack(id, {
          ok: false,
          error: error instanceof Error ? error.message : "send failed",
        });
      },
    );
  }

  /**
   * autoConnect mirrors the user's connect intent: an explicit connect sets
   * it, an explicit disconnect clears it — so after a restart, "identities
   * that need re-auth" is exactly the autoConnect set, and one unlock brings
   * them all back (milestone-2 §Scope). Fanned out so every tab's mirror
   * converges — a stale mirror could silently reconnect an identity the
   * user just logged off elsewhere.
   */
  async #setAutoConnect(identityId: string, value: boolean): Promise<void> {
    await this.#ctx.db
      .update(identities)
      .set({ autoConnect: value })
      .where(eq(identities.id, identityId));
    this.#ctx.hub.broadcast(identityId, {
      kind: "identity.updated",
      d: { autoConnect: value },
    });
  }

  #requireSession(
    identityId: string,
    ackId: number | undefined,
  ): FchatSession | undefined {
    const session = this.#ctx.sessions.get(identityId);
    if (!session || session.status === "stopped") {
      this.#ack(ackId, { ok: false, error: "session not connected" });
      return undefined;
    }
    return session;
  }

  async #handleReadAck(d: {
    identityId: string;
    convId: string;
    messageId: number;
  }): Promise<void> {
    const identity = await this.#ownedIdentity(d.identityId);
    if (!identity) {
      return;
    }
    // markRead emits conversation.updated through the history bus, which the
    // hub fans out — every tab's unread counters converge.
    await this.#ctx.history.markRead(identity.id, d.convId, d.messageId);
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  #ack(
    id: number | undefined,
    d: {
      ok: boolean;
      error?: string;
      conversation?: ConversationDto;
      markdown?: string;
    },
  ): void {
    if (id !== undefined) {
      this.#send({ t: "ack", id, d });
    }
  }

  #send(frame: ServerFrame): void {
    if (this.#socket.readyState !== this.#socket.OPEN) {
      return;
    }
    if (this.#socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.#close(GATEWAY_CLOSE.slowConsumer, "send buffer overflow");
      return;
    }
    this.#socket.send(JSON.stringify(frame));
  }

  #close(code: number, reason: string): void {
    this.#teardown();
    try {
      this.#socket.close(code, reason);
    } catch {
      this.#socket.terminate();
    }
  }

  #teardown(): void {
    if (this.#helloTimer) {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = undefined;
    }
    if (this.#authTimer) {
      clearInterval(this.#authTimer);
      this.#authTimer = undefined;
    }
    this.#subscriptions.clear();
    this.#ctx.hub.dropConnection(this);
  }
}

export function conversationDto(row: ConversationRow): ConversationDto {
  return {
    id: row.id,
    kind: row.kind,
    channelKey: row.channelKey,
    partnerCharacter: row.partnerCharacter,
    title: row.title,
    pinned: row.pinned,
    joined: row.joined,
    lastReadMessageId: row.lastReadMessageId,
  };
}
