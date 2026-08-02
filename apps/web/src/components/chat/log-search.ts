// In-log search state (M9 step 3), owned by the header toolbar's search
// field. Every fetch starts in an event handler — submit, scope flip, load
// more — so the results panel underneath stays presentational and nothing
// searches behind the user's back.
//
// The query mini-language (from: / before: / after:) is parsed server-side;
// this only carries the text and the scope.

import { useCallback, useRef, useState } from "react";
import { api, ApiError, type SearchResultDto } from "../../lib/api.js";

/** The API scope: this one conversation, or the whole account. */
export function searchScope(
  everywhere: boolean,
  convId: string | undefined,
): { convId?: string } {
  return everywhere || convId === undefined ? {} : { convId };
}

/** A fresh search replaces the list; a cursor page appends to it. */
export function mergePage(
  existing: SearchResultDto[] | undefined,
  page: SearchResultDto[],
  cursor: number | undefined,
): SearchResultDto[] {
  return cursor === undefined ? page : [...(existing ?? []), ...page];
}

export interface LogSearch {
  everywhere: boolean;
  /** No conversation on screen — Everywhere is the only scope on offer. */
  scopeLocked: boolean;
  /** Undefined until the first search runs. */
  results: SearchResultDto[] | undefined;
  busy: boolean;
  error: string | undefined;
  canLoadMore: boolean;
  submit: (text: string) => void;
  setEverywhere: (everywhere: boolean) => void;
  loadMore: () => void;
}

export function useLogSearch(
  identityId: string,
  convId: string | undefined,
): LogSearch {
  const [everywhere, setEverywhereState] = useState(convId === undefined);
  const [results, setResults] = useState<SearchResultDto[]>();
  const [nextCursor, setNextCursor] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The last submitted text: a scope flip re-asks the same question of a
  // different corpus, and Load more pages the same one.
  const asked = useRef("");

  const run = useCallback(
    async (text: string, inEverywhere: boolean, cursor: number | undefined) => {
      if (cursor === undefined) {
        setResults(undefined);
        setNextCursor(undefined);
      }
      setBusy(true);
      setError(undefined);
      try {
        const page = await api.searchMessages(identityId, text, {
          ...searchScope(inEverywhere, convId),
          cursor,
        });
        setResults((existing) => mergePage(existing, page.results, cursor));
        setNextCursor(page.nextCursor);
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : "Search failed");
      } finally {
        setBusy(false);
      }
    },
    [convId, identityId],
  );

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed === "") {
        return;
      }
      asked.current = trimmed;
      void run(trimmed, everywhere, undefined);
    },
    [everywhere, run],
  );

  const setEverywhere = useCallback(
    (next: boolean) => {
      setEverywhereState(next);
      if (asked.current !== "") {
        void run(asked.current, next, undefined);
      }
    },
    [run],
  );

  const loadMore = useCallback(() => {
    if (nextCursor !== undefined && !busy) {
      void run(asked.current, everywhere, nextCursor);
    }
  }, [busy, everywhere, nextCursor, run]);

  return {
    everywhere,
    scopeLocked: convId === undefined,
    results,
    busy,
    error,
    canLoadMore: nextCursor !== undefined,
    submit,
    setEverywhere,
    loadMore,
  };
}
