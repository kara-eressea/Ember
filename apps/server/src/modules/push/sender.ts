// Web Push sender (design/web-push.md §3) — the bouncer's signal path back to
// a user with no tab open. Two triggers feed one sender:
//
//   1. the notification bus, exactly the stream GatewayHub fans out as
//      `notification.new` (mention / friendrequest / note / comment), and
//   2. the history sink's PM hook — PMs never reach the notification store, so
//      the sink is the one place that sees a persisted PM with identity
//      context.
//
// Both triggers are FIRE-AND-FORGET (invariant 3): every entry point returns
// void after starting the work, and nothing in here rejects into its caller. A
// push service being slow or down must never delay a history write.
//
// No attached-client suppression happens here. A frozen phone tab (MP3-B)
// holds a live socket while rendering nothing, so "a client is attached"
// proves nothing about the user seeing anything — the service worker dedups at
// display time instead.

import { eq } from "drizzle-orm";
import * as webpush from "web-push";
import { type NotificationKind, type UserPrefs } from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import {
  flistAccounts,
  identities,
  pushSubscriptions,
} from "../../db/schema.js";
import type { UserPrefsCache } from "../gateway/user-prefs.js";
import { excerptOf, type NotificationStore } from "../notifications/store.js";
import type { SessionLogger } from "@emberchat/session-engine";

type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

/** Inbox kinds plus the push-only `pm` — PMs have no notification row. */
export type PushKind = NotificationKind | "pm";

/** The JSON the service worker receives, encrypted to the browser's keys. */
export interface PushPayload {
  kind: PushKind;
  /** The receiving identity's character — a user with several needs to know
   * which persona this arrived for. */
  identity: string;
  /** The sender, or the character an RTB event is about. */
  character: string;
  /** Absent when `notifyShowContent` is off, or when there is nothing to
   * show (RTB events without a subject). */
  excerpt?: string;
  convId?: string;
  /** In-app route the notification click should land on. */
  url: string;
}

/**
 * How long a push service holds an undelivered message. Long enough for a
 * phone that was off for a working day, short enough that nobody is woken by
 * a conversation that ended yesterday.
 */
const PUSH_TTL_SECONDS = 4 * 60 * 60;

/** Socket budget per send. Generous; the sends are detached anyway. */
const PUSH_TIMEOUT_MS = 10_000;

/**
 * Where a click lands (see `apps/web/src/router.tsx`). Both segments are ids
 * rather than names: the server has them without a lookup, and the shell
 * canonicalizes the URL to `/app/<Character>/c/<key>` once its session syncs.
 * Without a conversation — the RTB kinds — the identity route is the inbox
 * surface.
 */
export function pushUrl(identityId: string, convId?: string): string {
  return convId === undefined
    ? `/app/${identityId}`
    : `/app/${identityId}/${convId}`;
}

/** Which pref gates this kind (design/web-push.md §Preferences). */
function kindEnabled(prefs: UserPrefs, kind: PushKind): boolean {
  switch (kind) {
    case "mention":
      return prefs.desktopNotifyMentions;
    case "pm":
      return prefs.desktopNotifyPms;
    case "friendrequest":
    case "note":
    case "comment":
      return prefs.desktopNotifyNotes;
  }
}

/** A push endpoint is a capability URL — anyone holding it can push to that
 * browser — so logs carry the push service's host and never the path. */
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unknown";
  }
}

export interface PushEvent {
  kind: PushKind;
  character: string;
  excerpt: string;
  convId?: string;
}

/**
 * The wire payload for one event. Split out from the send path because it is
 * where the privacy rule lives and the encrypted body cannot be inspected
 * from a test: `notifyShowContent: false` means kind + character reach the
 * device and the message body never leaves this server.
 */
export function buildPushPayload(
  identityId: string,
  identityCharacter: string,
  event: PushEvent,
  prefs: Pick<UserPrefs, "notifyShowContent">,
): PushPayload {
  return {
    kind: event.kind,
    identity: identityCharacter,
    character: event.character,
    ...(prefs.notifyShowContent && event.excerpt !== ""
      ? { excerpt: event.excerpt }
      : {}),
    ...(event.convId !== undefined ? { convId: event.convId } : {}),
    url: pushUrl(identityId, event.convId),
  };
}

export interface PushSenderOptions {
  db: Db;
  /** Validated as all-three-or-none by loadConfig; absent config means no
   * sender is constructed at all (invariant 6). */
  vapid: { subject: string; publicKey: string; privateKey: string };
  /** The gateway's cache, shared: a prefs patch from any device drops it. */
  userPrefs: Pick<UserPrefsCache, "get">;
  /** Trigger 1. Optional so the sender can be built without an inbox. */
  notifications?: Pick<NotificationStore, "events">;
  logger?: SessionLogger;
}

export class PushSender {
  readonly #db: Db;
  readonly #vapid: PushSenderOptions["vapid"];
  readonly #prefs: Pick<UserPrefsCache, "get">;
  readonly #log: SessionLogger | undefined;
  /** identity → owning user + character. Both are immutable (identities
   * never move accounts and never rename), so this never needs invalidating. */
  readonly #identities = new Map<
    string,
    { userId: string; character: string }
  >();

  constructor(options: PushSenderOptions) {
    this.#db = options.db;
    this.#vapid = options.vapid;
    this.#prefs = options.userPrefs;
    this.#log = options.logger;
    options.notifications?.events.on(
      "notification",
      ({ identityId, notification }) => {
        // Muted rows are logged but never alert (decisions.md §10). The store
        // stamped this at write time against the same mute lists.
        if (notification.muted) {
          return;
        }
        this.#dispatch(identityId, {
          kind: notification.kind,
          character: notification.character,
          excerpt: notification.excerpt,
          ...(notification.conversationId !== null
            ? { convId: notification.conversationId }
            : {}),
        });
      },
    );
  }

  /**
   * Trigger 2: a private message the sink just persisted, not sent by this
   * identity. Push-only — no inbox row, no gateway event. Returns void by
   * design: the sink calls this from inside its serial write task and must
   * never await a push service.
   */
  notifyPrivateMessage(entry: {
    identityId: string;
    conversationId: string;
    senderCharacter: string;
    bbcode: string;
  }): void {
    this.#dispatch(entry.identityId, {
      kind: "pm",
      character: entry.senderCharacter,
      excerpt: excerptOf(entry.bbcode),
      convId: entry.conversationId,
    });
  }

  /** The fire-and-forget boundary: everything past here is detached. */
  #dispatch(identityId: string, event: PushEvent): void {
    void this.#deliver(identityId, event).catch((error: unknown) => {
      this.#log?.warn({ err: error }, "push delivery failed");
    });
  }

  async #deliver(identityId: string, event: PushEvent): Promise<void> {
    const identity = await this.#identity(identityId);
    if (identity === undefined) {
      return;
    }
    const { prefs } = await this.#prefs.get(identity.userId);
    if (!kindEnabled(prefs, event.kind)) {
      return;
    }
    // Inbox kinds arrive pre-judged (`muted` stamped at write time); the PM
    // trigger has no such stamp, so it applies both lists itself.
    if (
      event.kind === "pm" &&
      (prefs.mutedIdentityIds.includes(identityId) ||
        (event.convId !== undefined &&
          prefs.mutedConvIds.includes(event.convId)))
    ) {
      return;
    }
    const subscriptions = await this.#db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, identity.userId));
    if (subscriptions.length === 0) {
      return;
    }
    // Excerpts are capped by the notification store (`EXCERPT_MAX`, private
    // to `notifications/store.ts`), so this is comfortably inside the
    // 4 KB push limit. Concurrent, no retry queue: a user has at most a
    // handful of installs and a failed push is not worth a second attempt —
    // the next message brings another.
    const body = JSON.stringify(
      buildPushPayload(identityId, identity.character, event, prefs),
    );
    await Promise.all(
      subscriptions.map((subscription) => this.#send(subscription, body)),
    );
  }

  async #send(
    subscription: PushSubscriptionRow,
    payload: string,
  ): Promise<void> {
    let request;
    try {
      // The library does the RFC 8291 encryption and the VAPID JWT; the
      // request itself goes out over fetch rather than the library's own
      // legacy https.request path, which buys an AbortSignal timeout and
      // lets the tests point an endpoint at a loopback listener.
      request = webpush.generateRequestDetails(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        payload,
        {
          vapidDetails: this.#vapid,
          TTL: PUSH_TTL_SECONDS,
          urgency: "high",
          contentEncoding: "aes128gcm",
        },
      );
    } catch (error) {
      // Unusable client keys — nothing about this row will ever work, so it
      // goes the same way a 410 would.
      this.#log?.warn(
        { err: error, host: endpointHost(subscription.endpoint) },
        "push subscription is unusable; dropping it",
      );
      await this.#drop(subscription.id);
      return;
    }
    // Content-Length is a forbidden fetch header — the body sets it.
    const headers = { ...request.headers };
    delete headers["Content-Length"];
    try {
      const response = await fetch(request.endpoint, {
        method: "POST",
        headers,
        body: request.body,
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      // Push services answer with an empty or uninteresting body and nothing
      // here reads it — but an undrained response pins its socket until the
      // GC gets around to it, which on a busy instance is a slow leak.
      await response.body?.cancel();
      if (response.status === 404 || response.status === 410) {
        // The push service says this endpoint is gone for good (uninstalled
        // PWA, cleared site data, rotated subscription). Prune it — it can
        // never deliver again, and it would otherwise sit against the cap.
        await this.#drop(subscription.id);
        return;
      }
      if (!response.ok) {
        this.#log?.warn(
          {
            status: response.status,
            host: endpointHost(subscription.endpoint),
          },
          "push service refused a notification",
        );
      }
    } catch (error) {
      // Transient: log and move on, no retry queue (design/web-push.md §3).
      this.#log?.warn(
        { err: error, host: endpointHost(subscription.endpoint) },
        "push request failed",
      );
    }
  }

  async #drop(id: string): Promise<void> {
    try {
      await this.#db
        .delete(pushSubscriptions)
        .where(eq(pushSubscriptions.id, id));
    } catch (error) {
      this.#log?.warn({ err: error }, "pruning a push subscription failed");
    }
  }

  async #identity(
    identityId: string,
  ): Promise<{ userId: string; character: string } | undefined> {
    const cached = this.#identities.get(identityId);
    if (cached !== undefined) {
      return cached;
    }
    const [row] = await this.#db
      .select({
        userId: flistAccounts.userId,
        character: identities.characterName,
      })
      .from(identities)
      .innerJoin(flistAccounts, eq(identities.flistAccountId, flistAccounts.id))
      .where(eq(identities.id, identityId))
      .limit(1);
    if (row) {
      this.#identities.set(identityId, row);
    }
    return row;
  }
}
