/**
 * The contract between the remote-session error page and the main process
 * (mx3-desktop-shell.md §5) — two calls, exactly like the chooser's, and for
 * the same reason: a page whose entire vocabulary is "which of my two buttons
 * was pressed" has no surface worth attacking.
 *
 * `error-preload.cts` repeats these two strings, because a sandboxed CommonJS
 * preload cannot import this ES module; `thin-client.test.ts` is the seam that
 * keeps the spellings equal.
 */

import type { RemoteFailure } from "./error-page.js";

export const REMOTE_RETRY_CHANNEL = "emberchat:remote-retry";
export const REMOTE_SWITCH_MODE_CHANNEL = "emberchat:remote-switch-mode";

/**
 * What either call answers with.
 *
 * `ok` means the main process has taken over — the app window is up, or the
 * chooser is — and this window is on its way out. A refusal carries the *new*
 * failure rather than a bare string: a second attempt can fail differently
 * (down, then a certificate that expired while it was down), and a page that
 * kept its first headline while showing the second reason would be lying in
 * the most quietly confusing way available.
 */
export type RemoteActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: RemoteFailure };
