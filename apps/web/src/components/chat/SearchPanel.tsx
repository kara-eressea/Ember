// In-log search panel (M9 step 3): a right-side panel over the log, scoped
// to the current conversation by default with an Everywhere toggle. The
// query mini-language (from: / before: / after:) is parsed server-side —
// this panel just sends the text. Clicking a hit jumps the log to the page
// containing that message (stores/messages.ts jumpTo) and navigates first
// when the hit lives in another conversation.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api, ApiError, type SearchResultDto } from "../../lib/api.js";
import { channelPath, dmPath } from "../../lib/routes.js";
import { formatTime } from "../../lib/time.js";
import { useMessagesStore } from "../../stores/messages.js";
import {
  useSessionsStore,
  type IdentitySession,
} from "../../stores/sessions.js";
import { RichText } from "./RichText.js";
import styles from "./chat.module.css";

export function SearchPanel({
  session,
  convId,
  onClose,
}: {
  session: IdentitySession;
  /** The current conversation — the default scope. Undefined = no
   * conversation on screen; only Everywhere is offered then. */
  convId: string | undefined;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [everywhere, setEverywhere] = useState(convId === undefined);
  const [results, setResults] = useState<SearchResultDto[]>();
  const [nextCursor, setNextCursor] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  async function run(cursor?: number) {
    const q = query.trim();
    if (q === "" || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const scope = everywhere || convId === undefined ? {} : { convId };
      const page = await api.searchMessages(session.identityId, q, {
        ...scope,
        cursor,
      });
      setResults((existing) =>
        cursor === undefined
          ? page.results
          : [...(existing ?? []), ...page.results],
      );
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Search failed");
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setResults(undefined);
    setNextCursor(undefined);
    void run();
  }

  function jump(result: SearchResultDto) {
    // Mark + fetch the history page; the log scrolls once it lands.
    void useMessagesStore
      .getState()
      .jumpTo(session.identityId, result.convId, result.id)
      .catch(() => {
        useSessionsStore
          .getState()
          .applyNotice(session.identityId, "error", "Couldn't load that page");
      });
    if (result.convId !== convId) {
      const key = session.channelByConvId[result.convId];
      const partner = session.dms[result.convId]?.partner;
      const path =
        key !== undefined
          ? channelPath(session.character, key)
          : partner !== undefined
            ? dmPath(session.character, partner)
            : undefined;
      if (path !== undefined) {
        void navigate(path);
      }
    }
  }

  return (
    <div className={styles.searchPanel} role="dialog" aria-label="Search log">
      <form className={styles.searchHead} onSubmit={submit}>
        <input
          ref={inputRef}
          className={styles.searchInput}
          value={query}
          placeholder='Search… (from:"Name" before:2026-01-01)'
          aria-label="Search messages"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <button
          type="button"
          className={`${styles.searchScope} ${everywhere ? (styles.searchScopeOn ?? "") : ""}`}
          title="Search all conversations instead of this one"
          aria-pressed={everywhere}
          disabled={convId === undefined}
          onClick={() => {
            setEverywhere((value) => !value);
          }}
        >
          everywhere
        </button>
        <button
          type="button"
          className={styles.searchClose}
          aria-label="Close search"
          onClick={onClose}
        >
          ✕
        </button>
      </form>
      <div className={styles.searchBody}>
        {error !== undefined && (
          <div className={styles.searchNote} role="alert">
            {error}
          </div>
        )}
        {results === undefined && error === undefined && (
          <div className={styles.searchNote}>
            Enter to search. Filters: <code>from:Name</code>,{" "}
            <code>before:</code>/<code>after:</code> <code>YYYY-MM-DD</code>.
          </div>
        )}
        {results !== undefined && results.length === 0 && (
          <div className={styles.searchNote}>No matches.</div>
        )}
        {results?.map((result) => (
          <button
            key={result.id}
            type="button"
            className={styles.searchHit}
            onClick={() => {
              jump(result);
            }}
          >
            <span className={styles.searchHitMeta}>
              <span className={styles.searchHitConv}>
                {result.conversationKind === "channel" ? "#" : "@"}
                {result.conversationTitle}
              </span>
              <span className={styles.searchHitSender}>
                {result.senderCharacter}
              </span>
              <span className={styles.searchHitTime}>
                {new Date(result.createdAt).toLocaleDateString()}{" "}
                {formatTime(result.createdAt)}
              </span>
            </span>
            <span className={styles.searchHitBody}>
              <RichText bbcode={result.bbcode} />
            </span>
          </button>
        ))}
        {nextCursor !== undefined && (
          <button
            type="button"
            className={styles.searchMore}
            disabled={busy}
            onClick={() => {
              void run(nextCursor);
            }}
          >
            {busy ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}
