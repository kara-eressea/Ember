import { BrowserWindow, shell } from "electron";
import { fileURLToPath } from "node:url";
import { isAppOrigin, isExternalWebUrl } from "./navigation.js";

const PRELOAD = fileURLToPath(new URL("preload.cjs", import.meta.url));

/**
 * The app window. Its content is the web app served by the embedded server —
 * there is no renderer bundle in this package (spec invariant 2), so the only
 * things decided here are the security defaults, the navigation policy, and
 * when to show the frame.
 */
export function createMainWindow(appOrigin: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 480,
    // No flash of empty chrome while the SPA boots.
    show: false,
    backgroundColor: "#000000",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  // A profile link, an image host, anything the chat renders: the user's own
  // browser, never a chrome-less Electron window (spec §5).
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebUrl(appOrigin, url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isAppOrigin(appOrigin, url)) {
      return;
    }
    event.preventDefault();
    if (isExternalWebUrl(appOrigin, url)) {
      void shell.openExternal(url);
    }
  });

  void window.loadURL(appOrigin);
  return window;
}
