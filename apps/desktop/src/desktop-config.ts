/**
 * `<userData>/config.json` — which of the two modes this install runs in
 * (mx3-desktop-shell.md §4), and nothing else.
 *
 *   { "version": 1, "mode": "local" }
 *   { "version": 1, "mode": "thin-client", "serverUrl": "https://…" }
 *
 * …plus one optional flag, `"trayNoticeSeen": true`, once close-to-tray has
 * explained itself for the first and only time (§6). Additive and absent until
 * it happens, so the version stays 1: a build that does not know the key
 * ignores it, and a build that does treats a file without it as "not said
 * yet". The worst case in either direction is one extra sentence.
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

export type DesktopMode = "local" | "thin-client";

export type DesktopConfig =
  /** This machine runs the bouncer (§2, §3). */
  | { readonly mode: "local"; readonly trayNoticeSeen?: true }
  /** The window is a view onto somebody's own server (§5). */
  | {
      readonly mode: "thin-client";
      readonly serverUrl: string;
      readonly trayNoticeSeen?: true;
    };

/** `<userData>/config.json`. */
export function configPath(userDataDir: string): string {
  return join(userDataDir, "config.json");
}

export function encodeConfig(config: DesktopConfig): string {
  const file = {
    version: CONFIG_SCHEMA_VERSION,
    mode: config.mode,
    ...(config.mode === "thin-client" ? { serverUrl: config.serverUrl } : {}),
    // Written only once it is true, so a file that never had the notice looks
    // exactly as it did before this field existed.
    ...(config.trayNoticeSeen === true ? { trayNoticeSeen: true } : {}),
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
  };
  if (file.version !== CONFIG_SCHEMA_VERSION) {
    return undefined;
  }
  // Anything but a literal `true` — absent, `"yes"`, hand-edited to nonsense —
  // means the notice has not been shown, which costs the user one extra
  // sentence at worst. That is why it did not need a schema version of its
  // own: a build that predates the field ignores it, and a build that has it
  // treats a file without it as a first close (see `withTrayNoticeSeen`).
  const seen: { readonly trayNoticeSeen?: true } =
    file.trayNoticeSeen === true ? { trayNoticeSeen: true } : {};
  if (file.mode === "local") {
    return { mode: "local", ...seen };
  }
  if (file.mode === "thin-client") {
    if (typeof file.serverUrl !== "string") {
      return undefined;
    }
    // Re-validated on every read, not just on the way in: this string becomes
    // a `loadURL`, and the file is one a person can open in an editor.
    const normalized = normalizeServerUrl(file.serverUrl);
    return normalized.ok
      ? { mode: "thin-client", serverUrl: normalized.url, ...seen }
      : undefined;
  }
  return undefined;
}

/**
 * The same config with the one-time tray notice marked as said, or not.
 *
 * A function rather than a spread at the call sites because there are two of
 * them and they pull in opposite directions: the close handler sets the flag
 * on whatever is stored, and the chooser writes a *new* config that must carry
 * the old flag across — switching to thin-client mode and back is not a reason
 * to explain the tray a second time.
 */
export function withTrayNoticeSeen(
  config: DesktopConfig,
  seen: boolean,
): DesktopConfig {
  if (!seen) {
    return config.mode === "local"
      ? { mode: "local" }
      : { mode: "thin-client", serverUrl: config.serverUrl };
  }
  return config.mode === "local"
    ? { mode: "local", trayNoticeSeen: true }
    : {
        mode: "thin-client",
        serverUrl: config.serverUrl,
        trayNoticeSeen: true,
      };
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
 * The mode and the address only: `trayNoticeSeen` is a note about something
 * the user has already been told, not part of which install this is.
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
