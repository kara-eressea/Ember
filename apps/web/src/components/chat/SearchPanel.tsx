// In-log search results (M9 step 3), dropping out of the header toolbar's
// search field: scoped to the current conversation by default, with an
// Everywhere toggle that re-runs the search in place. The field owns the
// query — this panel owns scope and results. The query mini-language
// (from: / before: / after:) is parsed server-side; the field just sends the
// text. Clicking a hit jumps the log to the page containing that message
// (stores/messages.ts jumpTo) and navigates first when the hit lives in
// another conversation.

import { useNavigate } from "react-router";
import { type SearchResultDto } from "../../lib/api.js";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import { channelPath, dmPath } from "../../lib/routes.js";
import { formatTime } from "../../lib/time.js";
import { useMessagesStore } from "../../stores/messages.js";
import {
  useSessionsStore,
  type IdentitySession,
} from "../../stores/sessions.js";
import { CloseGlyph } from "../icons/Glyphs.js";
import { RichText } from "./RichText.js";
import type { LogSearch } from "./log-search.js";
import styles from "./chat.module.css";

export function SearchPanel({
  session,
  convId,
  search,
  onClose,
}: {
  session: IdentitySession;
  /** The current conversation — the default scope. Undefined = no
   * conversation on screen; only Everywhere is offered then. */
  convId: string | undefined;
  /** Query state owned by the header's search field (useLogSearch). */
  search: LogSearch;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { everywhere, results, busy, error } = search;

  // On the shared Escape stack as an overlay (#442): one press closes this
  // panel and nothing else, and an armed ambient action — MessageLog's "mark
  // caught up" — cannot jump ahead of it.
  useEscapeToClose(onClose);

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
    // The panel hangs over the top of the log — the message you jumped to,
    // and the "Back to present" banner above it, are exactly what it would
    // cover. Jumping is the end of a search, so it dismisses.
    onClose();
  }

  return (
    <div
      className={styles.searchPanel}
      data-eb-surface
      role="dialog"
      aria-label="Search log"
    >
      <div className={styles.searchHead}>
        <div
          className={styles.searchScopeGroup}
          role="group"
          aria-label="Search scope"
        >
          <button
            type="button"
            className={`${styles.searchScope} ${everywhere ? "" : (styles.searchScopeOn ?? "")}`}
            aria-pressed={!everywhere}
            disabled={search.scopeLocked}
            title="Search only this conversation"
            onClick={() => {
              search.setEverywhere(false);
            }}
          >
            This conversation
          </button>
          <button
            type="button"
            className={`${styles.searchScope} ${everywhere ? (styles.searchScopeOn ?? "") : ""}`}
            aria-pressed={everywhere}
            title="Search all conversations instead of this one"
            onClick={() => {
              search.setEverywhere(true);
            }}
          >
            Everywhere
          </button>
        </div>
        <button
          type="button"
          className={styles.searchClose}
          aria-label="Close search"
          title="Close search"
          onClick={onClose}
        >
          <CloseGlyph />
        </button>
      </div>
      <div className={styles.searchBody}>
        {error !== undefined && (
          <div className={styles.searchNote} role="alert">
            {error}
          </div>
        )}
        {busy && results === undefined && error === undefined && (
          <div className={styles.searchNote}>Searching…</div>
        )}
        {!busy && results === undefined && error === undefined && (
          <div className={styles.searchNote}>
            Type in the field above and press Enter. Filters:{" "}
            <code>from:Name</code>, <code>before:</code>/<code>after:</code>{" "}
            <code>YYYY-MM-DD</code>.
          </div>
        )}
        {results !== undefined && results.length === 0 && (
          <div className={styles.searchNote}>No matches.</div>
        )}
        {results?.map((result) => (
          // A div, not a <button>: the RichText snippet renders its own
          // buttons (link chips, #channel, [user]) and nesting them in a
          // button is invalid HTML with double-action clicks (audit). The
          // snippet is inert (CSS pointer-events: none) — the row is the
          // one action.
          <div
            key={result.id}
            role="button"
            tabIndex={0}
            className={styles.searchHit}
            onClick={() => {
              jump(result);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                jump(result);
              }
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
          </div>
        ))}
        {search.canLoadMore && (
          <button
            type="button"
            className={styles.searchMore}
            disabled={busy}
            onClick={search.loadMore}
          >
            {busy ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}
