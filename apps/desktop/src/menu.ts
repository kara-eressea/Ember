import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { UPDATE_CHECK_MENU_LABEL } from "./update-check.js";

/**
 * The application menu — which exists for the shell's own items
 * (mx3-desktop-shell.md §4). Everything else in it is Electron's own roles:
 * without a custom menu the app gets the default one, and Copy/Paste/Quit
 * disappearing from a window is not a trade worth making for two entries.
 *
 * Placement follows each platform's convention for "settings-shaped, applies
 * to the whole app": the application menu on macOS, File elsewhere.
 *
 * Rebuilt rather than mutated whenever the answer changes — `main.ts` calls
 * this once per `startup()`, so a first run that ends in local mode gets the
 * local-mode menu without a second code path.
 */

/** The daily release check's checkbox (#549) — local mode only. */
export interface UpdateCheckMenuItem {
  readonly enabled: boolean;
  /** Called with the item's new state; persistence is `main.ts`'s job. */
  readonly onToggle: (enabled: boolean) => void;
}

export interface AppMenuOptions {
  readonly onSwitchMode: () => void;
  /**
   * Absent in thin-client mode and while the chooser is up: there is no local
   * server whose environment this process composes, so the checkbox would have
   * nothing to change (see `update-check.ts`).
   */
  readonly updateCheck?: UpdateCheckMenuItem;
}

export function installAppMenu(options: AppMenuOptions): void {
  const switchMode: MenuItemConstructorOptions = {
    label: "Switch mode…",
    click: () => {
      options.onSwitchMode();
    },
  };
  const updateCheck = options.updateCheck;
  // Spread into the templates below, so "no local server" means "no item"
  // rather than a disabled one nobody can explain.
  const shellItems: MenuItemConstructorOptions[] =
    updateCheck === undefined
      ? [switchMode]
      : [
          switchMode,
          {
            label: UPDATE_CHECK_MENU_LABEL,
            type: "checkbox",
            checked: updateCheck.enabled,
            // Electron has already flipped `item.checked` by the time this
            // runs; that value is the user's request, not the stored state.
            click: (item) => {
              updateCheck.onToggle(item.checked);
            },
          },
        ];

  const template: MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              ...shellItems,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
        ]
      : [
          {
            label: "&File",
            submenu: [...shellItems, { type: "separator" }, { role: "quit" }],
          },
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
        ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
