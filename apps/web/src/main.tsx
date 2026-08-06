import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/ibm-plex-mono/700.css";
import "./styles/base.css";

import { startLayoutTracking } from "./lib/layout-mode.js";
import { startKeyboardTracking } from "./lib/visual-viewport.js";
import { AppRouter } from "./router.js";
import { useAuthStore } from "./stores/auth.js";
import {
  applyInterface,
  applyTheme,
  savedAccent,
  savedBaseTheme,
  savedColorblind,
  savedUiFontSize,
  savedUiScale,
} from "./theme/theme.js";

applyTheme(savedAccent(), savedBaseTheme(), savedColorblind());
applyInterface(savedUiFontSize(), savedUiScale());
// After applyInterface, so the first measurement already sees the stored
// interface scale; before render, so nothing paints untiered (#375).
startLayoutTracking();
// Same placement argument as the tier tracker, and the same reason it is not an
// AppShell effect: the login and identity-picker screens are typed into too,
// and the property has to exist before the first paint (#376).
startKeyboardTracking();
// The document title is the product name, and index.html already carries it —
// there is nothing to wait for and nothing to overwrite (#556). The unread
// indicator and the highlight flash rewrite it from APP_NAME thereafter
// (lib/use-unread-indicator.ts).
void useAuthStore.getState().restore();

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root element");
}

createRoot(root).render(
  <StrictMode>
    <AppRouter />
  </StrictMode>,
);
