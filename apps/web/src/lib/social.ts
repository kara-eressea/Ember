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
  if (running) {
    return running;
  }
  const load = api
    .getSocial(identityId)
    .then((data) => {
      useSessionsStore
        .getState()
        .applySocial(identityId, { ...data, fetchedAt: Date.now() });
    })
    .finally(() => {
      inflight.delete(identityId);
    });
  inflight.set(identityId, load);
  return load;
}
