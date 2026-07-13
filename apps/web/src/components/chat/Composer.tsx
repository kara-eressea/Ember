// Composer (COMPONENTS.md §8), M1 form: plain text sent as-is — the wire
// format is BBCode and raw text passes through untouched; the Markdown layer
// with live preview is M4. Enter sends, Shift+Enter breaks the line.

import { useRef, useState, type KeyboardEvent } from "react";
import { gateway } from "../../gateway/socket.js";
import type { IdentitySession } from "../../stores/sessions.js";
import styles from "./chat.module.css";

/** The textarea grows with its content up to this, then scrolls. */
const MAX_INPUT_HEIGHT_PX = 160;

const utf8 = new TextEncoder();

export interface ComposerProps {
  session: IdentitySession;
  convId: string;
  /** Channel key when the conversation is a channel we are not live in. */
  rejoinKey?: string;
  placeholder: string;
  /** Byte limit for this conversation kind (live server VAR). */
  maxBytes: number;
}

export function Composer({
  session,
  convId,
  rejoinKey,
  placeholder,
  maxBytes,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const online = session.sessionStatus === "online";
  // The server measures the limit in UTF-8 bytes, so count what it counts.
  const bytes = utf8.encode(text).length;

  function autogrow() {
    const el = inputRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${String(Math.min(el.scrollHeight, MAX_INPUT_HEIGHT_PX))}px`;
    }
  }

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
    requestAnimationFrame(autogrow);
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
          ref={inputRef}
          className={styles.composerInput}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autogrow();
          }}
          onKeyDown={onKeyDown}
          placeholder={online ? placeholder : "Session is not connected"}
          disabled={!online}
          aria-label="Message"
        />
      </div>
      <div className={styles.composerFooter}>
        <span>Enter to send · Shift+Enter for newline</span>
        <span
          className={`${styles.charCounter} ${bytes > maxBytes ? (styles.charCounterOver ?? "") : ""}`}
        >
          {bytes}/{maxBytes}
        </span>
      </div>
    </div>
  );
}
