/**
 * Navigation policy for the app window (mx3-desktop-shell.md §5): the window
 * shows the app origin and nothing else. A profile link, an eicon host, an
 * F-List URL — anything off-origin belongs in the user's own browser, where
 * their extensions, their session and their address bar live.
 *
 * Both mode's windows use this: in local mode the origin is the loopback
 * server, in thin-client mode (#302) it is the remote instance.
 */

/** True when `target` is on the app's own origin (so the window may show it). */
export function isAppOrigin(appOrigin: string, target: string): boolean {
  try {
    return new URL(target).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * True when `target` is something we are willing to hand to the system
 * browser: a real http(s) URL that is not the app itself. Everything else
 * (`file:`, `javascript:`, custom schemes a page might invent) is refused
 * outright rather than passed to the OS handler.
 */
export function isExternalWebUrl(appOrigin: string, target: string): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  return !isAppOrigin(appOrigin, target);
}
