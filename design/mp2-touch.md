# MP2 — Touch-first conversation view (implementation spec)

Companion to [mobile-client.md](mobile-client.md) §MP2 and issue #376. MP1
([mp1-responsive-shell.md](mp1-responsive-shell.md)) shipped in v0.21.0;
this round makes the phone shell it built pleasant to *use*. Decided with the
user 2026-08-04: MP2 → MP3 → MP4 proceed in order, no soak gate between them.

Presentation layer only, same as MP1, and the same standing invariant: above
the `phone` tier, zero visual or behavioural change unless a line here says
otherwise (the one exception is §1's action sheets, which serve every
coarse-pointer device). Tokens per `design/ui/COMPONENTS.md`; the tier and
pointer questions are already answered by `lib/layout-mode.ts` and
`lib/pointer.ts` — no new breakpoints, no new capability probes.

## 1. Long-press action sheets (the context-menu gap)

The one genuine functional hole on touch: every context menu in the app hangs
off `onContextMenu`. Android synthesizes `contextmenu` from a long-press; iOS
Safari never fires it. MP1's stance was "every action has an alternate path";
MP2's is that the menus themselves work.

- **One recognizer, `lib/useLongPress.ts`** (or a non-hook attachment helper
  where menus are opened imperatively): pointer-events based, ~450ms hold,
  cancelled by movement past a slop radius (~10px — a drag is a scroll, not a
  press), by `pointercancel`, and by a second touch. Fires at most once per
  press, and suppresses the click that follows a recognized press.
- **Where the pointer can't hover** (`useNoHover()`), a recognized long-press
  opens the same menu the right-click opens. On hover-capable devices nothing
  changes — right-click already works, and a long left-press on a desktop
  means text selection.
- **The browser's own long-press behaviours must lose** on the elements we
  claim: `-webkit-touch-callout: none` and `user-select: none` on the press
  targets (message rows keep text selection — see below), and the synthetic
  `contextmenu` Android fires must be deduplicated against the recognizer so
  one hold opens one menu, not two.
- **Presentation: a bottom action sheet** on `phone` — full-width, slide-up,
  one action per 44px row, labelled by the target ("Sparkle — eicon"), with
  the same items in the same order as the right-click menu it mirrors, Escape/
  backdrop/swipe-down-free close (swipe gestures are out of scope; backdrop
  tap and ✕ suffice). On `compact`/`wide` coarse-pointer devices the existing
  anchored menu at the press point is fine — the sheet is a phone idiom.
  Whether sheet vs anchored is keyed on tier alone or tier+pointer is the
  implementer's call to argue in the PR.
- **Targets**: everything with an `onContextMenu` menu today — eicons
  (rendered and name-chip), member rows, channel rows in sidebar/browser,
  sidebar conversation rows, and the message-sender name if it has one. Sweep
  `onContextMenu` for the authoritative list rather than trusting this
  sentence.
- **Message body text is exempt**: a long-press on prose must keep native
  text selection. Only discrete interactive elements get the recognizer.

## 2. Composer above the soft keyboard

On-screen keyboards resize the *visual* viewport, not (reliably) the layout
viewport, and the three mobile engines disagree about which. The composer must
sit above the keyboard and the log must stay readable while typing.

- Track `window.visualViewport` (`resize` + `scroll`) in one module —
  `lib/visual-viewport.ts`, same one-subscription shape as `layout-mode.ts` —
  and expose the keyboard inset (layout height − visual height − offsetTop).
- On `phone`, the shell's second row gets `height: <visual viewport height>`
  (or the inset as padding-bottom — implementer's choice, argued in the PR)
  so the composer lands above the keyboard and the toolbar stays visible.
- **Keyboard-open must not strand the log off-tail**: if the log was at the
  tail when the keyboard opens, it is at the tail after the resize settles.
  This is the #372 invariant under a new trigger; test it explicitly.
- Focus scrolling: browsers auto-scroll the focused element into view, which
  can fight the inset math and double-scroll. Verify against real Chromium
  mobile emulation (CDP can resize the visual viewport) and guard with
  `interactive-widget=resizes-content` in the viewport meta **only if
  measurement shows it helps** — it is Chromium-only and changes the default
  behaviour; document what was chosen and why.

## 3. 44px touch targets

On `phone` (plus `hover: none` where that reads better), every interactive
control reaches a ≥44×44 CSS-pixel hit area. Two rules:

- **Hit area, not glyph**: grow padding or use an `::after` overlay to expand
  the target; the visual density of rows should change as little as possible.
  A 30px IconBtn with 7px of added hit padding is compliant; a row of 44px
  buttons that used to be 30px is a redesign nobody asked for.
- **Adjacent targets may not overlap** once expanded — expanding two 30px
  chips 8px each in a 4px-gap row creates ghost presses. Where a row is too
  dense to expand (the toolbar chip cluster), the row itself must change on
  phone (more gap) rather than shipping overlapping targets.
- Audit list: toolbar chips (inline and in `⋯`), sidebar row buttons and
  rows, rail items, member rows, composer toolbar, message-row inline
  elements (eicon chips, name buttons), overlay/sheet close buttons, prefs
  controls on the phone stopgap. Measure with a script, not by eye; report
  the before/after inventory in the PR.

## 4. Scroll invariants under touch momentum

The #372/#374 bottom-stick and #360 anchor invariants were built against
wheel/keyboard scrolling. Touch adds momentum (scroll events keep arriving
after the finger lifts) and overscroll (rubber-banding past the edge).

- `MessageLog`'s stick-release gate (#454) treats `touchstart`/`pointerdown`
  as user intent; verify the *momentum tail* after a fling still counts as
  user-driven (the intent window is 500ms — a long fling outlives it) and fix
  the gate if a fling's tail re-sticks the log mid-scroll.
- `overscroll-behavior: contain` on the log and the sheets, so rubber-banding
  inside them doesn't chain into the page (or trigger pull-to-refresh in an
  installed PWA — MP3 cares).
- E2E: a CDP-driven fling on the mobile project — release mid-momentum,
  assert the log neither jumps to the tail nor lands off-tail afterwards when
  it was at the tail to begin with.

## 5. Package breakdown

- **A — long-press + action sheets** (§1). Owns the menus, `RichText`,
  sidebar/member/channel row press wiring, the sheet component.
- **B — keyboard + momentum** (§2 + §4). Owns `Composer` integration,
  `MessageLog`, `lib/visual-viewport.ts`, the shell row height on phone.
  §2 and §4 share MessageLog and the same test fixtures, so they ship
  together.
- **C — touch targets** (§3). A CSS-heavy sweep; runs after A so it measures
  the sheets too.
- **D — mobile E2E additions + docs** (MP4's MP2 slice). New mobile specs for
  the sheets, the keyboard, and the fling; `COMPONENTS.md` gains the sheet
  and target conventions; tracker updates. Runs last.

PR order: **A + B** in parallel (disjoint files), then **C**, then **D**.

## 6. Invariants

- Above `phone`, no change on hover-capable devices. Coarse-pointer `compact`/
  `wide` may gain long-press menus (§1) — that is the only exception.
- The log's scroll invariants hold under every new input mode this round adds.
- No new breakpoints, no capability probes outside `lib/pointer.ts` /
  `lib/layout-mode.ts`; no `dvh`/`svh` units without a written argument (the
  visual-viewport module is the one source of keyboard truth).
- Native text selection on message prose survives package A.
