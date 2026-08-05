/**
 * What a launch does, decided before anything expensive happens
 * (mx3-desktop-shell.md §4).
 *
 * One pure function over the stored config, so the branch that decides whether
 * this process becomes a bouncer, a window onto someone else's, or a question
 * to the user, is readable and testable on its own — `main.ts` only carries
 * the three answers out.
 */

import type { DesktopConfig } from "./desktop-config.js";

export type StartupPlan =
  /** No usable config: ask (§4). Nothing has touched the data dir yet. */
  | { readonly kind: "choose" }
  /** Provision if needed, boot the embedded bouncer, log in (§2, §3). */
  | { readonly kind: "local" }
  /** No server, no provisioning: the window loads the remote instance (§5). */
  | { readonly kind: "thin-client"; readonly serverUrl: string };

export function planStartup(config: DesktopConfig | undefined): StartupPlan {
  if (config === undefined) {
    return { kind: "choose" };
  }
  return config.mode === "local"
    ? { kind: "local" }
    : { kind: "thin-client", serverUrl: config.serverUrl };
}
