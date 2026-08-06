/**
 * Web-permission policy for every Electron session this app creates (#560).
 *
 * Electron's documented default, with no handler installed, is to **approve**
 * permission requests from the content it is showing — item 5 of its own
 * security checklist. That default is wrong for this shell in both modes, and
 * indefensible in thin-client mode, where the window shows an origin this
 * process does not control (main.ts: "an untrusted renderer is a real thing to
 * defend against once the main window is somebody else's origin"). A page there
 * calling `getUserMedia()` would be handed the camera and the microphone with
 * no prompt the app controls, on an app the user reasonably reads as "the
 * EmberChat app" rather than "a browser tab".
 *
 * So: deny by default, and name the exceptions. The web client asks for two
 * things and nothing else — desktop notifications (also what a Web Push
 * subscription needs), and writing a copied eicon name to the clipboard.
 * Clipboard *reading* is not on the list, and neither is anything else.
 */

/**
 * The permissions the app grants. Everything absent from this list is refused,
 * including permissions Electron has not shipped yet — which is the point of an
 * allowlist rather than a blocklist.
 *
 * - `notifications` — `lib/desktop-notify.ts`, and the push subscription.
 * - `clipboard-sanitized-write` — `navigator.clipboard.writeText` behind the
 *   eicon menu's "copy name". The sanitized variant is write-only and cannot
 *   read what is already on the clipboard.
 */
export const GRANTED_PERMISSIONS: readonly string[] = [
  "notifications",
  "clipboard-sanitized-write",
];

/** The whole policy, as a pure function: is `permission` on the list? */
export function permissionAllowed(permission: string): boolean {
  return GRANTED_PERMISSIONS.includes(permission);
}

/**
 * The two handlers, structurally — enough of Electron's `Session` to install
 * the policy, and no more, so the policy is testable without a GUI.
 */
export interface PermissionSession {
  setPermissionRequestHandler(
    handler:
      | ((
          webContents: unknown,
          permission: string,
          callback: (granted: boolean) => void,
        ) => void)
      | null,
  ): void;
  setPermissionCheckHandler(
    handler:
      | ((
          webContents: unknown,
          permission: string,
          requestingOrigin: string,
        ) => boolean)
      | null,
  ): void;
}

/**
 * Installs the policy on one session. Both handlers, always: the request
 * handler answers `getUserMedia()`-style prompts, while the check handler
 * answers the synchronous `permissions.query()` a page makes first — leaving
 * that one to Electron's default would tell a page it already had a permission
 * this process was about to refuse.
 */
export function installPermissionHandlers(session: PermissionSession): void {
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permissionAllowed(permission));
  });
  session.setPermissionCheckHandler((_webContents, permission) =>
    permissionAllowed(permission),
  );
}
