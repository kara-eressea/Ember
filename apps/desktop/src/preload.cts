/**
 * The renderer-side seam. It is deliberately inert at MX3 #299: the renderer
 * is the unmodified web app (spec invariant 2), and nothing in the scaffold
 * needs to talk to the main process yet.
 *
 * #301 fills this in — it seeds the web app's persisted-auth localStorage key
 * from the main process's own login, so the desktop user never meets the login
 * screen. That is the only renderer-visible code this package will ever own.
 *
 * CommonJS on purpose (`.cts` → `dist/preload.cjs`): sandboxed preloads are
 * not ES modules, and the sandbox stays on.
 */
export {};
