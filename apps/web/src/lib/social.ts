// Lazy loader for the per-identity social lists (M6 step 7). The server
// caches the lists (#194) — a plain GET is served from cache, the snapshot
// seeds them on attach, and social.updated fan-out keeps them live (#199).
// Loads stay single-flighted per identity; force (the manual refresh, and
// mutations whose upstream effects the server cannot patch) refetches from
// F-List — four upstream calls on a 1 req/s budget.

import { useSessionsStore } from "../stores/sessions.js";
import { api } from "./api.js";

const inflight = new Map<string, Promise<void>>();

export function loadSocial(identityId: string, force = false): Promise<void> {
  const existing = useSessionsStore.getState().sessions[identityId]?.social;
  if (existing && !force) {
    return Promise.resolve();
  }
  const running = inflight.get(identityId);
  if (running && !force) {
    return running;
  }
  // A forced refresh must NOT join a stale in-flight load: a GET is four
  // upstream calls (seconds), so "mutate, then force-refresh" routinely
  // overlaps the initial load — joining it would render pre-mutation lists
  // (M6 audit). Chain a fresh fetch behind whatever is running instead.
  const fetchNow = () =>
    api.getSocial(identityId, force).then((data) => {
      useSessionsStore
        .getState()
        .applySocial(identityId, { ...data, fetchedAt: Date.now() });
    });
  const load = (
    running ? running.catch(() => undefined).then(fetchNow) : fetchNow()
  ).finally(() => {
    if (inflight.get(identityId) === load) {
      inflight.delete(identityId);
    }
  });
  inflight.set(identityId, load);
  return load;
}
