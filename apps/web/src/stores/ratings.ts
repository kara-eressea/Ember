// Ad-ratings store (M11): the user's local ★1–5 + notes on other posters,
// loaded once per app session and keyed by lowercased character so every
// ad row can look itself up cheaply. Per app user — the same map serves
// every identity. Writes are optimistic (the editor shows "Saved" from
// the response); other devices converge on their next load.

import { create } from "zustand";
import type { RatingDto } from "@emberchat/protocol";
import { api } from "../lib/api.js";

interface RatingsState {
  loaded: boolean;
  byName: Record<string, RatingDto>;
  /** One fetch per app session (call sites may call it freely). */
  load: () => Promise<void>;
  /** Upsert through the REST API; resolves false when the server said no. */
  save: (character: string, score: number, note?: string) => Promise<boolean>;
  /** Clear through the REST API (a missing row still clears locally). */
  clear: (character: string) => Promise<void>;
}

let loading: Promise<void> | undefined;

export const useRatingsStore = create<RatingsState>()((set, get) => ({
  loaded: false,
  byName: {},

  async load() {
    if (get().loaded) {
      return;
    }
    loading ??= api
      .getRatings()
      .then((response) => {
        const byName: Record<string, RatingDto> = {};
        for (const rating of response.ratings) {
          byName[rating.character.toLowerCase()] = rating;
        }
        // A save that landed while the GET was in flight is newer than
        // the fetched snapshot — local entries win the merge.
        set((state) => ({
          loaded: true,
          byName: { ...byName, ...state.byName },
        }));
      })
      .catch(() => {
        // A failed load retries on the next call.
        loading = undefined;
      });
    await loading;
  },

  async save(character, score, note) {
    try {
      const response = await api.putRating(character, score, note);
      set((state) => ({
        byName: {
          ...state.byName,
          [character.toLowerCase()]: response.rating,
        },
      }));
      return true;
    } catch {
      return false;
    }
  },

  async clear(character) {
    const lower = character.toLowerCase();
    set((state) => {
      const byName = { ...state.byName };
      delete byName[lower];
      return { byName };
    });
    await api.deleteRating(character).catch(() => undefined);
  },
}));

/** The rating for a character, if any (lowercase lookup). */
export function ratingFor(
  byName: Record<string, RatingDto>,
  character: string,
): RatingDto | undefined {
  return byName[character.toLowerCase()];
}
