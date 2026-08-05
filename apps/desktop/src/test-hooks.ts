/**
 * One test hook, for the one part of §6 nothing else can reach.
 *
 * Close-to-tray is a click on a window's close button, a hidden window and a
 * menu item in the system tray — none of which a headless test, this repo's
 * Playwright, or any amount of unit testing can produce. The decisions behind
 * them are pure functions with tests (`tray-model.ts`); what stays unproven is
 * the wiring: that closing the window really does keep the process and its
 * bouncer alive, and that the tray's Quit really does stop the child.
 *
 * So the app drives itself. With `EMBER_DESKTOP_LIFECYCLE_PROBE` set, local
 * mode closes its own window a couple of seconds after it opens (and, for
 * `close-then-quit`, invokes the same function the tray's Quit item calls a
 * couple of seconds after that). A verification run then watches the process
 * and `/healthz` from outside: alive and answering after the close, gone after
 * the quit. No GUI automation, no AppleScript — the main process calling its
 * own methods.
 *
 * It is kept rather than deleted because MX4's packaged-build smoke test wants
 * exactly this, and because it costs one `process.env` read at startup. Unset,
 * nothing in this file does anything.
 */

export const LIFECYCLE_PROBE_ENV = "EMBER_DESKTOP_LIFECYCLE_PROBE";

export type LifecycleProbe =
  /** Close the app window once, and then leave the app alone. */
  | "close"
  /** Close it, then take the tray's Quit path. */
  | "close-then-quit";

/** The probe this launch was asked for, or `undefined` — which is the default. */
export function lifecycleProbe(env: {
  readonly [key: string]: string | undefined;
}): LifecycleProbe | undefined {
  const value = env[LIFECYCLE_PROBE_ENV]?.trim();
  return value === "close" || value === "close-then-quit" ? value : undefined;
}
