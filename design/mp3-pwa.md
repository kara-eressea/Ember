# MP3 — PWA plumbing (implementation spec)

Companion to [mobile-client.md](mobile-client.md) §MP3 and issue #377. MP1
(v0.21.0) built the phone shell; MP2 (v0.22.0) made it touch-first. MP3 makes
it installable: manifest, icons, safe areas, theme-color, and the lifecycle
work an installed, frozen-prone mobile tab needs. **No offline mode** — the
client is a live view onto the bouncer; scope is install, display and
lifecycle only (mobile-client.md). Deliberately **no service worker**: Chromium
no longer requires one for installability, and a cache layer under a live chat
client is a correctness hazard with no user-visible win. If that changes
(push, MX parity), it changes in its own milestone with its own spec.

## 1. Manifest + icons

- `GET /manifest.webmanifest` served by the server, generated from config —
  the product name is a config token (CLAUDE.md), never a literal. Fields:
  `name`/`short_name` (config appName), `start_url: "/"`, `display:
  "standalone"`, `background_color`/`theme_color` from the default theme's
  tokens, icons.
- Icons: 192 and 512 PNG plus a maskable 512, generated at build time from
  the existing favicon source art (one script, checked-in outputs are fine if
  generation needs tooling CI lacks; document whichever). `apple-touch-icon`
  (180) for iOS, linked in `index.html`.
- **App shortcuts** (added during package A): a `shortcuts` array, so a
  long-press on the installed icon jumps into the app. The manifest is baked
  per instance, not per character, so a shortcut may only name a route that
  means the same thing to every user on every launch, and a label may not
  carry the product name — "Continue" → `/app/@me` (the identity-agnostic
  alias in `lib/routes.ts`, landing on the conversation list) and
  "Identities" → `/identities`. No new routes were invented for this; the
  96px shortcut icon comes out of the same generation script. Manifest-only —
  no service worker involved.
- CSP: same-origin manifest and icons — no policy change. Verify the hash-pin
  guard (#466) is untouched by any `index.html` edit.
- **Asset cache headers** (the no-service-worker mitigation): Vite's output is
  content-hashed, so the server should serve `/assets/*` with
  `Cache-Control: public, max-age=31536000, immutable` and `index.html` with
  `no-cache`. That buys SW-like warm cold-starts from plain HTTP cache with
  none of the SW staleness hazards. Audit what the static handler sends today
  and fix if short; add a server test pinning both headers.

## 2. iOS install metadata

`apple-mobile-web-app-capable` is legacy; use `display: standalone` +
`apple-touch-icon` + `viewport-fit=cover`. Verify what current iOS Safari
actually honours rather than cargo-culting meta tags — document findings.

## 3. Safe areas

- `viewport-fit=cover` in the viewport meta (required before `env()` returns
  non-zero on notched devices).
- `env(safe-area-inset-*)` padding on the shell's outer edges — keyed on
  **display-mode standalone** (`@media (display-mode: standalone)` is a
  genuine device/context query, allowed under §2 of MP1's spec) so the
  browser-tab experience is unchanged. The bottom inset interacts with the
  keyboard inset (`--eb-keyboard-inset`): when the keyboard is up its inset
  already covers the home-indicator strip — don't double-pad. The composer,
  the sheet (`MenuSurface`), and `PanelOverlay` are the three bottom-anchored
  surfaces to check.
- Landscape notch: left/right insets on the shell.

## 4. theme-color from the active theme

A `meta[name=theme-color]` kept in sync with the active theme's head/side
token by the theme module (`applyTheme`), so the installed title bar and the
Android status bar match the app. Light/dark/accent switches update it live.

## 5. Lifecycle: frozen tabs and installed-app resume

The wake probing from #432/#465 (focus/online/pageshow/resume/visibility)
already covers most of this. MP3 tightens for the installed case:

- Audit `gateway/socket.ts`'s wake paths against mobile freezing: `freeze`/
  `resume` (Page Lifecycle API), bfcache `pageshow` with `persisted: true`,
  and long-frozen timers (a frozen tab's `setTimeout` backlog fires all at
  once on resume — the reconnect backoff must not interpret that burst as
  rapid failures).
- An installed app has no reload affordance; the "not connected, click to
  reconnect" chip (#465) is the only recovery. Verify it is reachable on the
  phone tier in both panes.
- `navigator.wakeLock` is out of scope (no reading-mode use case yet).

## 6. Packages

- **A — install surface.** §1–§4: manifest route + config plumbing, icons,
  index.html metas, safe-area CSS, theme-color sync. Server-touching (the
  manifest route), so it also gets a server test asserting the manifest
  reflects config.
- **B — lifecycle + E2E + docs.** §5 audit/fixes; mobile E2E where testable
  (display-mode and freeze are partly emulatable via CDP — measure what is);
  self-host docs gain the install-to-home-screen section (MP4's docs slice,
  pulled forward since it documents A); tracker updates; real-device
  checklist additions (actual install on Android + iOS, notch behaviour,
  frozen-resume).

A then B, sequential (B documents and tests A's surface).

## 7. Invariants

- Browser-tab experience: zero change outside `display-mode: standalone`
  except the (invisible) metas and manifest link.
- No service worker, no caching, no offline claims anywhere user-visible.
- Product name and domains stay config tokens — grep the diff for the literal
  before merging.
- The CSP hash-pin guard stays green; no new external requests.

## 8. What only real hardware can answer (package A)

Package A is the half of MP3 that is *least* testable from a desktop: an
installed window is a thing an operating system makes, and no automation here
can make one. Two measured facts bound what is already known — Chromium parses
the manifest with zero errors and reports the page installable (checked over
CDP against the built bundle behind the real static handler), and
`display-mode` is **not** emulatable: `Emulation.setEmulatedMedia` accepts a
`display-mode` feature and Blink ignores it, so every `@media (display-mode:
standalone)` rule is unreachable from Playwright on any platform. The safe-area
arithmetic underneath it was verified instead by driving the four tokens
directly (browser tab → 0; insets alone → padded; keyboard taller than the
inset → 0; keyboard shorter → the remainder). What is left needs a phone.

**Android (Chrome):**

- [ ] **Install prompt appears** and the installed icon is the flame, not a
      screenshot of the page. A cropped or letterboxed icon means the maskable
      512 is wrong, not the 192.
- [ ] **The status bar matches the app's top bar**, and re-matches after
      switching base theme in Preferences (`theme-color` sync, §4).
- [ ] **The shortcut menu.** Long-press the installed icon: "Continue" and
      "Identities" appear, and each opens on the right screen. Manifest
      parsing of `shortcuts` is emulator-verifiable; the menu itself is not.

**iOS (Safari) — the engine none of this is reachable from:**

- [ ] **Add to Home Screen gives a standalone window** (no address bar) with
      the `apple-touch-icon`, from the manifest's `display` alone — the
      deprecated `apple-mobile-web-app-capable` is deliberately absent (§2)
      and this is the check that the omission was right.
- [ ] **Nothing sits under the notch or the home indicator** in the installed
      window, in both orientations, on the shell, the login screen, the
      identity picker, a long-press sheet and the member-list overlay.
- [ ] **The composer clears the keyboard without an extra gap** above it —
      the double-pad case §3's `max()` is there to prevent.
- [ ] **A browser tab is unchanged** by all of the above: same layout, no
      padding, `viewport-fit=cover` notwithstanding.
