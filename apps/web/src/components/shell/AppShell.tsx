// AppShell (COMPONENTS.md §Layout): rail · sidebar · main · members grid,
// driven by the human-readable routes /app/<Character>[/c/<channel>|/dm/
// <partner>] (lib/routes.ts — case-insensitive, @me alias, legacy UUID
// redirects). Owns the gateway lifecycle for the tab: connect the socket,
// subscribe every identity (background identities must stream so their rail
// badges stay live), connect F-Chat sessions where the autoConnect intent
// says so (sessions themselves outlive every tab — the bouncer property),
// and advance the read cursor for whatever conversation is on screen.

import { useEffect, useRef } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router";
import { gateway } from "../../gateway/socket.js";
import { startAutoAway } from "../../lib/auto-away.js";
import {
  identityPath,
  rememberLastIdentity,
  resolveConv,
  resolveIdentity,
  type ConvRef,
} from "../../lib/routes.js";
import { useMessagesStore } from "../../stores/messages.js";
import {
  useSessionsStore,
  type ChannelView,
  type DmView,
  type IdentitySession,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { ChannelHeader, DmHeader } from "../chat/ChannelHeader.js";
import { Composer } from "../chat/Composer.js";
import { MemberList } from "../chat/MemberList.js";
import { MessageLog } from "../chat/MessageLog.js";
import { ChannelBrowser } from "../browser/ChannelBrowser.js";
import { PreferencesWindow } from "../prefs/PreferencesWindow.js";
import { useProfileStore } from "../../stores/profile.js";
import { ProfileViewer } from "../profile/ProfileViewer.js";
import { IdentityRail } from "./IdentityRail.js";
import { Sidebar } from "./Sidebar.js";
import styles from "./shell.module.css";

export function AppShell() {
  const {
    identity: slug,
    channel: channelParam,
    partner: partnerParam,
    legacyConvId,
  } = useParams();
  const location = useLocation();
  const identities = useSessionsStore((s) => s.identities);
  const resolved =
    slug === undefined || identities === undefined
      ? undefined
      : resolveIdentity(identities, slug);
  const identityId = resolved?.id;
  const session = useSessionsStore((s) =>
    identityId === undefined ? undefined : s.sessions[identityId],
  );
  const membersOpen = useUiStore((s) => s.membersOpen);
  const prefsOpen = useUiStore((s) => s.prefsOpen);
  const profileViewing = useProfileStore((s) => s.viewing);
  const channelBrowserOpen = useUiStore((s) => s.channelBrowserOpen);

  const ref: ConvRef | undefined =
    channelParam !== undefined
      ? { kind: "c", target: channelParam }
      : partnerParam !== undefined
        ? { kind: "dm", target: partnerParam }
        : legacyConvId !== undefined
          ? { kind: "legacy", convId: legacyConvId }
          : undefined;
  const conv =
    session?.synced && ref !== undefined
      ? resolveConv(session, ref)
      : undefined;
  const convId = conv?.convId;
  const convSuffix = conv?.suffix;

  useEffect(() => {
    gateway.connect();
  }, []);

  // Idle detection lives with the shell: it exists exactly while the user
  // is in the app, across identity/conversation navigation.
  useEffect(() => startAutoAway(), []);

  // The routed identity subscribes immediately (its snapshot should win the
  // race); the rest follow once ready lists them, so background badges and
  // catch-up stream for every identity, not just the visible one.
  useEffect(() => {
    if (identityId !== undefined) {
      gateway.sub(identityId);
    }
  }, [identityId]);
  const identityIdsKey = identities?.map((i) => i.id).join(",") ?? "";
  useEffect(() => {
    for (const id of identityIdsKey.split(",")) {
      if (id !== "") {
        gateway.sub(id);
      }
    }
  }, [identityIdsKey]);

  useEffect(() => {
    useUiStore.getState().setActive(identityId, convId);
    if (identityId !== undefined) {
      rememberLastIdentity(identityId); // the @me alias points here
      if (convSuffix !== undefined) {
        useUiStore.getState().setLastConv(identityId, convSuffix);
      }
    }
    return () => {
      useUiStore.getState().setActive(undefined, undefined);
    };
  }, [identityId, convId, convSuffix]);

  // Start F-Chat sessions on demand — once per identity per shell visit, so
  // a stop (locked vault, auth failure) surfaces its reason instead of
  // looping. Gated on the autoConnect intent flag: an identity the user
  // explicitly disconnected stays offline until they explicitly connect it
  // again (the MeBar power control), never because a tab happened to open.
  // All identities, not just the routed one — the rail promises background
  // identities stay online. Subscribed via a derived key, never the sessions
  // map itself: every message/presence event replaces the map object, and
  // with all identities subscribed that would re-render the entire shell on
  // every event for any of them. Only the fields this loop reads take part.
  const connectKey = useSessionsStore((s) =>
    (s.identities ?? [])
      .map((i) => {
        const slice = s.sessions[i.id];
        return `${i.id}:${i.autoConnect ? 1 : 0}:${slice?.synced ? 1 : 0}:${slice?.sessionStatus ?? ""}`;
      })
      .join("|"),
  );
  const connectAttempted = useRef(new Set<string>());
  useEffect(() => {
    const state = useSessionsStore.getState();
    for (const identity of state.identities ?? []) {
      const slice = state.sessions[identity.id];
      if (
        !slice?.synced ||
        identity.autoConnect !== true ||
        connectAttempted.current.has(identity.id) ||
        (slice.sessionStatus !== "offline" && slice.sessionStatus !== "stopped")
      ) {
        continue;
      }
      connectAttempted.current.add(identity.id);
      void gateway.cmd({ identityId: identity.id, action: "session.connect" });
    }
  }, [connectKey]);

  // The read cursor follows the newest visible message of the active
  // conversation; the ack fans conversation.updated back to every tab.
  const newestId = useMessagesStore((s) =>
    convId === undefined ? undefined : s.buffers[convId]?.messages.at(-1)?.id,
  );
  useEffect(() => {
    if (identityId !== undefined && convId !== undefined) {
      useSessionsStore.getState().clearUnread(identityId, convId);
      if (newestId !== undefined) {
        gateway.readAck(identityId, convId, newestId);
      }
    }
  }, [identityId, convId, newestId]);

  if (slug === undefined) {
    return null;
  }
  if (identities !== undefined && resolved === undefined) {
    return (
      <div className={styles.centerNote} style={{ paddingTop: 80 }}>
        <p>This identity does not exist (anymore).</p>
        <Link to="/identities">Back to identities</Link>
      </div>
    );
  }
  if (resolved === undefined || !session?.synced) {
    return (
      <div className={styles.centerNote} style={{ paddingTop: 80 }}>
        Connecting…
      </div>
    );
  }

  // Restore the canonical URL: @me and UUID slugs become the character name,
  // casing is fixed, and legacy conversation ids become their name path.
  // Unresolved c/dm targets keep the typed form — they canonicalize the
  // moment the conversation exists (e.g. right after joining).
  const canonical =
    identityPath(resolved.name) +
    (conv !== undefined
      ? `/${conv.suffix}`
      : ref !== undefined && ref.kind !== "legacy"
        ? `/${ref.kind}/${encodeURIComponent(ref.target)}`
        : "");
  if (canonical !== location.pathname) {
    return <Navigate to={canonical} replace />;
  }

  const activeId = resolved.id;
  const conversation =
    convId === undefined ? undefined : findConversation(session, convId);
  const channel =
    conversation?.kind === "channel" ? conversation.channel : undefined;
  const showMembers = channel !== undefined && membersOpen;

  return (
    <div
      className={`${styles.shell} ${showMembers ? "" : (styles.membersClosed ?? "")}`}
    >
      <IdentityRail activeId={activeId} />
      <Sidebar session={session} activeConvId={convId} />
      <main className={styles.main}>
        {session.notice && (
          <div
            className={`${styles.notice} ${session.notice.kind === "error" ? (styles.error ?? "") : ""}`}
            role="status"
          >
            {session.notice.text}
            <button
              className={styles.noticeDismiss}
              onClick={() => {
                useSessionsStore.getState().clearNotice(activeId);
              }}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
        {conversation === undefined || convId === undefined ? (
          <div className={styles.centerNote}>
            <p>Join a channel or open a conversation to start chatting.</p>
          </div>
        ) : (
          <>
            {conversation.kind === "channel" ? (
              <ChannelHeader
                identityId={activeId}
                channel={conversation.channel}
              />
            ) : (
              <DmHeader identityId={activeId} dm={conversation.dm} />
            )}
            {/* Keyed per conversation so both remount on switch — with
                distinct prefixes, since they are siblings. */}
            <MessageLog
              key={`log:${convId}`}
              identityId={activeId}
              convId={convId}
              readCursorAtAttach={
                conversation.kind === "channel"
                  ? conversation.channel.lastReadMessageId
                  : conversation.dm.lastReadMessageId
              }
            />
            <Composer
              key={`composer:${convId}`}
              session={session}
              convId={convId}
              channelKey={channel?.key}
              channelMode={channel?.mode}
              partner={
                conversation.kind === "pm" ? conversation.dm.partner : undefined
              }
              placeholder={
                conversation.kind === "channel"
                  ? `Message #${conversation.channel.title}`
                  : `Message ${conversation.dm.partner}`
              }
              maxBytes={
                conversation.kind === "channel"
                  ? session.limits.chatMax
                  : session.limits.privMax
              }
              // A channel we hold history for but are not live in (fresh
              // session, or kicked) offers rejoin instead of a dead input.
              rejoinKey={
                channel && channel.members.length === 0
                  ? channel.key
                  : undefined
              }
            />
          </>
        )}
      </main>
      {showMembers && channel && (
        <MemberList
          identityId={activeId}
          ownCharacter={session.character}
          channel={channel}
        />
      )}
      {prefsOpen && (
        <PreferencesWindow
          identityId={activeId}
          onClose={() => {
            useUiStore.getState().setPrefsOpen(false);
          }}
        />
      )}
      {channelBrowserOpen && (
        <ChannelBrowser
          session={session}
          onClose={() => {
            useUiStore.getState().setChannelBrowserOpen(false);
          }}
        />
      )}
      {profileViewing !== undefined && (
        <ProfileViewer
          identityId={activeId}
          onClose={() => {
            useProfileStore.getState().close();
          }}
        />
      )}
    </div>
  );
}

type FoundConversation =
  { kind: "channel"; channel: ChannelView } | { kind: "pm"; dm: DmView };

function findConversation(
  session: IdentitySession,
  convId: string,
): FoundConversation | undefined {
  const key = session.channelByConvId[convId];
  if (key !== undefined) {
    const channel = session.channels[key];
    if (channel) {
      return { kind: "channel", channel };
    }
  }
  const dm = session.dms[convId];
  return dm ? { kind: "pm", dm } : undefined;
}
