// The one write path for preference edits: optimistic local apply (all
// slices — prefs are per user) + theme repaint, then the gateway `prefs.set`
// patch. Convergence is the `prefs.updated` fan-out; a refused ack rolls the
// optimistic state back so the UI never lies about what's persisted.

import { PREFS_DEFAULTS } from "@emberchat/protocol";
import type { UserPrefs, UserPrefsPatch } from "@emberchat/protocol";
import { gateway } from "../../gateway/socket.js";
import { useSessionsStore } from "../../stores/sessions.js";
import { hydrateTheme } from "../../theme/theme.js";

export async function patchPrefs(
  identityId: string,
  patch: UserPrefsPatch,
): Promise<boolean> {
  const store = useSessionsStore.getState();
  const current = store.sessions[identityId]?.prefs ?? PREFS_DEFAULTS;
  const next: UserPrefs = { ...current, ...patch };
  store.applyPrefsLocal(next);
  hydrateTheme(next);
  const ack = await gateway.cmd({
    identityId,
    action: "prefs.set",
    d: { prefs: patch },
  });
  if (!ack.ok) {
    useSessionsStore.getState().applyPrefsLocal(current);
    hydrateTheme(current);
  }
  return ack.ok;
}
