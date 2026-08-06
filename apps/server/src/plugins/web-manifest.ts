// The web app manifest (MP3 §1, #377) — what a browser reads to offer "install"
// and how the installed window is named, coloured and shaped.
//
// Served by Fastify rather than shipped as a static file in apps/web/public.
// The original reason was that the product name was runtime config and a baked
// file could only carry the working title; the name is a constant now (#556),
// and the route stays because the document is still assembled from things the
// server owns — the default theme's colours and the shortcut routes, both of
// which have drift guards in web-manifest.test.ts. Registered unconditionally,
// not behind WEB_DIST — in dev and E2E the pages come from Vite, which proxies
// this path through to here (vite.config.ts), so the installed shape is the
// same object in every mode.
//
// No service worker anywhere in this: the client is a live view onto the
// bouncer, and Chromium has not required one for installability for years
// (design/mp3-pwa.md).

import { APP_NAME } from "@emberchat/protocol";
import type { FastifyInstance } from "fastify";

/**
 * The installed window's chrome colour and its pre-paint ground, taken from
 * the DEFAULT theme (Slate Cozy) — `head` is the app's own top bar, `bg` the
 * surface behind it.
 *
 * Duplicated from apps/web/src/theme/tokens.ts because a manifest is served
 * before any of the client's JavaScript exists to be asked, and the server
 * does not depend on the web app. `web-manifest.test.ts` reads that file and
 * fails if the two ever drift — the same guard shape base.test.ts uses for the
 * numbers base.css cannot import. A user who has switched theme gets the
 * corrected colour the moment applyTheme runs (theme/theme.ts); this is the
 * value that stands until then, and the one the OS keeps for the icon.
 */
export const MANIFEST_THEME_COLOR = "#201e1c";
export const MANIFEST_BACKGROUND_COLOR = "#1b1917";

/**
 * Long-press the installed icon and these are the entries under it.
 *
 * The manifest is one document for every install, so a shortcut can only point
 * at a route that means the same thing to every user and on every launch — no
 * character, no conversation, no product name in a label. Two routes clear that
 * bar:
 *
 *  • `/app/@me` — the identity-agnostic alias (lib/routes.ts) that resolves to
 *    whichever character was last active, falling back to the first. On a
 *    phone it opens on the conversation list, which is the "back into it"
 *    destination the shortcut is for.
 *  • `/identities` — the picker, for the launch that is about switching
 *    character rather than resuming one.
 *
 * `short_name` is what a cramped launcher menu actually shows; `name` is the
 * long form for accessibility. Both are generic English, not branding.
 */
const SHORTCUTS = [
  {
    name: "Continue where you left off",
    short_name: "Continue",
    url: "/app/@me",
    icons: [{ src: "/icons/icon-96.png", sizes: "96x96", type: "image/png" }],
  },
  {
    name: "Choose an identity",
    short_name: "Identities",
    url: "/identities",
    icons: [{ src: "/icons/icon-96.png", sizes: "96x96", type: "image/png" }],
  },
];

/** The manifest document. */
export function webManifest() {
  return {
    // `id` pins the app's identity across future start_url changes — without
    // it the browser derives identity from start_url and a later change
    // installs a second app beside the first.
    id: "/",
    name: APP_NAME,
    short_name: APP_NAME,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: MANIFEST_BACKGROUND_COLOR,
    theme_color: MANIFEST_THEME_COLOR,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      // Maskable is a separate entry rather than a second purpose on the
      // 512 above: the two are different drawings (see
      // apps/web/scripts/generate-icons.mjs), and an icon that claims both
      // purposes gets cropped as if it were the padded one.
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: SHORTCUTS,
  };
}

export function webManifestRoute(instance: FastifyInstance): void {
  const document = webManifest();
  instance.get("/manifest.webmanifest", (_request, reply) =>
    reply
      .type("application/manifest+json")
      // Never cached: it is one small document fetched once per install
      // prompt, and an upgrade that changes an icon or a shortcut has no
      // other way to reach a browser that already read it.
      .header("cache-control", "no-cache")
      .send(document),
  );
}
