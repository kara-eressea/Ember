import { app, Menu, type MenuItemConstructorOptions } from "electron";

/**
 * The application menu — which exists for exactly one item, "Switch mode…"
 * (mx3-desktop-shell.md §4). Everything else in it is Electron's own roles:
 * without a custom menu the app gets the default one, and Copy/Paste/Quit
 * disappearing from a window is not a trade worth making for one entry.
 *
 * Placement follows each platform's convention for "settings-shaped, applies
 * to the whole app": the application menu on macOS, File elsewhere.
 */
export function installAppMenu(onSwitchMode: () => void): void {
  const switchMode: MenuItemConstructorOptions = {
    label: "Switch mode…",
    click: () => {
      onSwitchMode();
    },
  };

  const template: MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              switchMode,
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
            submenu: [switchMode, { type: "separator" }, { role: "quit" }],
          },
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
        ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
