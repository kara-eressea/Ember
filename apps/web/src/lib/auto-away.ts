// Client idle → auto-away (M5, decisions.md §10). A periodic check compares
// the last user activity against the pref threshold and, once crossed, sets
// STA away (with the user's away message) on every online identity whose
// status is plain "online" — a manually chosen away/busy/looking/dnd is the
// user's and is never clobbered.
//
// Two hard-won rules from the M5 audit:
// - Activity is shared across same-browser tabs via localStorage: a
//   background tab receives no DOM activity events, so judging idleness
//   from tab-local state alone would flip an actively typing user to away
//   from their other tab.
// - Restore recognizes our own away by VALUE (status "away" + statusmsg
//   equal to the away-message pref), not just by a local record: the
//   bouncer holds the status while tabs are ephemeral, so a reload — or
//   the away having been set by another device's idle tab — must still
//   hand back to "online" when the user is demonstrably active.

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
/** The restore scan runs at most this often — pointermove fires constantly. */
const RESTORE_SCAN_INTERVAL_MS = 1_000;
const ACTIVITY_STORAGE_KEY = "eb.lastActivity";

let lastActivity = 0;
let lastRestoreScan = 0;
/** identityId → the statusmsg "online" carried before we set away. */
const applied = new Map<string, string>();

/** Newest activity across this browser's tabs (localStorage-shared). */
function sharedLastActivity(): number {
  let stored = 0;
  try {
    stored = Number(localStorage.getItem(ACTIVITY_STORAGE_KEY)) || 0;
  } catch {
    // Storage unavailable (private mode) — tab-local activity only.
  }
  return Math.max(lastActivity, stored);
}

function publishActivity(now: number): void {
  try {
    localStorage.setItem(ACTIVITY_STORAGE_KEY, String(now));
  } catch {
    // Best-effort.
  }
}

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
  if (now - sharedLastActivity() < prefs.autoAwayMinutes * 60_000) {
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
  publishActivity(now);
  // Throttled restore scan: cheap on the steady state, prompt enough that
  // an away applied elsewhere clears within a second of real activity.
  if (now - lastRestoreScan < RESTORE_SCAN_INTERVAL_MS && applied.size === 0) {
    return;
  }
  lastRestoreScan = now;
  const prefs = currentPrefs();
  for (const session of Object.values(useSessionsStore.getState().sessions)) {
    const previous = applied.get(session.identityId);
    applied.delete(session.identityId);
    if (!prefs.autoAwayClearOnReturn) {
      continue;
    }
    if (
      !session.synced ||
      session.sessionStatus !== "online" ||
      session.ownStatus !== "away"
    ) {
      continue;
    }
    // Only ever hand back OUR away: the message must match the pref — a
    // manual away set from another device (different message) stays.
    if (session.ownStatusmsg !== prefs.autoAwayMessage) {
      continue;
    }
    // Without a local record (reload, or another tab/device applied it),
    // only act when the feature is on — otherwise an away that merely
    // resembles ours is none of our business.
    if (previous === undefined && !prefs.autoAwayEnabled) {
      continue;
    }
    void gateway.cmd({
      identityId: session.identityId,
      action: "status.set",
      d: { status: "online", statusmsg: previous ?? "" },
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
  lastRestoreScan = 0;
  applied.clear();
  try {
    localStorage.removeItem(ACTIVITY_STORAGE_KEY);
  } catch {
    // No storage in this environment.
  }
}
