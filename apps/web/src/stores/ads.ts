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
  applyAds: (identityId: string, ads: AdDto[]) => void;
}

export const useAdsStore = create<AdsState>()((set) => ({
  byIdentity: {},
  applyAds(identityId, ads) {
    set((state) => ({
      byIdentity: {
        ...state.byIdentity,
        [identityId]: { ads, loaded: true },
      },
    }));
  },
}));

/** The ids the client last saw — the PUT compare-and-set token. */
export function knownIdsFor(identityId: string): string[] | undefined {
  const entry = useAdsStore.getState().byIdentity[identityId];
  return entry?.loaded ? entry.ads.map((ad) => ad.id) : undefined;
}
