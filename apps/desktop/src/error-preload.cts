/**
 * The remote-session error page's entire connection to the rest of the world:
 * two calls on `window.emberchat` (mx3-desktop-shell.md §5).
 *
 * Same shape as `chooser-preload.cts`, and deliberately not the same file: the
 * two pages are different windows with different channels, and a shared preload
 * would mean each page could call the other's. What crosses this bridge is two
 * functions taking nothing and returning a plain result object. No
 * `ipcRenderer`, no `require`, no filesystem, no fetch — the page cannot reach
 * the network at all (its CSP allows nothing remote), which is why the retry's
 * `/healthz` probe runs on the other side of these calls.
 *
 * It is emphatically *not* `preload.cts`, the auth-seed one the app window
 * carries: that preload exposes nothing on `window` and touches the page's
 * storage, and the error page has no business with either. Keeping them apart
 * is what lets the app window keep a preload with no bridge at all.
 *
 * CommonJS on purpose (`.cts` → `dist/error-preload.cjs`): sandboxed preloads
 * are not ES modules, which is also why the two channel names are spelled here
 * as literals instead of imported from `error-ipc.ts`. `thin-client.test.ts`
 * asserts they still match.
 */

import electron = require("electron");

/** Must equal `REMOTE_RETRY_CHANNEL` in error-ipc.ts. */
const REMOTE_RETRY_CHANNEL = "emberchat:remote-retry";
/** Must equal `REMOTE_SWITCH_MODE_CHANNEL` in error-ipc.ts. */
const REMOTE_SWITCH_MODE_CHANNEL = "emberchat:remote-switch-mode";

/** Mirrors `RemoteActionResult` in error-ipc.ts. */
interface RemoteActionResult {
  ok: boolean;
  failure?: { headline: string; detail: string; code?: string };
}

async function call(channel: string): Promise<RemoteActionResult> {
  return (await electron.ipcRenderer.invoke(channel)) as RemoteActionResult;
}

electron.contextBridge.exposeInMainWorld("emberchat", {
  retry: () => call(REMOTE_RETRY_CHANNEL),
  switchMode: () => call(REMOTE_SWITCH_MODE_CHANNEL),
});
