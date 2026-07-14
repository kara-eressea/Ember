// Server frames → store mutations. Pure fan-in: no socket state here, so the
// whole protocol surface is unit-testable by feeding frames through
// dispatchFrame(). Volatile events are at-least-once idempotent state
// operations (gateway contract) — the sessions store applies them as
// overwrites / set add-remove; only message.new is exactly-once.

import type { GatewayEvent, ServerFrame } from "@emberchat/protocol";
import { useMessagesStore } from "../stores/messages.js";
import { useSessionsStore } from "../stores/sessions.js";
import { useUiStore } from "../stores/ui.js";
import { hydrateTheme } from "../theme/theme.js";

export function dispatchFrame(frame: ServerFrame): void {
  const sessions = useSessionsStore.getState();
  switch (frame.t) {
    case "ready":
      sessions.applyReady(
        frame.d.identities.map(
          ({ id, name, autoConnect, unread, mentions }) => ({
            id,
            name,
            autoConnect,
            unread,
            mentions,
          }),
        ),
      );
      for (const identity of frame.d.identities) {
        sessions.applySessionStatus(identity.id, identity.sessionStatus);
      }
      return;
    case "snapshot":
      sessions.applySnapshot(frame.d);
      hydrateTheme(frame.d.self.prefs);
      return;
    case "catchup":
      // Missed-while-away history; snapshot unread counts already include
      // these rows (both derive from lastReadMessageId), so no bump.
      useMessagesStore.getState().appendMany(frame.d.convId, frame.d.messages);
      return;
    case "event":
      dispatchEvent(frame.d.identityId, frame.d);
      return;
    case "ack":
    case "pong":
      return; // correlated in the socket layer
    case "error":
      // Protocol-level complaint (e.g. malformed frame) — a client bug.
      console.error("gateway protocol error:", frame.d.message);
      return;
  }
}

/**
 * Live-only join/part line (M5): only when the membership set actually
 * changes (`ifMember` = the state the character must be in for the line to
 * make sense), so at-least-once replays around a resync stay silent.
 */
function logPresence(
  sessions: ReturnType<typeof useSessionsStore.getState>,
  identityId: string,
  channelKey: string,
  d: { kind: "join" | "part"; character: string; ifMember: boolean },
): void {
  const channel = sessions.sessions[identityId]?.channels[channelKey];
  if (!channel) {
    return;
  }
  const isMember = channel.members.some((m) => m.character === d.character);
  if (isMember === d.ifMember) {
    useMessagesStore
      .getState()
      .appendPresence(channel.convId, d.kind, d.character);
  }
}

function dispatchEvent(identityId: string, event: GatewayEvent): void {
  const sessions = useSessionsStore.getState();
  switch (event.kind) {
    case "message.new": {
      useMessagesStore.getState().appendLive(event.d.convId, event.d.message);
      const ui = useUiStore.getState();
      const active =
        ui.activeIdentityId === identityId &&
        ui.activeConvId === event.d.convId;
      if (!event.d.message.sentByUs && !active) {
        // The mention verdict is stamped server-side at persist time (M5)
        // and rides the message — the client never re-matches.
        sessions.bumpUnread(
          identityId,
          event.d.convId,
          event.d.message.mention,
        );
      }
      return;
    }
    case "conversation.updated":
      sessions.applyConversation(identityId, event.d.conversation);
      return;
    case "member.join":
      // Synthesize the live-only join line before the set-add; delivery is
      // at-least-once, so a replay for someone already present logs nothing.
      logPresence(sessions, identityId, event.d.channelKey, {
        kind: "join",
        character: event.d.member.character,
        ifMember: false,
      });
      sessions.applyMemberJoin(identityId, event.d.channelKey, event.d.member);
      return;
    case "member.leave":
      logPresence(sessions, identityId, event.d.channelKey, {
        kind: "part",
        character: event.d.character,
        ifMember: true,
      });
      sessions.applyMemberLeave(
        identityId,
        event.d.channelKey,
        event.d.character,
      );
      return;
    case "channel.members":
      sessions.applyChannelMembers(identityId, event.d);
      return;
    case "channel.info":
      sessions.applyChannelInfo(identityId, event.d);
      return;
    case "presence":
      if (!event.d.online) {
        // FLN is a global leave — a quit line in every channel the
        // character is (still) a member of, before the store drops them.
        const channels = sessions.sessions[identityId]?.channels ?? {};
        for (const channel of Object.values(channels)) {
          if (channel.members.some((m) => m.character === event.d.character)) {
            useMessagesStore
              .getState()
              .appendPresence(channel.convId, "quit", event.d.character);
          }
        }
      }
      sessions.applyPresence(identityId, event.d);
      return;
    case "presence.bulk":
      sessions.applyPresenceBulk(identityId, event.d.characters);
      return;
    case "typing":
      sessions.applyTyping(identityId, event.d.character, event.d.status);
      return;
    case "session.status":
      sessions.applySessionStatus(identityId, event.d.status, event.d.reason);
      return;
    case "identity.updated":
      // Keeps every tab's connect-intent mirror honest — a stale mirror
      // could silently reconnect an identity logged off in another tab.
      sessions.setAutoConnect(identityId, event.d.autoConnect);
      return;
    case "identities.reordered":
      sessions.applyIdentityOrder(event.d.order);
      return;
    case "outbox.updated":
      sessions.applyOutbox(identityId, event.d.items);
      return;
    case "prefs.updated":
      sessions.applyPrefs(identityId, event.d);
      hydrateTheme(event.d.prefs);
      return;
    case "ignore.updated":
      sessions.applyIgnores(identityId, event.d.characters);
      return;
    case "sys":
      sessions.applyNotice(identityId, "sys", event.d.message);
      return;
    case "error":
      sessions.applyNotice(
        identityId,
        "error",
        `${event.d.message} (${String(event.d.number)})`,
      );
      return;
  }
}
