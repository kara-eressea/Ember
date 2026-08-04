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

## 6.1 As built

**A — install surface (#498).** The manifest is a Fastify route
(`plugins/web-manifest.ts`) rather than a static file, so `APP_NAME` reaches
the home-screen icon; it carries `id`, `scope`, the three icons and the two
shortcuts. Icons are generated by `apps/web/scripts/generate-icons.mjs` (reads
`public/favicon.svg`, rasterises through Playwright's Chromium) and **committed**
— making `vite build` depend on a browser install that only the e2e CI leg has,
to re-derive five files from art that never changes, was the worse trade. The
maskable 512 is a separate drawing, not a second `purpose`. iOS got
`viewport-fit=cover` and the 180 `apple-touch-icon`; `apple-mobile-web-app-capable`
was deliberately left out (deprecated since 15.4, and as a manifest *fallback*
it ignores `start_url`/`scope`, so shipping it can make the installed app
worse) with a test that it does not drift back. Safe areas are four `0px`
tokens in `base.css`, set from `env()` only inside `@media (display-mode:
standalone)`, plus `--eb-safe-bottom-kb` = `max(0px, bottom − keyboard-inset)`
for the one box in the flow. `applyTheme` keeps `meta[name=theme-color]` on the
active theme's `head` token. The §1 cache-header audit found nothing to fix and
one thing to pin: the exact `max-age=31536000, immutable` / `no-cache` pair now
has a test.

**B — lifecycle, E2E, docs (this round).** §5's audit found three real gaps and
one non-gap; all three are fixed in `gateway/socket.ts` and unit-tested on fake
timers:

- **`freeze` was unhandled.** A pong deadline armed before a freeze fires the
  instant the tab thaws and closes the socket without ever re-asking — a full
  re-hello, snapshot and catchup per subscribed identity, sometimes against a
  socket that was fine. The same freeze also strands the probe debounce, which
  then fires on thaw *alongside* the debounce the thaw's own wake events arm:
  two probes a quarter-second apart, the second silently extending the first's
  deadline. A `freeze` listener now disarms both; the probe re-asks with its
  own 3s deadline, which is the same verdict 250ms later.
- **A thaw did not reset the backoff ladder.** The queued reconnect fires the
  moment the tab thaws, into a radio that is not up yet, fails, and re-arms at
  whatever the ladder had climbed to — up to 30s of an installed app showing a
  stale conversation with no address bar to reload from. The probe now treats a
  thaw the way `reconnectNow` treats a tap: ladder back to the floor, and
  re-arm a pending timer there. The one-attempt-per-second `#lastOpenAt` floor
  is untouched, so a thaw still cannot hammer the bouncer, and an ordinary
  focus wake still leaves the ladder alone (a genuine refusal must keep
  climbing).
- **bfcache `pageshow` took the staleness shortcut.** `persisted: true` means
  the document was parked whole and the browser severed its socket without
  saying so, but `#lastFrameAt` was written before it went in — a quick
  out-and-back read as "demonstrably alive". `persisted` now forces the ping.
- **The timer burst cannot escalate the backoff.** Walked and found sound
  before the fixes above: `#backoffMs` doubles only in `#scheduleReconnect`,
  which is only reached from `onclose`, so N queued timers landing in one tick
  are still one close per socket. The keepalive is a `setInterval`, which has
  at most one task pending at a time, so it fires once on thaw rather than N
  times. A regression test pins both halves.

§5's recovery affordance was a real gap and is fixed in the toolbar: the
sidebar chip (#465) is unreachable on `data-pane="conversation"` because that
pane hides the sidebar outright, so `ChannelHeader`/`DmHeader` carry their own
copy on exactly the condition the back chip rides (`backTo`, i.e. stacked
only). It is the sidebar chip's shape rather than the row's IconBtn — the same
control saying the same thing — and it wears a 44px overlay in height with 4px
of extra gap, since the back chip's own overlay reaches 7px past its box.
Deliberately not in `header-toolbar.ts`'s width model: budgeting ~66px for a
state that is normally absent would collapse a control out of every healthy
row.

§5's pull-to-refresh question: the page itself *could* be pulled. MP2 contained
every scroll region, but a drag starting on something that does not scroll —
the toolbar, the composer's chrome — is still an overscroll of the document and
Chrome on Android still answers it with a reload. `body { overscroll-behavior-y:
contain }` inside `@media (display-mode: standalone)` closes it: `contain`
rather than `none` so the edge still glows, and standalone-only so a browser tab
keeps pull-to-refresh, which there is the user's reload (§7).

E2E: `display-mode` remains unemulatable (§8), and `freeze`/`resume` are
dispatched by the browser's own tab-lifecycle machinery — neither a page nor
CDP can ask for them — so the lifecycle fixes are unit tests. What *is* an E2E
is the affordance: `e2e/mobile-lifecycle.spec.ts` (mobile-chromium) severs the
gateway under an open conversation, asserts the toolbar chip appears while the
sidebar stays hidden, hit-tests it against the 44px floor, checks the list pane
still carries its own, and recovers by tapping it. bfcache was probed and
dropped: keeping a Playwright navigation in the cache is not reliable enough to
assert on, and `pageshow.persisted` is unit-tested instead.

## 7. Invariants

- Browser-tab experience: zero change outside `display-mode: standalone`
  except the (invisible) metas and manifest link.
- No service worker, no caching, no offline claims anywhere user-visible.
- Product name and domains stay config tokens — grep the diff for the literal
  before merging.
- The CSP hash-pin guard stays green; no new external requests.

## 8. What only real hardware can answer

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

**Lifecycle (package B) — Android/Chrome, where freezing actually happens:**

Chrome freezes a backgrounded tab after roughly five minutes and may discard it
entirely under memory pressure. Neither event is reachable from a test; both are
routine on a phone. `chrome://discards` on the device can force a freeze
directly, which is the cheapest way to run the first two.

- [ ] **A frozen tab comes back live.** Open a conversation, background the app
      for ten minutes or freeze it from `chrome://discards`, then return: new
      messages arrive within a second or two and nothing needs a tap. Watch that
      it does *not* flash through a visible reconnect when the socket survived
      — that is the pong deadline being handed in on freeze (§6.1) doing its
      job.
- [ ] **A thaw onto a dead radio recovers quickly.** Same, but turn the radio
      off before backgrounding and on again after returning: the reconnect
      should land within a couple of seconds, not after the 30s ceiling. This is
      the ladder reset, and it is the one fix whose failure mode is "it works,
      just slowly", so it needs a clock rather than an impression.
- [ ] **A discarded tab reloads cleanly.** Under memory pressure Chrome throws
      the document away and reloads on return; the app should come back to the
      same conversation from the URL, not to the identity picker.
- [ ] **Pull-to-refresh is gone in the installed window** — drag down on the
      toolbar and on the composer's chrome, in a conversation: nothing reloads.
      Then confirm the *browser tab* still refreshes on the same gesture.
- [ ] **The connection chip is reachable and tappable from a conversation**
      with a real thumb (flight mode is the easiest way to produce one), and
      pressing it does not catch the back chip beside it.

**Lifecycle — iOS/Safari:**

- [ ] **Returning from the app switcher resyncs.** iOS fires no `freeze`/
      `resume` at all, so the recovery there rests entirely on
      `visibilitychange` and the probe's staleness test — the paths #432 built.
      Leave the app for half an hour, come back, and check the log catches up.
