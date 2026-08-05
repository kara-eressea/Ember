/**
 * Who is allowed to speak on this package's IPC channels
 * (mx3-desktop-shell.md §5).
 *
 * `ipcMain` channels are process-wide: every renderer this app has, and every
 * frame inside it, can call every channel. In local mode that was a short list
 * of pages we wrote or serve ourselves. Thin-client mode changes the shape of
 * the question — the main window now shows **somebody else's origin**, and a
 * page from that origin (or anything it embeds in an iframe) is a renderer that
 * can `invoke` whatever `ipcMain` is listening on. The channels stay small, so
 * the answer is not to hide them but to check who is calling:
 *
 * - the chooser's two channels answer only the shell's own `file://` page;
 * - the error page's two answer only its own `file://` page;
 * - the auth seed answers only the main window's app origin — the origin this
 *   process decided to show, not "an http page" in general.
 *
 * The predicate is pure and lives here so it can be table-tested without
 * Electron; `main.ts` supplies the frame's URL and whether it is the top frame.
 *
 * Both halves of a caller matter. **The URL** is the identity. **The top frame**
 * is the reason an identity means anything: a page can put an iframe on any URL
 * it likes, and a subframe's own URL is not evidence about the document that
 * embedded it — so a subframe is refused even when its URL would have passed.
 */

import { fileURLToPath } from "node:url";

/** The one caller a channel is willing to answer. */
export type IpcCaller =
  /** A page this package ships, identified by its absolute file path. */
  | { readonly kind: "page"; readonly page: string }
  /** The web app, identified by the origin this process chose to load. */
  | { readonly kind: "origin"; readonly origin: string };

/** The parts of `event.senderFrame` this decision needs. */
export interface SenderFrame {
  /** `WebFrameMain.url` — the document's own URL, not its opener's. */
  readonly url: string;
  /** `frame.parent === null`: the window's own document, not an embed. */
  readonly topFrame: boolean;
}

export interface SenderOptions {
  /**
   * Compare file paths case-insensitively. Default: on Windows, where
   * `C:\Users\…` and `c:\users\…` are the same file and Chromium's spelling of
   * a `file://` URL is not guaranteed to match ours character for character.
   */
  readonly caseInsensitivePaths?: boolean;
}

/**
 * Whether `frame` is the caller `expected` describes.
 *
 * Deliberately total and boolean: every refusal is the same refusal, and the
 * handler that asked is the one that decides what a refusal answers with (a
 * `null` seed, an `{ ok: false }` result) and what it logs.
 */
export function senderAllowed(
  frame: SenderFrame | undefined,
  expected: IpcCaller | undefined,
  options: SenderOptions = {},
): boolean {
  // No frame: the sender is already gone (a closed window's in-flight
  // message). No expectation: this channel has no legitimate caller *yet* —
  // the window it belongs to has not been opened — so nobody is one.
  if (frame === undefined || expected === undefined) {
    return false;
  }
  if (!frame.topFrame) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(frame.url);
  } catch {
    // `about:blank`, an empty string, anything unparseable.
    return false;
  }

  if (expected.kind === "origin") {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
    let want: URL;
    try {
      want = new URL(expected.origin);
    } catch {
      return false;
    }
    // `origin` compares scheme, host and port together — which is the whole
    // point: https://chat.example.com and http://chat.example.com are not the
    // same caller, and neither is the same host on another port.
    return url.origin === want.origin;
  }

  if (url.protocol !== "file:") {
    return false;
  }
  let path: string;
  try {
    // The chooser and the error page are loaded with query parameters, and
    // `fileURLToPath` reads the pathname only — which is what should be
    // compared: the page is the same page whatever it was told at load time.
    path = fileURLToPath(url);
  } catch {
    // A `file://host/…` URL, which is not a path on this machine.
    return false;
  }
  return samePath(path, expected.page, options);
}

function samePath(a: string, b: string, options: SenderOptions): boolean {
  const insensitive =
    options.caseInsensitivePaths ?? process.platform === "win32";
  return insensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}
