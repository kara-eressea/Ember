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
/**
 * How long one of our automatic STA sends is treated as in-flight before we
 * let the same identity be re-sent. Purely our own client-side pacing (not a
 * protocol VAR): F-Chat rejects status changes made closer together than
 * ~15 s, so a resend inside that window earns an ERR that we would otherwise
 * surface to the user. Sat just past ~15 s so a post-window retry lands clear
 * of the server's gate. The guard is normally released far sooner — the moment
 * the server echo flips the store to our target status (see #statusPending).
 */
const STATUS_SEND_COOLDOWN_MS = 16_000;
const ACTIVITY_STORAGE_KEY = "eb.lastActivity";

let lastActivity = 0;
let lastRestoreScan = 0;
/** What we replaced when we set an identity away, so a return can undo it. */
interface AppliedAway {
  /** The statusmsg the identity carried while "online", to hand back. */
  priorMsg: string;
  /** The away message we actually sent — remembered so editing the pref
   * afterwards doesn't orphan the restore (the wire still holds the old one). */
  awayMsg: string;
}
const applied = new Map<string, AppliedAway>();

/** An automatic STA we put on the wire, kept until the echo or the cooldown. */
interface PendingStatus {
  until: number;
  status: string;
  statusmsg: string;
}
/** identityId → our in-flight automatic STA. Guards against a second send
 * racing ahead of the server echo (issue #358). */
const pending = new Map<string, PendingStatus>();

/**
 * True while an automatic STA we sent for this identity is still in flight:
 * the store has not yet echoed our target status and the cooldown has not
 * elapsed. Clears the entry once either happens, so callers both skip a resend
 * and stop suppressing errors the moment the guard is spent.
 */
function statusPending(
  session: { ownStatus: string; ownStatusmsg: string; identityId: string },
  now: number,
): boolean {
  const entry = pending.get(session.identityId);
  if (entry === undefined) {
    return false;
  }
  if (now >= entry.until) {
    pending.delete(session.identityId); // cooldown elapsed — a retry is allowed
    return false;
  }
  if (
    session.ownStatus === entry.status &&
    session.ownStatusmsg === entry.statusmsg
  ) {
    pending.delete(session.identityId); // our echo landed — the change took
    return false;
  }
  return true;
}

/** Records an automatic STA as in-flight and puts it on the wire. */
function sendAutoStatus(
  identityId: string,
  status: "away" | "online",
  statusmsg: string,
  now: number,
): void {
  pending.set(identityId, {
    until: now + STATUS_SEND_COOLDOWN_MS,
    status,
    statusmsg,
  });
  void gateway.cmd({
    identityId,
    action: "status.set",
    d: { status, statusmsg },
  });
}

/**
 * Whether an `error` arriving now for this identity is the rejection of our
 * own automatic STA (and so must not surface as a user-facing warning). True
 * only while such a send is in flight — a manual status change from the rail
 * or sidebar leaves no pending entry, so its errors still show. Consulted by
 * gateway/dispatch (issue #358 part 2).
 */
export function isAutoStatusInFlight(
  identityId: string,
  now = Date.now(),
): boolean {
  const entry = pending.get(identityId);
  return entry !== undefined && now < entry.until;
}

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
    // Skip an identity whose last automatic STA is still in flight — a resend
    // ahead of the echo would trip the server's status cooldown (#358).
    if (statusPending(session, now)) {
      continue;
    }
    applied.set(session.identityId, {
      priorMsg: session.ownStatusmsg,
      awayMsg: prefs.autoAwayMessage,
    });
    sendAutoStatus(session.identityId, "away", prefs.autoAwayMessage, now);
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
    const record = applied.get(session.identityId);
    if (!prefs.autoAwayClearOnReturn) {
      applied.delete(session.identityId);
      continue;
    }
    // In-flight guard: an away or restore we already sent is still awaiting
    // its echo. Leave the local record intact and retry after the cooldown —
    // resending now would race the echo into the server's status gate (#358).
    if (statusPending(session, now)) {
      continue;
    }
    if (
      !session.synced ||
      session.sessionStatus !== "online" ||
      session.ownStatus !== "away"
    ) {
      applied.delete(session.identityId);
      continue;
    }
    // Only ever hand back OUR away. With a local record, match the message we
    // actually sent — so editing the away pref while away doesn't orphan the
    // restore; without one (reload, other tab/device), fall back to the pref.
    const ourAwayMsg = record?.awayMsg ?? prefs.autoAwayMessage;
    if (session.ownStatusmsg !== ourAwayMsg) {
      applied.delete(session.identityId);
      continue;
    }
    // Without a local record (reload, or another tab/device applied it),
    // only act when the feature is on — otherwise an away that merely
    // resembles ours is none of our business.
    if (record === undefined && !prefs.autoAwayEnabled) {
      continue;
    }
    applied.delete(session.identityId);
    sendAutoStatus(session.identityId, "online", record?.priorMsg ?? "", now);
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
  pending.clear();
  try {
    localStorage.removeItem(ACTIVITY_STORAGE_KEY);
  } catch {
    // No storage in this environment.
  }
}
