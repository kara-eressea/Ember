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
  beginSearch: (identityId: string) => void;
  applyOutcome: (
    identityId: string,
    outcome:
      | { ok: true; characters: string[]; kinks: string[] }
      | { ok: false; code: number; message: string },
  ) => void;
  /** Back to the filter view — drops results/refusal, keeps the pace clock. */
  clear: (identityId: string) => void;
}

const IDLE: IdentitySearch = { searching: false, lastSearchAt: 0 };

export const useSearchStore = create<SearchState>()((set) => ({
  byIdentity: {},
  beginSearch(identityId) {
    set((state) => ({
      byIdentity: {
        ...state.byIdentity,
        [identityId]: {
          ...(state.byIdentity[identityId] ?? IDLE),
          searching: true,
          refusal: undefined,
          lastSearchAt: Date.now(),
        },
      },
    }));
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
