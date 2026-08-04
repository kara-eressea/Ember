# Mobile real-device checklist

Everything the MP track built was verified against browser emulation, which is
a real engine with a phone's viewport, touch pointer and `hover: none` — and is
not a phone. This file is the remainder: the checks no automation on any
machine can perform, gathered from
[mp2-touch.md](mp2-touch.md) and [mp3-pwa.md](mp3-pwa.md) into one list that
can be run in one sitting.

It is ordered as that sitting rather than by milestone: **an Android pass, then
an iOS pass**, each starting with the install so everything after it happens in
the window the checks are about. Two devices, perhaps forty minutes.

Each item says what to look for and — where the failure has a known first
suspect — where to start if it is wrong. Nothing here blocks a release; this is
the confidence pass on work that shipped on measurement and inference.

## What is already known, and what is left

Four facts bound the list, all of them measured rather than assumed:

- **Chromium parses the manifest with zero errors** and reports the page
  installable (checked over CDP against the built bundle behind the real static
  handler). What a phone adds is what the *operating system* then does with it.
- **`display-mode` is not emulatable.** `Emulation.setEmulatedMedia` accepts a
  `display-mode` feature and Blink ignores it, so every
  `@media (display-mode: standalone)` rule is unreachable from Playwright on
  every platform. The safe-area arithmetic under it was verified instead by
  driving the four tokens directly, and the gating itself is a source
  assertion (`styles/base.test.ts`) — but no test has ever seen the rules fire.
- **`freeze`/`resume` are dispatched by the browser's own tab-lifecycle
  machinery**, which neither a page nor CDP can ask to run, and a bfcache
  restore needs a cross-document navigation Playwright will not reliably keep
  in the cache. Both are unit-tested on fake timers instead.
- **WebKit runs the phone suite** since MP4 (the `mobile-webkit` Playwright
  project, an iPhone-class descriptor on a real WebKit): the pane stack, the
  toolbar collapse, the hover fallbacks, the preferences stopgap, the
  reconnect affordance, the 44px sweep and — the valuable one — the keyboard
  inset all hold on the second engine. What that build still cannot do is a
  *hold* (no cross-engine touch primitive holds a finger down) or a *fling* (no
  cross-engine way to hand a compositor a velocity), and it is a desktop
  WebKit, so it has neither iOS's callout, its compatibility-click timing, nor
  its deceleration curve. The iOS items below are exactly that remainder.

---

## Android pass (Chrome)

### Install

- [ ] **The install prompt appears**, and the installed icon is the flame —
      not a screenshot of the page. A cropped or letterboxed icon means the
      maskable 512 is wrong, not the 192.
- [ ] **The shortcut menu.** Long-press the installed icon: "Continue" and
      "Identities" appear, and each opens on the right screen. Manifest parsing
      of `shortcuts` is emulator-verifiable; the menu itself is not.
- [ ] **The status bar matches the app's top bar**, and re-matches after
      switching base theme in Preferences (the `theme-color` sync,
      mp3-pwa.md §4).

### Touch

- [ ] **One hold, one menu.** Hold an eicon in a message, a sidebar row and a
      member row. Exactly one action sheet each time. Android synthesizes its
      own `contextmenu` from a hold at roughly our threshold, and the
      deduplication for it is unit-tested only — emulation never fires that
      event, so no E2E on any machine can reach it. A *second* menu, or a menu
      that opens and instantly replaces itself, is the failure.
- [ ] **A hold on a message's text still selects the text**, with the usual
      selection handles. Only discrete elements are claimed (`data-eb-press`);
      prose must be untouched.
- [ ] **A sheet raised from a DM row arrives with "Invite to" collapsed**, and
      one tap opens it and another closes it. This was the MP2 audit finding
      the compatibility `mouseenter` used to expand under the finger with no
      gesture left to close it (`lib/useSubmenuTrigger.ts`); the same goes for
      "Show" on a channel row's sheet.

### Keyboard

- [ ] **The composer sits above the keyboard** with a conversation open, and
      the log stays at the tail when the keyboard opens on a log that was at
      the tail. Chrome Android and iOS take the same default path here, so if
      it is wrong on one it is likely wrong on both.
- [ ] **A sheet raised while the keyboard is up is fully on screen.** The sheet
      is pinned to the layout viewport and does not read
      `--eb-keyboard-inset`; what makes it visible is that opening it is modal
      and blurs the composer, which retracts the keyboard. A shimmed keyboard
      cannot retract, so this inference is only checkable here.

### Lifecycle

Chrome freezes a backgrounded tab after roughly five minutes and may discard it
entirely under memory pressure. Neither event is reachable from a test; both are
routine on a phone. `chrome://discards` on the device forces a freeze directly,
which is the cheapest way to run the first two.

- [ ] **A frozen tab comes back live.** Open a conversation, background the app
      for ten minutes or freeze it from `chrome://discards`, then return: new
      messages arrive within a second or two and nothing needs a tap. Watch
      that it does *not* flash through a visible reconnect when the socket
      survived — that is the pong deadline being handed in on freeze doing its
      job (mp3-pwa.md §6.1).
- [ ] **A thaw onto a dead radio recovers quickly.** Same, but turn the radio
      off before backgrounding and on again after returning: the reconnect
      should land within a couple of seconds, not after the 30s ceiling. This
      is the ladder reset, and it is the one fix whose failure mode is "it
      works, just slowly" — so it needs a clock rather than an impression.
- [ ] **A discarded tab reloads cleanly.** Under memory pressure Chrome throws
      the document away and reloads on return; the app should come back to the
      same conversation from the URL, not to the identity picker.
- [ ] **Pull-to-refresh is gone in the installed window** — drag down on the
      toolbar and on the composer's chrome, in a conversation: nothing reloads.
      Then confirm the *browser tab* still refreshes on the same gesture, which
      is where the gesture is the user's reload.
- [ ] **The connection chip is reachable and tappable from a conversation**
      with a real thumb (flight mode is the easiest way to produce one), and
      pressing it does not catch the back chip beside it.

---

## iOS pass (Safari)

This is the engine none of MP2's or MP3's work is reachable from, and the one
`lib/visual-viewport.ts` exists for. Desktop WebKit answers the layout half
(MP4's `mobile-webkit` project); everything below is what only the phone has.

### Install

- [ ] **Add to Home Screen gives a standalone window** (no address bar) with
      the `apple-touch-icon`, from the manifest's `display` alone — the
      deprecated `apple-mobile-web-app-capable` is deliberately absent
      (mp3-pwa.md §2) and this is the check that the omission was right.
- [ ] **Nothing sits under the notch or the home indicator** in the installed
      window, in both orientations, on the shell, the login screen, the
      identity picker, a long-press sheet and the member-list overlay.
- [ ] **A browser tab is unchanged** by all of the above: same layout, no
      padding, `viewport-fit=cover` notwithstanding.

### Touch

- [ ] **A long press opens the menu at all.** iOS Safari never fires
      `contextmenu`, so before MP2 every one of these menus was unreachable on
      an iPhone. If a hold does nothing, the recognizer is not attaching —
      check that `hover: none` matches on the device.
- [ ] **iOS's own callout does not race it.** No "Copy / Look Up / Share"
      sheet, and no selection handles, on a claimed element.
- [ ] **The action a sheet row performs happens once.** The ghost-click
      swallow is the thing under test: a hold that opens a sheet must not also
      insert the eicon, open the conversation or open the profile card behind
      it. WebKit's compatibility-click timing is its own.
- [ ] **A hold on a message's text still selects the text** — the other side
      of the same rule, and the one iOS is fussiest about.
- [ ] **A sheet raised from a DM row arrives with "Invite to" collapsed**, as
      on Android and for the same reason.

### Keyboard

- [ ] **The composer sits above the keyboard.** iOS leaves the layout viewport
      alone, so a failure here is the whole module not working: the composer
      will be *behind* the keyboard, exactly as it was before MP2.
- [ ] **The composer clears the keyboard without an extra gap** above it — the
      double-pad case `--eb-safe-bottom-kb`'s `max()` exists to prevent.
- [ ] **A sheet raised while the keyboard is up is fully on screen** (see the
      Android note; the inference is the same and the engine is not).

### Scrolling

- [ ] **Momentum feel.** Flick the log up into the backlog and let it coast.
      The log must not snap back to the newest message as the fling runs out.
      If it does — "flick, then glued" — start from MP2 package B's Chromium
      deceleration table (mp2-touch.md §5-B): the question is whether WebKit's
      tail crosses the 120px stick-release hysteresis *later* than 500ms after
      the finger lifts, which would put it outside the #454 intent window.
- [ ] **Stick release and return.** After the fling, an arriving message must
      not yank the view; the jump-to-recent pill returns to the tail in one tap
      and the glue re-engages for good.
- [ ] **Rubber-banding stays inside the log.** Overscroll at the top of the
      backlog must bounce the log, not the page.

### Lifecycle

- [ ] **Returning from the app switcher resyncs.** iOS fires no `freeze`/
      `resume` at all, so recovery there rests entirely on `visibilitychange`
      and the probe's staleness test — the paths #432 built. Leave the app for
      half an hour, come back, and check the log catches up.
