/**
 * `<userData>/config.json` — which of the two modes this install runs in
 * (mx3-desktop-shell.md §4), and nothing else.
 *
 *   { "version": 1, "mode": "local" }
 *   { "version": 1, "mode": "thin-client", "serverUrl": "https://…" }
 *
 * …plus the optional flags in `DesktopFlags`, each recording something the user
 * has settled once and the app should stop deciding for them:
 *
 *   "trayNoticeSeen": true       close-to-tray has explained itself (§6)
 *   "updateCheckDisabled": true  the daily release check is switched off (#549)
 *
 * All of them are additive and absent until they happen, so the version stays
 * 1: a build that does not know a key ignores it, and a build that does treats
 * a file without it as the default. The worst case in either direction is one
 * extra sentence, or one more release check.
 *
 * Not a secret, and pointedly unlike `secrets.json` next to it: plain JSON,
 * no `safeStorage`, readable and editable by the person whose computer this
 * is. It holds one choice and one address.
 *
 * **Unreadable means absent.** A truncated file, a version this build does not
 * know, a `serverUrl` that is no longer a valid address — all of them return
 * `undefined`, which puts the chooser back on screen. That is the whole
 * recovery story, and it is deliberately the least destructive one available:
 * the local database, the secrets file and the account all survive a config
 * file that got mangled, and re-picking "Use locally" lands back on exactly
 * the install that was already there. (Contrast `secrets.json`, where a
 * corrupt file is a hard error precisely because guessing would strand an
 * account nobody has the password for.)
 *
 * Nothing here imports Electron — `main.ts` passes in `app.getPath("userData")`
 * — so the whole module is testable as plain Node.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeServerUrl } from "./server-url.js";

/** Bumped if the file's shape changes; an unknown version reads as absent. */
export const CONFIG_SCHEMA_VERSION = 1;

/**
 * The settled-once flags (see the module comment). Every one is optional and
 * literally `true` when present — a flag that is absent, `false`, or hand-edited
 * to something else reads as the default, because the cost of misreading any of
 * them is small and the cost of rejecting the whole file is the chooser.
 *
 * They travel together: `configFlags` lifts them off a config and `applyFlags`
 * puts them back, so adding the next one is one line in each rather than a new
 * shape for every function here to know about.
 */
export interface DesktopFlags {
  /** The one-time close-to-tray notice has been shown (§6, #304). */
  readonly trayNoticeSeen?: true;
  /**
   * The user has turned the daily release check off (#549). Stored as the
   * *negative* so that a file which has never heard of the feature — every file
   * written before this build — means "on", which is the server's own default.
   */
  readonly updateCheckDisabled?: true;
}

export type DesktopConfig = DesktopFlags &
  (
    | /** This machine runs the bouncer (§2, §3). */
      { readonly mode: "local" }
      /** The window is a view onto somebody's own server (§5). */
    | { readonly mode: "thin-client"; readonly serverUrl: string }
  );

/** `<userData>/config.json`. */
export function configPath(userDataDir: string): string {
  return join(userDataDir, "config.json");
}

export function encodeConfig(config: DesktopConfig): string {
  const file = {
    version: CONFIG_SCHEMA_VERSION,
    mode: config.mode,
    ...(config.mode === "thin-client" ? { serverUrl: config.serverUrl } : {}),
    // Flags are written only once they are true, so a file belonging to an
    // install that has done none of these things looks exactly as it did before
    // any of the fields existed.
    ...configFlags(config),
  };
  return `${JSON.stringify(file, undefined, 2)}\n`;
}

/** The stored choice, or `undefined` for anything this build cannot honour. */
export function decodeConfig(contents: string): DesktopConfig | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const file = parsed as {
    version?: unknown;
    mode?: unknown;
    serverUrl?: unknown;
    trayNoticeSeen?: unknown;
    updateCheckDisabled?: unknown;
  };
  if (file.version !== CONFIG_SCHEMA_VERSION) {
    return undefined;
  }
  // Anything but a literal `true` — absent, `"yes"`, hand-edited to nonsense —
  // reads as the default: the notice has not been shown, the release check is
  // on. That is why these fields did not need a schema version of their own,
  // and why a wrong value never fails the file (see `DesktopFlags`).
  const flags: DesktopFlags = {
    ...(file.trayNoticeSeen === true ? { trayNoticeSeen: true } : {}),
    ...(file.updateCheckDisabled === true ? { updateCheckDisabled: true } : {}),
  };
  if (file.mode === "local") {
    return { mode: "local", ...flags };
  }
  if (file.mode === "thin-client") {
    if (typeof file.serverUrl !== "string") {
      return undefined;
    }
    // Re-validated on every read, not just on the way in: this string becomes
    // a `loadURL`, and the file is one a person can open in an editor.
    const normalized = normalizeServerUrl(file.serverUrl);
    return normalized.ok
      ? { mode: "thin-client", serverUrl: normalized.url, ...flags }
      : undefined;
  }
  return undefined;
}

/**
 * Flags as they are stored: present when true, absent otherwise. The one place
 * that knows the whole list, so adding the next flag is one line here.
 */
export function configFlags(flags: DesktopFlags): DesktopFlags {
  return {
    ...(flags.trayNoticeSeen === true ? { trayNoticeSeen: true } : {}),
    ...(flags.updateCheckDisabled === true
      ? { updateCheckDisabled: true }
      : {}),
  };
}

/**
 * A config's mode wearing exactly the flags given — every flag not named is
 * dropped, so this is a replacement rather than a merge. Callers that mean
 * "change one thing" spread the current flags first, which is what the two
 * `with*` helpers below do.
 */
function applyFlags(config: DesktopConfig, flags: DesktopFlags): DesktopConfig {
  const kept = configFlags(flags);
  return config.mode === "local"
    ? { mode: "local", ...kept }
    : { mode: "thin-client", serverUrl: config.serverUrl, ...kept };
}

/**
 * The same config with the one-time tray notice marked as said, or not.
 *
 * A function rather than a spread at the call sites because there are two of
 * them and they pull in opposite directions: the close handler sets the flag
 * on whatever is stored, and the chooser writes a *new* config that must carry
 * the old flag across (`carryFlags`) — switching to thin-client mode and back
 * is not a reason to explain the tray a second time.
 */
export function withTrayNoticeSeen(
  config: DesktopConfig,
  seen: boolean,
): DesktopConfig {
  return applyFlags(config, {
    ...configFlags(config),
    trayNoticeSeen: seen ? true : undefined,
  });
}

/**
 * The same config with the daily release check on or off (#549).
 *
 * Stored as `updateCheckDisabled` — the negative — so "on" is the absence of a
 * field and every config file written before this existed already says the
 * right thing. `update-check.ts` reads it back.
 */
export function withUpdateCheck(
  config: DesktopConfig,
  enabled: boolean,
): DesktopConfig {
  return applyFlags(config, {
    ...configFlags(config),
    updateCheckDisabled: enabled ? undefined : true,
  });
}

/**
 * A newly chosen config wearing the flags of whatever was stored before it.
 *
 * The chooser writes a *new* config (§4), and none of these flags is about
 * which install this is: switching to thin-client mode and back should not
 * re-explain the tray, and it should not quietly switch the release check back
 * on for somebody who turned it off.
 */
export function carryFlags(
  config: DesktopConfig,
  previous: DesktopConfig | undefined,
): DesktopConfig {
  return applyFlags(config, previous ?? {});
}

/**
 * The stored config, or `undefined` when there is none to honour — which is
 * the one and only signal for "show the chooser" (see `startup.ts`).
 */
export function readConfig(path: string): DesktopConfig | undefined {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT is a first run. Anything else — a directory in its place, a
    // permission the user changed — is still not worth failing a boot over
    // when the answer is "ask again", but it must not pass silently.
    if (code !== "ENOENT") {
      console.warn(`Ignoring an unreadable ${path} (${String(code)}).`);
    }
    return undefined;
  }
  return decodeConfig(contents);
}

export function writeConfig(path: string, config: DesktopConfig): void {
  writeFileSync(path, encodeConfig(config), "utf8");
}

/**
 * Whether two configs describe the same install — a switch that isn't one.
 * The mode and the address only: the flags record preferences the user has
 * settled, not which install this is.
 */
export function sameConfig(
  a: DesktopConfig | undefined,
  b: DesktopConfig | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  if (a.mode !== b.mode) {
    return false;
  }
  return a.mode !== "thin-client" || a.serverUrl === (b as typeof a).serverUrl;
}
