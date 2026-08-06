import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GRANTED_PERMISSIONS,
  installPermissionHandlers,
  permissionAllowed,
  type PermissionSession,
} from "./permissions.js";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

/** Records the two handlers the way a real `Session` would hold them. */
function fakeSession() {
  const holder: {
    request?: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void;
    check?: (
      webContents: unknown,
      permission: string,
      requestingOrigin: string,
    ) => boolean;
  } = {};
  const session: PermissionSession = {
    setPermissionRequestHandler(handler) {
      holder.request = handler ?? undefined;
    },
    setPermissionCheckHandler(handler) {
      holder.check = handler ?? undefined;
    },
  };
  return { session, holder };
}

/** What the request handler answered for `permission`. */
function ask(
  holder: ReturnType<typeof fakeSession>["holder"],
  permission: string,
): boolean | undefined {
  let answer: boolean | undefined;
  holder.request?.(null, permission, (granted) => {
    answer = granted;
  });
  return answer;
}

describe("the web-permission policy", () => {
  it("grants only what the web client actually asks for", () => {
    // Desktop notifications (and the push subscription that needs them), plus
    // the clipboard WRITE behind the eicon menu's "copy name". Nothing else.
    expect([...GRANTED_PERMISSIONS].sort()).toEqual([
      "clipboard-sanitized-write",
      "notifications",
    ]);
    expect(permissionAllowed("notifications")).toBe(true);
    expect(permissionAllowed("clipboard-sanitized-write")).toBe(true);
  });

  it("refuses the devices a chat client has no business reaching", () => {
    // The thin-client threat model in one test: the window may be showing a
    // server this process does not control, and Electron's default with no
    // handler installed is to say yes.
    for (const permission of [
      "media",
      "geolocation",
      "display-capture",
      "clipboard-read",
      "midi",
      "midiSysex",
      "idle-detection",
      "pointerLock",
      "openExternal",
      "window-management",
      "fileSystem",
      "unknown",
    ]) {
      expect(permissionAllowed(permission)).toBe(false);
    }
  });

  it("refuses a permission nobody has thought of yet", () => {
    // An allowlist, not a blocklist: whatever Chromium ships next is refused
    // until somebody adds it here on purpose.
    expect(permissionAllowed("some-future-capability")).toBe(false);
    expect(permissionAllowed("")).toBe(false);
  });
});

describe("installPermissionHandlers", () => {
  it("installs both handlers on the session it is given", () => {
    const { session, holder } = fakeSession();
    installPermissionHandlers(session);
    expect(holder.request).toBeTypeOf("function");
    // The check handler matters as much as the request one: a page asks
    // `permissions.query()` first, and Electron's default answer there would
    // promise a permission this process is about to refuse.
    expect(holder.check).toBeTypeOf("function");
  });

  it("answers the request handler's callback with the policy", () => {
    const { session, holder } = fakeSession();
    installPermissionHandlers(session);
    expect(ask(holder, "notifications")).toBe(true);
    expect(ask(holder, "media")).toBe(false);
    expect(ask(holder, "geolocation")).toBe(false);
  });

  it("answers the check handler with the same policy", () => {
    const { session, holder } = fakeSession();
    installPermissionHandlers(session);
    const origin = "https://chat.example.com";
    expect(holder.check?.(null, "notifications", origin)).toBe(true);
    expect(holder.check?.(null, "media", origin)).toBe(false);
    // The origin is not consulted: thin-client mode means the origin is
    // whatever the user pointed the app at, so trusting it would be circular.
    expect(holder.check?.(null, "media", "http://localhost:3000")).toBe(false);
  });
});

describe("main wires the policy up", () => {
  const source = read("main.ts");

  it("installs on the default session as soon as the app is ready", () => {
    expect(source).toContain(
      "installPermissionHandlers(session.defaultSession)",
    );
  });

  it("installs on every session created afterwards", () => {
    // A partition is one BrowserWindow option away, and a session created
    // later would otherwise start from Electron's grant-by-default.
    expect(source).toContain('app.on("session-created"');
  });
});
