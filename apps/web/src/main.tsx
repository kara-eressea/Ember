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

import { loadRuntimeConfig } from "./lib/config.js";
import { AppRouter } from "./router.js";
import { useAuthStore } from "./stores/auth.js";
import { applyTheme, savedAccent } from "./theme/theme.js";

applyTheme(savedAccent());
const config = await loadRuntimeConfig();
document.title = config.appName;
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
