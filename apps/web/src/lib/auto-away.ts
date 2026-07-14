// Client idle → auto-away (M5, decisions.md §10). A periodic check compares
// the last user activity against the pref threshold and, once crossed, sets
// STA away (with the user's away message) on every online identity whose
// status is plain "online" — a manually chosen away/busy/looking/dnd is the
// user's and is never clobbered. Activity restores what we replaced (the
// clear-on-return pref), and only if the status is still our away — a
// status changed from another device stays.

import { PREFS_DEFAULTS, type UserPrefs } from "@emberchat/protocol";
import { gateway } from "../gateway/socket.js";
import { useSessionsStore } from "../stores/sessions.js";

const ACTIVITY_EVENTS = [
  "pointermove",
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
] as const;
const CHECK_INTERVAL_MS = 15_000;

let lastActivity = 0;
/** identityId → the statusmsg "online" carried before we set away. */
const applied = new Map<string, string>();

/** Prefs from any synced slice — they are per user (cf. useUserPrefs). */
function currentPrefs(): UserPrefs {
  for (const session of Object.values(useSessionsStore.getState().sessions)) {
    if (session.synced) {
      return session.prefs;
    }
  }
  return PREFS_DEFAULTS;
}

/** The interval body — exported for tests. */
export function checkIdle(now = Date.now()): void {
  const prefs = currentPrefs();
  if (!prefs.autoAwayEnabled || applied.size > 0) {
    return;
  }
  if (now - lastActivity < prefs.autoAwayMinutes * 60_000) {
    return;
  }
  for (const session of Object.values(useSessionsStore.getState().sessions)) {
    if (
      !session.synced ||
      session.sessionStatus !== "online" ||
      session.ownStatus !== "online"
    ) {
      continue;
    }
    applied.set(session.identityId, session.ownStatusmsg);
    void gateway.cmd({
      identityId: session.identityId,
      action: "status.set",
      d: { status: "away", statusmsg: prefs.autoAwayMessage },
    });
  }
}

/** Every activity event lands here — exported for tests. */
export function noteActivity(now = Date.now()): void {
  lastActivity = now;
  if (applied.size === 0) {
    return;
  }
  const restore = currentPrefs().autoAwayClearOnReturn;
  const sessions = useSessionsStore.getState().sessions;
  for (const [identityId, statusmsg] of [...applied]) {
    applied.delete(identityId);
    if (!restore) {
      continue;
    }
    const session = sessions[identityId];
    if (
      !session ||
      session.sessionStatus !== "online" ||
      session.ownStatus !== "away"
    ) {
      continue; // gone, or the user picked a status meanwhile — theirs wins
    }
    void gateway.cmd({
      identityId,
      action: "status.set",
      d: { status: "online", statusmsg },
    });
  }
}

/** Installs the listeners + check interval; returns the teardown. */
export function startAutoAway(): () => void {
  lastActivity = Date.now();
  const onActivity = () => {
    noteActivity();
  };
  for (const name of ACTIVITY_EVENTS) {
    window.addEventListener(name, onActivity, { passive: true });
  }
  const timer = setInterval(() => {
    checkIdle();
  }, CHECK_INTERVAL_MS);
  return () => {
    for (const name of ACTIVITY_EVENTS) {
      window.removeEventListener(name, onActivity);
    }
    clearInterval(timer);
  };
}

/** Test-only: reset the module state between cases. */
export function resetAutoAwayForTest(now = 0): void {
  lastActivity = now;
  applied.clear();
}
