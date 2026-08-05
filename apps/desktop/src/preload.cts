/**
 * The whole renderer-side surface of this package (spec invariant 2): it hands
 * the main process's session to the web app by leaving it where the web app's
 * own auth store already looks — `localStorage["eb.auth"]` — before any of the
 * page's scripts run. The renderer wakes up signed in and never meets the
 * login screen. Nothing is exposed on `window`; no bridge, no API.
 *
 * **Why `sendSync`.** Preload code runs to completion before the document's
 * scripts, and only synchronous work can hold that window: an async fetch would
 * resolve after the app's store had already read an empty localStorage and
 * decided it was anonymous. `ipcRenderer.sendSync` blocks this one preload for
 * the microseconds it takes the main process to answer with a payload it
 * computed at boot — the accepted cost for exactly one small message at startup.
 * (`additionalArguments` was the alternative; it would put a live refresh token
 * into the renderer process's command line, visible in `ps` to every process on
 * the machine. Blocking briefly is the cheaper price.)
 *
 * `sandbox: true` stays on: sandboxed preloads get `ipcRenderer` and share the
 * page's DOM (hence its `localStorage`) from their isolated world, which is all
 * this needs.
 *
 * CommonJS on purpose (`.cts` → `dist/preload.cjs`): sandboxed preloads are not
 * ES modules. That also means it cannot import `auth-seed.ts` for the channel
 * name, so the string is repeated below — `preload.test.ts` asserts the two
 * spellings still match.
 */

import electron = require("electron");

/** Must equal `AUTH_SEED_CHANNEL` in auth-seed.ts. */
const AUTH_SEED_CHANNEL = "emberchat:auth-seed";

interface AuthSeedMessage {
  key: string;
  value: string;
}

// This package compiles against Node's types only — there is no renderer
// bundle and no DOM lib. Rather than pull one in for a single file, here is
// the entire browser surface the preload is allowed to touch.
declare const window: {
  localStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
};

const seed = electron.ipcRenderer.sendSync(
  AUTH_SEED_CHANNEL,
) as AuthSeedMessage | null;

if (seed !== null) {
  try {
    // Unconditional, because the main process hands out this boot's seed
    // exactly once (`createSeedDispenser`): getting one means nothing has
    // consumed it yet, and this boot's session beats whatever stale token an
    // earlier boot left behind. A reload gets `null` and leaves storage alone.
    window.localStorage.setItem(seed.key, seed.value);
  } catch {
    // A page without accessible storage is not the app; leave it alone. The
    // user still sees the login screen rather than a broken window.
  }
}
