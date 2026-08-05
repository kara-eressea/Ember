/**
 * The contract between the chooser page and the main process — the only IPC
 * this package has besides the auth seed, and deliberately just as small.
 *
 * Two channels, two calls, no state: the page can say "local" or "this URL",
 * and gets back either a closed window or a sentence to display. Everything
 * else about a choice — validating the URL, reaching the server, writing the
 * config, deciding whether to relaunch — happens in the main process, where
 * the filesystem and the network already live.
 *
 * `chooser-preload.cts` repeats these two strings, because a sandboxed
 * CommonJS preload cannot import this ES module; `startup.test.ts` is the seam
 * that keeps the spellings equal.
 */

export const CHOOSE_LOCAL_CHANNEL = "emberchat:choose-local";
export const CHOOSE_THIN_CLIENT_CHANNEL = "emberchat:choose-thin-client";

/** What either call answers with. `ok` closes the window; the rest is shown. */
export type ChoiceResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string };
