// Lazy loader for the per-identity social lists (M6 step 7). One GET is
// four upstream F-List calls on a 1 req/s budget, so loads are
// single-flighted per identity and reused until a mutation forces a
// refresh (no TTL — presence on the rows is a nicety, not live state).

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
    api.getSocial(identityId).then((data) => {
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
