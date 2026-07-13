// Composer (COMPONENTS.md §8): Markdown composing with a live preview panel
// rendered through the same RichText pipeline as the log — what you preview
// is exactly what recipients see. The Ⓜ toggle switches Markdown mode (off =
// raw BBCode passthrough, the M1 behavior); Enter sends, Shift+Enter breaks
// the line. The byte counter counts the translated wire form — that is what
// the server measures.

import { useRef, useState, type KeyboardEvent } from "react";
import { mdToBBCode } from "@emberchat/markdown-bbcode";
import { gateway } from "../../gateway/socket.js";
import type { IdentitySession } from "../../stores/sessions.js";
import { RichText } from "./RichText.js";
import styles from "./chat.module.css";

/** The textarea grows with its content up to this, then scrolls. */
const MAX_INPUT_HEIGHT_PX = 160;

const MARKDOWN_MODE_KEY = "emberchat.composeMarkdown";

const utf8 = new TextEncoder();

function savedMarkdownMode(): boolean {
  try {
    return localStorage.getItem(MARKDOWN_MODE_KEY) !== "off";
  } catch {
    return true;
  }
}

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
  const [markdown, setMarkdown] = useState(savedMarkdownMode);
  const [eiconOpen, setEiconOpen] = useState(false);
  const [eiconName, setEiconName] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const online = session.sessionStatus === "online";
  // What actually goes on the wire — and what the server's limit measures.
  const wire = markdown ? mdToBBCode(text) : text;
  const bytes = utf8.encode(wire).length;

  function autogrow() {
    const el = inputRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${String(Math.min(el.scrollHeight, MAX_INPUT_HEIGHT_PX))}px`;
    }
  }

  function toggleMarkdown() {
    const next = !markdown;
    setMarkdown(next);
    try {
      localStorage.setItem(MARKDOWN_MODE_KEY, next ? "on" : "off");
    } catch {
      // Session-only preference then.
    }
  }

  /** Inserts at the caret (falls back to the end), keeping focus. */
  function insertAtCaret(snippet: string) {
    const el = inputRef.current;
    const at = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText(text.slice(0, at) + snippet + text.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + snippet.length, at + snippet.length);
      autogrow();
    });
  }

  /** Wraps the selection (or empty caret) in a Markdown marker pair. */
  function wrapSelection(marker: string) {
    const el = inputRef.current;
    if (!el) {
      return;
    }
    const from = el.selectionStart;
    const to = el.selectionEnd;
    const selected = text.slice(from, to);
    setText(text.slice(0, from) + marker + selected + marker + text.slice(to));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(from + marker.length, to + marker.length);
    });
  }

  async function send() {
    const body = wire.trim();
    if (!body || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    const ack = await gateway.cmd({
      identityId: session.identityId,
      action: "msg.send",
      d: { convId, bbcode: body },
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
      {markdown && text.trim() !== "" && (
        <div className={styles.previewPanel} data-testid="md-preview">
          <div className={styles.previewHead}>PREVIEW · markdown</div>
          <div className={styles.previewBody}>
            <RichText bbcode={wire} />
          </div>
        </div>
      )}
      {eiconOpen && (
        <form
          className={styles.eiconInsert}
          onSubmit={(event) => {
            event.preventDefault();
            const name = eiconName.trim();
            if (name !== "") {
              insertAtCaret(`[eicon]${name}[/eicon]`);
            }
            setEiconName("");
            setEiconOpen(false);
          }}
        >
          <input
            className={styles.miniInput}
            value={eiconName}
            onChange={(e) => {
              setEiconName(e.target.value);
            }}
            placeholder="eicon name…"
            aria-label="Eicon name"
            // Opened by an explicit click on the insert affordance.
            autoFocus
          />
          <button className={styles.miniButton} type="submit">
            Insert
          </button>
        </form>
      )}
      <div className={styles.inputBar}>
        <span className={styles.inputGlyph} title="Attachments arrive later">
          +
        </span>
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
        <span className={styles.formatHints}>
          <button
            type="button"
            className={styles.formatHint}
            title="Bold (wrap in **)"
            aria-label="Bold"
            disabled={!markdown}
            onClick={() => {
              wrapSelection("**");
            }}
          >
            **B**
          </button>
          <button
            type="button"
            className={styles.formatHint}
            title="Code (wrap in `)"
            aria-label="Code"
            disabled={!markdown}
            onClick={() => {
              wrapSelection("`");
            }}
          >
            `code`
          </button>
          <button
            type="button"
            className={styles.formatHint}
            title="Insert an eicon by name"
            aria-label="Insert eicon"
            onClick={() => {
              setEiconOpen(!eiconOpen);
            }}
          >
            ☺
          </button>
        </span>
      </div>
      <div className={styles.composerFooter}>
        <button
          type="button"
          className={`${styles.mdToggle} ${markdown ? (styles.mdToggleOn ?? "") : ""}`}
          onClick={toggleMarkdown}
          title={
            markdown
              ? "Markdown on — sends BBCode"
              : "Markdown off — raw BBCode"
          }
        >
          Ⓜ Markdown
        </button>
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
