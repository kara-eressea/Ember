// GatewayHub — fan-out from server-held sessions to browser connections.
//
// Two event sources feed it (architecture.md §Resume semantics):
// - the history sink's bus for durable events (message.new carries the
//   persisted messages.id, so live fan-out is consistent with catchup), and
// - each session's bus for volatile events (presence, members, typing,
//   session status), translated here into gateway event DTOs.

import { and, eq, gt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import type { ServerCommand } from "@emberchat/fchat-protocol";
import type { GatewayEvent } from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import { authSessions } from "../../db/schema.js";
import type { HighlightMatcher } from "../highlights/matcher.js";
import type { HistorySink } from "../history/sink.js";
import type {
  FchatSession,
  SessionLogger,
} from "../session-engine/fchat-session.js";
import type { Outbox } from "../outbox/outbox.js";
import type { SessionRegistry } from "../session-engine/registry.js";
import { GatewayConnection, conversationDto } from "./connection.js";
import { memberDto, messageDto } from "./snapshot.js";

const NOOP_LOGGER: SessionLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface GatewayHubOptions {
  readonly history: HistorySink;
  readonly logger?: SessionLogger;
}

export class GatewayHub {
  readonly #log: SessionLogger;
  readonly #subscribers = new Map<string, Set<GatewayConnection>>();
  /** Bus unsubscribers per identity — called when a session is replaced. */
  readonly #sessionDetach = new Map<string, () => void>();

  constructor(options: GatewayHubOptions) {
    this.#log = options.logger ?? NOOP_LOGGER;
    options.history.events.on("message", ({ identityId, message }) => {
      this.broadcast(identityId, {
        kind: "message.new",
        d: { convId: message.conversationId, message: messageDto(message) },
      });
    });
    options.history.events.on(
      "conversation",
      ({ identityId, conversation }) => {
        this.broadcast(identityId, {
          kind: "conversation.updated",
          d: { conversation: conversationDto(conversation) },
        });
      },
    );
  }

  /**
   * Called from SessionRegistry.onSessionStarted, before the session begins
   * connecting. A restarted identity gets a fresh FchatSession object, so any
   * previous session's bus subscriptions are detached first.
   */
  attachSession(identityId: string, session: FchatSession): void {
    this.#sessionDetach.get(identityId)?.();
    const offCommand = session.events.on("command", (command) => {
      const event = translateCommand(session, command);
      if (event) {
        this.broadcast(identityId, event);
      }
    });
    const offStatus = session.events.on("status", ({ status, reason }) => {
      this.broadcast(identityId, {
        kind: "session.status",
        d: { status, ...(reason !== undefined ? { reason } : {}) },
      });
      if (status === "stopped") {
        detach();
      }
    });
    const detach = () => {
      offCommand();
      offStatus();
      this.#sessionDetach.delete(identityId);
    };
    this.#sessionDetach.set(identityId, detach);
  }

  subscribe(identityId: string, connection: GatewayConnection): void {
    let set = this.#subscribers.get(identityId);
    if (!set) {
      set = new Set();
      this.#subscribers.set(identityId, set);
    }
    set.add(connection);
  }

  unsubscribe(identityId: string, connection: GatewayConnection): void {
    const set = this.#subscribers.get(identityId);
    if (set) {
      set.delete(connection);
      if (set.size === 0) {
        this.#subscribers.delete(identityId);
      }
    }
  }

  dropConnection(connection: GatewayConnection): void {
    for (const identityId of [...this.#subscribers.keys()]) {
      this.unsubscribe(identityId, connection);
    }
  }

  /**
   * Called by the identities DELETE route: subscribed connections drop their
   * ownership cache and subscription so nothing acts on the dead identity.
   * (session.connect additionally re-verifies ownership uncached.)
   */
  identityDeleted(identityId: string): void {
    this.#sessionDetach.get(identityId)?.();
    for (const connection of this.#subscribers.get(identityId) ?? []) {
      connection.dropIdentity(identityId);
    }
    this.#subscribers.delete(identityId);
  }

  broadcast(identityId: string, event: GatewayEvent): void {
    const set = this.#subscribers.get(identityId);
    if (!set) {
      return;
    }
    for (const connection of [...set]) {
      try {
        connection.deliver(identityId, event);
      } catch (error) {
        this.#log.error({ err: error }, "gateway fan-out failed");
      }
    }
  }
}

/**
 * Volatile session commands → gateway events. Durable ones (MSG/PRI/channel
 * SYS) are deliberately absent: they fan out from the history sink after
 * persistence so they carry their messages.id. Presence is fanned out
 * unfiltered — per-client interest filtering is a scale concern for later
 * milestones.
 */
function translateCommand(
  session: FchatSession,
  command: ServerCommand,
): GatewayEvent | undefined {
  switch (command.cmd) {
    case "JCH":
      return {
        kind: "member.join",
        d: {
          channelKey: command.payload.channel,
          member: memberDto(session.state, command.payload.character.identity),
        },
      };
    case "LCH":
      return {
        kind: "member.leave",
        d: {
          channelKey: command.payload.channel,
          character: command.payload.character,
        },
      };
    case "ICH":
      return {
        kind: "channel.members",
        d: {
          key: command.payload.channel,
          mode: command.payload.mode,
          members: command.payload.users.map((user) =>
            memberDto(session.state, user.identity),
          ),
        },
      };
    case "CDS":
      return {
        kind: "channel.info",
        d: {
          key: command.payload.channel,
          description: command.payload.description,
        },
      };
    case "COL":
      return {
        kind: "channel.info",
        d: {
          key: command.payload.channel,
          oplist: [...command.payload.oplist],
        },
      };
    case "IGN":
      // Any list change (init at login, add/delete acks) fans the whole
      // list out — session state already folded this command in, so the
      // map holds the post-change truth.
      return {
        kind: "ignore.updated",
        d: { characters: [...session.state.ignores.values()] },
      };
    case "LIS":
      // The already-online roster streams in batches after identify; a
      // client whose snapshot raced it would otherwise show everyone
      // offline until their next status change (found on live F-Chat —
      // the sim's world is too small to ever lose that race).
      return {
        kind: "presence.bulk",
        d: {
          characters: command.payload.characters.map(
            ([name, gender, status, statusmsg]) => [
              name,
              gender,
              status,
              statusmsg,
            ],
          ),
        },
      };
    case "NLN":
      return {
        kind: "presence",
        d: {
          character: command.payload.identity,
          online: true,
          gender: command.payload.gender,
          status: command.payload.status,
          statusmsg: "",
        },
      };
    case "FLN":
      return {
        kind: "presence",
        d: { character: command.payload.character, online: false },
      };
    case "STA":
      return {
        kind: "presence",
        d: {
          character: command.payload.character,
          online: true,
          status: command.payload.status,
          statusmsg: command.payload.statusmsg,
        },
      };
    case "TPN":
      return {
        kind: "typing",
        d: {
          character: command.payload.character,
          status: command.payload.status,
        },
      };
    case "SYS":
      // Channel-scoped SYS is persisted and fans out as message.new.
      return command.payload.channel === undefined
        ? { kind: "sys", d: { message: command.payload.message } }
        : undefined;
    case "ERR":
      return {
        kind: "error",
        d: {
          number: command.payload.number,
          message: command.payload.message,
        },
      };
    default:
      return undefined;
  }
}

export interface GatewayRoutesOptions {
  db: Db;
  sessions: SessionRegistry;
  history: HistorySink;
  hub: GatewayHub;
  outbox: Outbox;
  highlights: HighlightMatcher;
}

// eslint-disable-next-line @typescript-eslint/require-await -- fastify async plugin signature
export async function gatewayRoutes(
  instance: FastifyInstance,
  options: GatewayRoutesOptions,
): Promise<void> {
  const { db, sessions, history, hub, outbox, highlights } = options;

  /** True while the auth session row exists and is unexpired. */
  async function sessionAlive(sid: string): Promise<boolean> {
    const [session] = await db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(
        and(eq(authSessions.id, sid), gt(authSessions.expiresAt, new Date())),
      )
      .limit(1);
    return session !== undefined;
  }

  /** Same trust chain as the REST `authenticate` guard: valid JWT whose sid
   * still maps to a live auth session. The connection re-checks the sid
   * periodically, so logout kills gateway access too — not just at connect. */
  async function verifyToken(
    token: string,
  ): Promise<{ userId: string; sid: string } | undefined> {
    let payload: { sub: string; sid: string };
    try {
      payload = instance.jwt.verify<{ sub: string; sid: string }>(token);
    } catch {
      return undefined;
    }
    return (await sessionAlive(payload.sid))
      ? { userId: payload.sub, sid: payload.sid }
      : undefined;
  }

  instance.get("/gateway", { websocket: true }, (socket: WebSocket) => {
    new GatewayConnection(socket, {
      db,
      sessions,
      history,
      hub,
      outbox,
      highlights,
      verifyToken,
      sessionAlive,
      log: instance.log,
    });
  });
}
