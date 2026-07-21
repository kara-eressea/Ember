// Server frames → store mutations. Pure fan-in: no socket state here, so the
// whole protocol surface is unit-testable by feeding frames through
// dispatchFrame(). Volatile events are at-least-once idempotent state
// operations (gateway contract) — the sessions store applies them as
// overwrites / set add-remove; only message.new is exactly-once.

import type { GatewayEvent, ServerFrame } from "@emberchat/protocol";

import { previewText, showMessageNotification } from "../lib/desktop-notify.js";
import { errNotice } from "../lib/err-codes.js";
import { loadSocial } from "../lib/social.js";
import { flashTitle, playHighlightChime } from "../lib/highlight-notify.js";
import { useAdsStore } from "../stores/ads.js";
import { useMessagesStore } from "../stores/messages.js";
import { useSearchStore } from "../stores/search.js";
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
      // these rows (both derive from lastReadMessageId), so no bump. A gap
      // frame (replay budget clamped the cursor) resets the buffer instead
      // of merging — the old prefix is non-contiguous with this window.
      if (frame.d.gap) {
        useMessagesStore.getState().resetTo(frame.d.convId, frame.d.messages);
      } else {
        useMessagesStore
          .getState()
          .appendMany(frame.d.convId, frame.d.messages);
      }
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
      const message = event.d.message;
      const convId = event.d.convId;
      useMessagesStore.getState().appendLive(convId, message);
      if (message.sentByUs) {
        return;
      }
      const ui = useUiStore.getState();
      const active =
        ui.activeIdentityId === identityId && ui.activeConvId === convId;
      // The prefs are per user — any slice's copy is current. Mutes silence
      // alerts only: badges, tint and the bump still accrue (decisions.md
      // §10).
      const prefs = sessions.sessions[identityId]?.prefs;
      // Ads never affect unread counts or alerts in any view (M10 mandate;
      // the buffer keeps them, so the Chat/Ads/Both selector reveals them
      // in place).
      if (message.kind === "lrp") {
        return;
      }
      const muted =
        prefs !== undefined &&
        (prefs.mutedIdentityIds.includes(identityId) ||
          prefs.mutedConvIds.includes(convId));
      if (!active) {
        // The mention verdict is stamped server-side at persist time (M5)
        // and rides the message — the client never re-matches.
        sessions.bumpUnread(identityId, convId, message.mention);
        if (message.mention && prefs) {
          // When-highlighted actions, each behind its pref.
          if (prefs.highlightSound && !muted) {
            playHighlightChime();
          }
          if (prefs.highlightFlashTitle && !muted) {
            flashTitle();
          }
          if (prefs.highlightBump) {
            sessions.bumpHighlight(identityId, convId);
          }
        }
      }
      // Desktop notification — mention or PM, behind its pref. The module
      // self-gates on permission and window focus (a focused app already
      // shows badges), so an active-but-unfocused conversation notifies.
      if (
        prefs &&
        !muted &&
        ((message.mention && prefs.desktopNotifyMentions) ||
          (message.kind === "pm" && prefs.desktopNotifyPms))
      ) {
        const session = sessions.sessions[identityId];
        const channelKey = session?.channelByConvId[convId];
        const channelTitle =
          channelKey !== undefined
            ? session?.channels[channelKey]?.title
            : undefined;
        showMessageNotification({
          title:
            channelTitle !== undefined
              ? `${message.senderCharacter} — ${channelTitle}`
              : message.senderCharacter,
          ...(prefs.notifyShowContent
            ? { body: previewText(message.bbcode) }
            : {}),
          tag: convId,
        });
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
    case "channel.invite":
      sessions.addInvite(identityId, event.d);
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
    case "campaign.updated":
      // Rotation-campaign fan-out (M11): full-state idempotent overwrite —
      // ticks, pauses, renewals, stops, and attach flips all land here.
      useSessionsStore.getState().applyCampaign(identityId, event.d.campaign);
      return;
    case "ads.updated":
      // Ad-library fan-out (M10): another device PUT the list; converge the
      // mirror so an open Ad Center shows the current library.
      useAdsStore.getState().applyAds(identityId, event.d.ads);
      return;
    case "ads.cooldowns":
      // Reply to our own cooldown query — waits become absolute expiries so
      // the post dialog can count down without re-asking.
      useAdsStore.getState().applyCooldowns(identityId, event.d.waits);
      return;
    case "character.search":
      // Reply to our own search (M10) — results or the server's refusal.
      useSearchStore.getState().applyOutcome(identityId, event.d);
      return;
    case "social.updated":
      // Server-side bookmark/friend change (this device, another device,
      // or the website via RTB) — full-list overwrite (#199).
      sessions.applySocial(identityId, {
        ...event.d.social,
        fetchedAt: Date.now(),
      });
      return;
    case "ignore.updated":
      sessions.applyIgnores(identityId, event.d.characters);
      return;
    case "sys":
      sessions.applyNotice(identityId, "sys", event.d.message);
      return;
    case "rtb": {
      // Website events over the chat socket (M6 step 9): a notice always;
      // a desktop notification for notes/friend requests behind its pref.
      // The website stays the place to read and act.
      const line = rtbNoticeText(event.d);
      if (line === undefined) {
        return; // an RTB type not worth a notice (e.g. silent list syncs)
      }
      sessions.applyNotice(identityId, "sys", line);
      if (event.d.type === "friendrequest") {
        // The sidebar's request rows should appear without a manual ↻.
        void loadSocial(identityId, true).catch(() => undefined);
      }
      const prefs = sessions.sessions[identityId]?.prefs;
      if (
        prefs?.desktopNotifyNotes === true &&
        (event.d.type === "note" || event.d.type === "friendrequest")
      ) {
        showMessageNotification({
          title: line,
          tag: `rtb:${event.d.type}`,
        });
      }
      return;
    }
    case "error":
      // Friendly copy for the codes users actually hit (M9); unknown
      // codes surface F-Chat's own message.
      sessions.applyNotice(
        identityId,
        "error",
        errNotice(event.d.number, event.d.message),
      );
      return;
  }
}

/**
 * Human line for an RTB event; undefined = not notice-worthy. Only the
 * types with obvious user value get text — unknown types stay silent
 * rather than leaking raw enum names into the notice strip.
 */
export function rtbNoticeText(d: {
  type: string;
  character?: string;
  subject?: string;
}): string | undefined {
  const who = d.character ?? "someone";
  switch (d.type) {
    case "note":
      return `New note from ${who}${d.subject ? `: ${d.subject}` : ""} — read it on f-list.net`;
    case "friendrequest":
      return `${who} sent a friend request`;
    case "comment":
      return `${who} replied to a comment thread you follow — see f-list.net`;
    default:
      return undefined;
  }
}
