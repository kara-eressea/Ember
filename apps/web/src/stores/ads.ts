// Ad library mirror (M10): the server owns the list (REST GET/PUT with a
// knownIds compare-and-set); this store is the per-identity client mirror,
// updated from REST responses and the `ads.updated` gateway fan-out so every
// device's Ad Center converges without refetching.

import { create } from "zustand";
import type { AdDto } from "@emberchat/protocol";

interface IdentityAds {
  ads: AdDto[];
  /** False until the first GET/fan-out lands — distinguishes "no ads" from
   * "not loaded yet". */
  loaded: boolean;
}

interface AdsState {
  byIdentity: Record<string, IdentityAds>;
  /** Per-channel ad-cooldown expiry (epoch ms), keyed identity → channel.
   * Fed by the `ads.cooldowns` reply and by our own successful posts; the
   * dialog renders "next allowed in Xm" from these. */
  cooldownsByIdentity: Record<string, Record<string, number>>;
  applyAds: (identityId: string, ads: AdDto[]) => void;
  applyCooldowns: (identityId: string, waits: Record<string, number>) => void;
  markPosted: (identityId: string, key: string, floodSeconds: number) => void;
}

export const useAdsStore = create<AdsState>()((set) => ({
  byIdentity: {},
  cooldownsByIdentity: {},
  applyAds(identityId, ads) {
    set((state) => ({
      byIdentity: {
        ...state.byIdentity,
        [identityId]: { ads, loaded: true },
      },
    }));
  },
  applyCooldowns(identityId, waits) {
    const now = Date.now();
    set((state) => ({
      cooldownsByIdentity: {
        ...state.cooldownsByIdentity,
        [identityId]: {
          ...state.cooldownsByIdentity[identityId],
          ...Object.fromEntries(
            Object.entries(waits).map(([key, ms]) => [key, now + ms]),
          ),
        },
      },
    }));
  },
  markPosted(identityId, key, floodSeconds) {
    set((state) => ({
      cooldownsByIdentity: {
        ...state.cooldownsByIdentity,
        [identityId]: {
          ...state.cooldownsByIdentity[identityId],
          [key]: Date.now() + floodSeconds * 1000,
        },
      },
    }));
  },
}));

/** The ids the client last saw — the PUT compare-and-set token. */
export function knownIdsFor(identityId: string): string[] | undefined {
  const entry = useAdsStore.getState().byIdentity[identityId];
  return entry?.loaded ? entry.ads.map((ad) => ad.id) : undefined;
}
