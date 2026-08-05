/**
 * The chooser page's entire connection to the rest of the world: two calls on
 * `window.emberchat` (mx3-desktop-shell.md §4).
 *
 * Unlike `preload.cts` — which touches the page's storage and exposes nothing
 * — this one does use `contextBridge`, because the chooser is a page this
 * package wrote and the only page these channels are reachable from. What
 * crosses the bridge is two functions taking a string and returning a plain
 * result object. No `ipcRenderer`, no `require`, no filesystem, no fetch: the
 * page cannot reach the network at all (its CSP allows nothing remote), which
 * is why the `/healthz` probe runs on the other side of these calls.
 *
 * CommonJS on purpose (`.cts` → `dist/chooser-preload.cjs`): sandboxed
 * preloads are not ES modules, which is also why the two channel names are
 * spelled here as literals instead of imported from `chooser-ipc.ts`.
 * `startup.test.ts` asserts they still match.
 */

import electron = require("electron");

/** Must equal `CHOOSE_LOCAL_CHANNEL` in chooser-ipc.ts. */
const CHOOSE_LOCAL_CHANNEL = "emberchat:choose-local";
/** Must equal `CHOOSE_THIN_CLIENT_CHANNEL` in chooser-ipc.ts. */
const CHOOSE_THIN_CLIENT_CHANNEL = "emberchat:choose-thin-client";

/** Mirrors `ChoiceResult` in chooser-ipc.ts. */
interface ChoiceResult {
  ok: boolean;
  message?: string;
}

async function choose(
  channel: string,
  ...args: unknown[]
): Promise<ChoiceResult> {
  return (await electron.ipcRenderer.invoke(channel, ...args)) as ChoiceResult;
}

electron.contextBridge.exposeInMainWorld("emberchat", {
  chooseLocal: () => choose(CHOOSE_LOCAL_CHANNEL),
  chooseThinClient: (url: string) => choose(CHOOSE_THIN_CLIENT_CHANNEL, url),
});
