// AppShell (COMPONENTS.md §Layout): sidebar · main · members grid, driven by
// /app/:identityId/:convId?. Owns the gateway lifecycle for the tab: connect
// the socket, subscribe the routed identity, start its F-Chat session on
// demand (M1 — sessions run while wanted), and advance the read cursor for
// whatever conversation is on screen.

import { useEffect, useRef } from "react";
import { Link, useParams } from "react-router";
import { gateway } from "../../gateway/socket.js";
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
import { Sidebar } from "./Sidebar.js";
import styles from "./shell.module.css";

export function AppShell() {
  const { identityId, convId } = useParams();
  const session = useSessionsStore((s) =>
    identityId === undefined ? undefined : s.sessions[identityId],
  );
  const identities = useSessionsStore((s) => s.identities);
  const membersOpen = useUiStore((s) => s.membersOpen);

  useEffect(() => {
    gateway.connect();
  }, []);

  useEffect(() => {
    if (identityId !== undefined) {
      gateway.sub(identityId);
    }
  }, [identityId]);

  useEffect(() => {
    useUiStore.getState().setActive(identityId, convId);
    return () => {
      useUiStore.getState().setActive(undefined, undefined);
    };
  }, [identityId, convId]);

  // Start the F-Chat session on demand — once per shell visit, so a stop
  // (locked vault, auth failure) surfaces its reason instead of looping.
  // Gated on the autoConnect intent flag: an identity the user explicitly
  // disconnected stays offline until they explicitly connect it again
  // (the MeBar power control), never because a tab happened to open.
  const connectAttempted = useRef(false);
  const sessionStatus = session?.sessionStatus;
  const synced = session?.synced ?? false;
  const autoConnect = identities?.find((i) => i.id === identityId)?.autoConnect;
  useEffect(() => {
    if (
      identityId === undefined ||
      !synced ||
      autoConnect !== true ||
      connectAttempted.current ||
      (sessionStatus !== "offline" && sessionStatus !== "stopped")
    ) {
      return;
    }
    connectAttempted.current = true;
    void gateway.cmd({ identityId, action: "session.connect" });
  }, [identityId, synced, sessionStatus, autoConnect]);

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

  if (identityId === undefined) {
    return null;
  }
  if (
    identities !== undefined &&
    !identities.some((i) => i.id === identityId)
  ) {
    return (
      <div className={styles.centerNote} style={{ paddingTop: 80 }}>
        <p>This identity does not exist (anymore).</p>
        <Link to="/identities">Back to identities</Link>
      </div>
    );
  }
  if (!session?.synced) {
    return (
      <div className={styles.centerNote} style={{ paddingTop: 80 }}>
        Connecting…
      </div>
    );
  }

  const conversation =
    convId === undefined ? undefined : findConversation(session, convId);
  const channel =
    conversation?.kind === "channel" ? conversation.channel : undefined;
  const showMembers = channel !== undefined && membersOpen;

  return (
    <div
      className={`${styles.shell} ${showMembers ? "" : (styles.membersClosed ?? "")}`}
    >
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
                useSessionsStore.getState().clearNotice(identityId);
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
              <ChannelHeader channel={conversation.channel} />
            ) : (
              <DmHeader dm={conversation.dm} />
            )}
            <MessageLog identityId={identityId} convId={convId} />
            <Composer
              session={session}
              convId={convId}
              placeholder={
                conversation.kind === "channel"
                  ? `Message #${conversation.channel.title}`
                  : `Message ${conversation.dm.partner}`
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
      {showMembers && channel && <MemberList channel={channel} />}
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
