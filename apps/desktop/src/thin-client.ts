/**
 * What a thin-client launch does, decided before a window exists
 * (mx3-desktop-shell.md §5).
 *
 * The naive shape #300 left behind was one line — `loadURL(serverUrl)` — and
 * it is wrong in exactly one way: it hands an unreachable address to Chromium
 * and lets the user watch a blank frame until the network stack gives up, then
 * shows them somebody else's error page. The probe already exists (it is what
 * the chooser validates a typed address with, `server-url.ts`), it answers in
 * a second or two, and it distinguishes "your server is down" from "that is
 * not an EmberChat server" — so every launch asks it first.
 *
 * That makes the launch a decision with two answers, which is what this module
 * is: pure, injected with the probe, testable without Electron. `main.ts`
 * carries the answer out — a window, or the shell's own error page — and calls
 * this again, unchanged, when the error page's Retry is pressed.
 *
 * What the probe costs: one `GET /healthz` before the window opens, on a
 * connection Chromium is about to make anyway. What it buys: the error page
 * appears in about a second instead of after a TCP timeout, and it can say
 * *which* thing went wrong. The stored URL was already re-validated on read
 * (#300 as-built 1); this is the other half — the address is well-formed *and*
 * something is there.
 */

import { describeProbeRefusal, type RemoteFailure } from "./error-page.js";
import type { ServerUrlResult } from "./server-url.js";

export type ThinClientLaunch =
  /** The server answered the `/healthz` contract: show it. */
  | { readonly kind: "window"; readonly serverUrl: string }
  /** It did not: the shell's own page says why, and offers Retry. */
  | { readonly kind: "error"; readonly failure: RemoteFailure };

/** Injected so the launch flow can be tested as plain Node. */
export type ProbeFn = (serverUrl: string) => Promise<ServerUrlResult>;

export async function planThinClientLaunch(
  serverUrl: string,
  probe: ProbeFn,
): Promise<ThinClientLaunch> {
  const reachable = await probe(serverUrl);
  return reachable.ok
    ? { kind: "window", serverUrl }
    : { kind: "error", failure: describeProbeRefusal(reachable) };
}
