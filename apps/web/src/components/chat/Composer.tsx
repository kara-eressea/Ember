// Composer (COMPONENTS.md §8), M1 form: plain text sent as-is — the wire
// format is BBCode and raw text passes through untouched; the Markdown layer
// with live preview is M4. Enter sends, Shift+Enter breaks the line.

import { useState, type KeyboardEvent } from "react";
import { gateway } from "../../gateway/socket.js";
import type { IdentitySession } from "../../stores/sessions.js";
import styles from "./chat.module.css";

export interface ComposerProps {
  session: IdentitySession;
  convId: string;
  /** Channel key when the conversation is a channel we are not live in. */
  rejoinKey?: string;
  placeholder: string;
}

export function Composer({
  session,
  convId,
  rejoinKey,
  placeholder,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const online = session.sessionStatus === "online";

  async function send() {
    const bbcode = text.trim();
    if (!bbcode || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    const ack = await gateway.cmd({
      identityId: session.identityId,
      action: "msg.send",
      d: { convId, bbcode },
    });
    setBusy(false);
    if (!ack.ok) {
      setError(ack.error ?? "Send failed");
      return;
    }
    setText("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  if (rejoinKey !== undefined) {
    return (
      <div className={styles.composer}>
        <div className={styles.joinPrompt}>
          You are not in this channel.
          <button
            className={styles.joinButton}
            disabled={!online}
            onClick={() => {
              void gateway.cmd({
                identityId: session.identityId,
                action: "channel.join",
                d: { key: rejoinKey },
              });
            }}
          >
            Join {rejoinKey}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.composer}>
      {error && (
        <p className={styles.composerError} role="alert">
          {error}
        </p>
      )}
      <div className={styles.inputBar}>
        <textarea
          className={styles.composerInput}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={onKeyDown}
          placeholder={online ? placeholder : "Session is not connected"}
          disabled={!online}
          aria-label="Message"
        />
      </div>
      <div className={styles.composerFooter}>
        Enter to send · Shift+Enter for newline
      </div>
    </div>
  );
}
