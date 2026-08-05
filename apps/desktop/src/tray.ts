import {
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import {
  trayMenuModel,
  type TrayMenuItem,
  type TrayStatus,
} from "./tray-model.js";

/**
 * The real tray (mx3-desktop-shell.md §6) — Electron's side of `tray-model.ts`
 * and nothing more. Every decision worth testing was made there; what is left
 * here is an icon, a menu built from a list, and the platform's own idea of
 * what clicking the icon does.
 *
 * Local mode only. Thin-client mode has no bouncer to keep alive, so it has no
 * tray — the spec's words for a tray that only re-opens a window are "tray
 * theatre", and this package agrees with them.
 */

export interface AppTray {
  /** Re-renders the menu and tooltip; the status is the only thing that moves. */
  setStatus(status: TrayStatus): void;
  destroy(): void;
}

export interface AppTrayOptions {
  /** `assets/trayTemplate.png` or `assets/tray.png` — see paths.ts. */
  readonly iconPath: string;
  /** `app.getName()`: the product name is config, never a literal (CLAUDE.md). */
  readonly productName: string;
  /** Bring the app back — the tray's whole reason to exist. */
  readonly onOpen: () => void;
  /** Quit for real: stop the bouncer, go offline, exit. */
  readonly onQuit: () => void;
  /** Injected for tests and for symmetry with the icon choice; defaults here. */
  readonly platform?: NodeJS.Platform;
}

export function createAppTray(options: AppTrayOptions): AppTray {
  const platform = options.platform ?? process.platform;
  const icon = nativeImage.createFromPath(options.iconPath);
  if (icon.isEmpty()) {
    // Not fatal — an invisible tray is worse than a missing one only if it also
    // stops the app from starting — but it must be loud, because the way this
    // happens is a packaged build (MX4) that forgot to ship `assets/`.
    console.warn(`Tray icon missing or unreadable: ${options.iconPath}.`);
  } else if (platform === "darwin") {
    // A menu-bar icon is a black-and-alpha stencil the OS tints for light,
    // dark and selected states. The file name already says so (`…Template`);
    // this says it again for a nativeImage built from an explicit path.
    icon.setTemplateImage(true);
  }

  const tray = new Tray(icon);
  const handlers: Record<string, () => void> = {
    open: options.onOpen,
    quit: options.onQuit,
  };

  let status: TrayStatus = "connecting";
  const render = () => {
    const model = trayMenuModel({ productName: options.productName, status });
    tray.setToolTip(model.tooltip);
    tray.setContextMenu(
      Menu.buildFromTemplate(
        model.items.map((item) => toTemplate(item, handlers)),
      ),
    );
  };
  render();

  if (platform !== "darwin") {
    // Windows: a left click on a notification-area icon opens the app; the
    // menu is the right-click gesture. On macOS a click opens the menu (the
    // menu bar's own convention, and Electron's default once a context menu is
    // set), so there is nothing to bind there.
    tray.on("click", options.onOpen);
  }

  return {
    setStatus(next) {
      if (next === status) {
        return;
      }
      status = next;
      render();
    },
    destroy() {
      tray.destroy();
    },
  };
}

function toTemplate(
  item: TrayMenuItem,
  handlers: Record<string, () => void>,
): MenuItemConstructorOptions {
  switch (item.kind) {
    case "separator":
      return { type: "separator" };
    case "info":
      // Disabled rather than absent: the name and the status are the two
      // things a tray icon has to be able to answer about itself.
      return { label: item.label, enabled: false };
    case "command":
      return { label: item.label, click: handlers[item.id] };
  }
}
