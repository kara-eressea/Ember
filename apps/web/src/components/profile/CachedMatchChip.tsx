// Cache-only compatibility chip (M10): the M8 MatchPill compact size,
// rendered when — and only when — both profiles are already loaded in this
// session's cache. Never triggers a fetch, so on most rows it renders
// nothing and that absence is the normal look (CD spec §5/§6d). Shared by
// ad rows and search results.

import { useMemo } from "react";
import { match } from "@emberchat/matcher";
import { useProfileStore } from "../../stores/profile.js";
import { MatchPill } from "./MatchTier.js";

export function CachedMatchChip({ name }: { name: string }) {
  const loaded = useProfileStore((s) => s.profiles[name.toLowerCase()]);
  const own = useProfileStore((s) => s.ownProfile?.profile);
  const theirs = loaded?.response?.profile;
  const tier = useMemo(
    () => (own && theirs ? match(own, theirs).overall : undefined),
    [own, theirs],
  );
  if (tier === undefined) {
    return null;
  }
  return <MatchPill tier={tier} short compact />;
}
