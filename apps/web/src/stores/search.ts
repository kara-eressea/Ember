// Character-search state (M10): one in-flight search per identity, its
// outcome from the `character.search` reply event, and the pace clock the
// dialog's cooldown button reads. The server enforces the real one-per-5s
// pace; the client mirrors it so the button can say why it waits.

import { create } from "zustand";

export interface SearchRefusal {
  code: number;
  message: string;
}

interface IdentitySearch {
  searching: boolean;
  /** Bare character names, as the wire returns them. */
  results?: string[];
  /** The kink ids the reply echoed (what the results matched on). */
  kinks?: string[];
  refusal?: SearchRefusal;
  /** Epoch ms of the last fired search — drives the cooldown button. */
  lastSearchAt: number;
}

interface SearchState {
  byIdentity: Record<string, IdentitySearch>;
  /** Marks a search in flight; returns the pace-clock stamp it wrote so a
   * watchdog can later tell whether that same search is still running. */
  beginSearch: (identityId: string) => number;
  applyOutcome: (
    identityId: string,
    outcome:
      | { ok: true; characters: string[]; kinks: string[] }
      | { ok: false; code: number; message: string },
  ) => void;
  /** Ends a wedged search (refused command or lost reply) — no-ops unless
   * the identity is still searching, and, when `firedAt` is given, unless
   * it is still the same search. */
  failSearch: (
    identityId: string,
    firedAt: number | undefined,
    message: string,
  ) => void;
  /** Back to the filter view — drops results/refusal, keeps the pace clock. */
  clear: (identityId: string) => void;
}

const IDLE: IdentitySearch = { searching: false, lastSearchAt: 0 };

export const useSearchStore = create<SearchState>()((set) => ({
  byIdentity: {},
  beginSearch(identityId) {
    const firedAt = Date.now();
    set((state) => ({
      byIdentity: {
        ...state.byIdentity,
        [identityId]: {
          ...(state.byIdentity[identityId] ?? IDLE),
          searching: true,
          refusal: undefined,
          lastSearchAt: firedAt,
        },
      },
    }));
    return firedAt;
  },
  failSearch(identityId, firedAt, message) {
    set((state) => {
      const current = state.byIdentity[identityId];
      // Only the search that armed this failure may report it — a reply
      // (or a newer search) that already moved the state wins.
      if (
        current?.searching !== true ||
        (firedAt !== undefined && current.lastSearchAt !== firedAt)
      ) {
        return state;
      }
      return {
        byIdentity: {
          ...state.byIdentity,
          [identityId]: {
            ...current,
            searching: false,
            refusal: { code: 0, message },
          },
        },
      };
    });
  },
  applyOutcome(identityId, outcome) {
    set((state) => {
      const current = state.byIdentity[identityId] ?? IDLE;
      return {
        byIdentity: {
          ...state.byIdentity,
          [identityId]: outcome.ok
            ? {
                ...current,
                searching: false,
                results: outcome.characters,
                kinks: outcome.kinks,
                refusal: undefined,
              }
            : {
                ...current,
                searching: false,
                refusal: { code: outcome.code, message: outcome.message },
              },
        },
      };
    });
  },
  clear(identityId) {
    set((state) => ({
      byIdentity: {
        ...state.byIdentity,
        [identityId]: {
          ...(state.byIdentity[identityId] ?? IDLE),
          searching: false,
          results: undefined,
          kinks: undefined,
          refusal: undefined,
        },
      },
    }));
  },
}));
