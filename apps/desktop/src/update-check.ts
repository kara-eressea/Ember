/**
 * The desktop app's answer to "stop asking GitHub about me" (#549).
 *
 * The server this shell starts runs M7's daily release check — one call a day
 * to the GitHub Releases API, which is what puts the quiet "update available"
 * hint on the version number in the web app. A self-hoster switches it off with
 * `UPDATE_CHECK_ENABLED=false` in their env file. A desktop user has no env
 * file, and until now had no way to say no at all.
 *
 * So the shell owns the preference: a flag in `config.json`, a checkbox in the
 * menu, and `UPDATE_CHECK_ENABLED` in the environment the server child is
 * handed (`server-env.ts`). No new server behaviour — this is the existing
 * switch, finally reachable.
 *
 * **It takes effect the next time the app starts, and that is deliberate.** The
 * server reads its configuration once, at boot, from an environment this
 * process composes before forking it; there is no live-reconfiguration channel
 * into the child and building one for a once-a-day version fetch would be a new
 * authenticated mutable-config surface on the server for a knob nobody touches
 * twice. The honest cost is bounded and stated in the confirmation below: at
 * most one more check, and never after the next restart.
 *
 * Local mode only. In thin-client mode the check belongs to the server the
 * window is pointed at, and its operator sets it in their own env file — a
 * checkbox here would either lie or reach into somebody else's instance.
 *
 * Electron-free on purpose, like the rest of this package's decisions: `menu.ts`
 * builds the real item from these, and `main.ts` carries the click out.
 */

import type { DesktopConfig } from "./desktop-config.js";

/**
 * The menu item's label. Plain language (#543): no "release check", no "phone
 * home", and no product name — it sits in a menu that already says which app it
 * belongs to.
 */
export const UPDATE_CHECK_MENU_LABEL = "Check for updates automatically";

/**
 * Whether the daily check runs. On unless the flag says otherwise — including
 * for a config this build could not read at all, which is the same default the
 * server ships with and the same one every install had before #549.
 */
export function updateCheckEnabled(config: DesktopConfig | undefined): boolean {
  return config?.updateCheckDisabled !== true;
}

/**
 * What the app says after the checkbox is clicked.
 *
 * Something has to be said, because nothing visible changes: the version number
 * in the sidebar looks identical either way until a release appears. And it has
 * to name the delay, because a user who turns this off and watches a check
 * happen an hour later would be right to conclude the setting is decorative.
 */
export function updateCheckNotice(
  productName: string,
  enabled: boolean,
): { readonly title: string; readonly body: string } {
  return enabled
    ? {
        title: "Update checks are on",
        body: `${productName} will look for a newer version once a day, and show the version number as a link when there is one. This starts the next time you open ${productName}.`,
      }
    : {
        title: "Update checks are off",
        body: `${productName} will stop asking whether a newer version exists. This takes effect the next time you open ${productName}, so there may be one more check before then. You can still download new versions from the project's releases page whenever you like.`,
      };
}
