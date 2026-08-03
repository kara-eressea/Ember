# MP1 — Responsive shell (implementation spec)

Companion to [mobile-client.md](mobile-client.md) §MP1 and issue #375. Decided
with the user 2026-08-02, work started 2026-08-03.

Presentation layer only: no store shapes, no gateway frames, no server code.
The desktop layout above the widest breakpoint must be byte-for-byte the same
experience it is today — every change below is additive and gated on a layout
mode.

## 1. Three named layout tiers

The shell has exactly three tiers. They are named once, in one module, and
never re-derived by eyeballing a pixel count at a call site.

| Tier | Effective width | Shell shape |
|---|---|---|
| `phone` | `< 768` | One pane at a time: conversation list ⇄ conversation. Rail folds into the list header. Members / DM profile are full-height overlays. |
| `compact` | `768 – 940` | Today's grid minus the right column by default; sidebar narrows; toolbar collapses to overflow. |
| `wide` | `> 940` | Today's desktop grid, unchanged. |

`compact` already half-exists as the ad-hoc `(max-width: 899px)` /
`(max-width: 940px)` / `(max-width: 820px)` queries scattered across
`dm-sidebar.ts` and `chat.module.css`. MP1 folds all of them into the tier
model; no new one-off breakpoints may be introduced. Those three had drifted
apart from each other — the DM sidebar and the conversation header disagreed
about when a window was cramped — which is the concrete reason the tiers exist
rather than being tidied in place.

**One survivor, named and provisional** (package A). `899` and `940` fold onto
the tier edges cleanly; `820` does not — it is the width at which the
conversation header drops its topic slot and clock, and it sits *inside*
`compact` rather than on either edge. The room it reclaims was judged
necessary while the search field was already collapsed (which starts at 940),
so rounding it to a tier edge is not a no-op in either direction: at the phone
edge the clock returns at 800px, where it was removed for eating the partner's
name; at the compact edge the topic vanishes at 900px, where there is still
room for it. It therefore keeps a name in `layout-mode.ts`
(`HEADER_DENSE_MAX_WIDTH`), is computed from the same effective width as the
tiers so it is zoom-corrected too, and is published as a second root attribute
(`data-header="dense" | "roomy"`). **Package C deletes all three** — the
constant, `headerDensityFor`, and the attribute — when it ports
`ComposerToolbar`'s ResizeObserver and collapses the header by measurement
instead of by width. What §6 forbids is a bare pixel literal loose in a
stylesheet; a named, documented, tier-model-owned threshold with a scheduled
removal is not that.

## 2. Breakpoints are zoom-corrected — CSS media queries alone are wrong

The interface-scale preference sets `zoom` on `:root` (`theme.ts`). Media
queries and `getBoundingClientRect` are blind to it: at 125% scale a 1000px
window lays out as if it were 800px, but `@media (max-width: 940px)` still
sees 1000 and keeps the wide grid — the columns then overflow. This is the
same class of bug `popover.ts` already works around by dividing by
`--eb-ui-zoom`.

Therefore the **effective width** is `window.innerWidth / uiZoom()`, computed
in JS, and the resulting tier is stamped on the document element as
`data-layout="phone" | "compact" | "wide"`. CSS keys off the attribute
(`:root[data-layout="phone"] …`), never off a raw `@media (max-width: …)` for
shell geometry. Media queries remain fine for things genuinely about the
device rather than the layout box — `prefers-reduced-motion`, `hover: none`,
`pointer: coarse`.

Because a scale change fires no `resize` event of its own, recomputation is
driven by two signals: the window's `resize`, and a `MutationObserver` on the
root's `style` attribute (`applyInterface` is its only writer). Both are
coalesced into one animation frame. The attributes are stamped from boot
(`main.tsx`, right after `applyInterface`) rather than from a React effect, so
nothing paints untiered and the login / identity-picker screens — which live
outside `AppShell` — are covered too.

## 3. Phone toolbar keeps exactly two chips

The conversation toolbar has grown to ~8 controls. On `phone` only two
survive as always-visible chips: **search** and the **notification inbox**.
Everything else goes to the `⋯` overflow menu, reusing `ComposerToolbar`'s
existing ResizeObserver + `COLLAPSE_STEPS` mechanism rather than a second,
parallel one. Search stays the right-most element (matching the full-width
toolbar decision from v0.20.0).

## 4. Preferences on phone: the cheap stopgap

`PreferencesWindow` is a two-column section-rail-plus-pane dialog and does not
fit a phone. MP1 does **not** rebuild it. The stopgap: below `phone`, stack
the section rail above the pane and let the whole dialog go full-screen. A
proper mobile prefs flow is MP2 scope at the earliest, and only if the user
wants it after soaking.

## 5. Package breakdown

Packages are cut so that A blocks the rest and the others are conflict-free
against each other.

- **A — layout-mode foundation.** `lib/layout-mode.ts`: the tier type, the
  thresholds, `effectiveWidth()`, `useLayoutMode()`, and the effect that
  stamps `data-layout` on `<html>`. Recomputes on resize *and* on
  interface-scale change. `useIsNarrow()` becomes a derivation of the tier
  (`phone | compact`) so there is one source of truth; its ad-hoc query
  constant goes away. Unit tests cover the zoom correction at each boundary.
  **Blocks B, C, D.**
- **B — route-driven pane stack (phone).** The list ⇄ conversation stack,
  driven by the existing routes: an identity route with no conversation shows
  the list; a conversation route shows the conversation with a back affordance
  to the list. No new router state — back is a route change, so the browser
  and Android back gesture work for free. The identity rail folds into the
  list header.
- **C — toolbar collapse.** §3, by porting `COLLAPSE_STEPS`. Also carries one
  to-do handed over from E: the eicon picker's grid is `repeat(5, 60px)` =
  324px of fixed tracks, so under E's viewport cap it scrolls sideways inside
  the panel instead of reflowing. The fix is `repeat(auto-fill, 60px)` in
  `chat.module.css`, which E could not touch — that file belonged to package A
  while E was in flight. C owns the composer/toolbar chrome the picker hangs
  off, so it lands here.
- **D — members + DM profile overlay (phone).** The right column becomes a
  full-height overlay on `phone`, extending the drawer shim `DmProfile`
  already has for `narrow`. Member list gets the same treatment.
- **E — popover width caps.** Mini profile cards, eicon previews, topic
  popovers and context menus must cap at the viewport with a margin and never
  induce horizontal page scroll on a 360px screen. Builds on `popover.ts`'s
  existing zoom-corrected clamps.
- **F — hover-affordance fallbacks.** Every control that only appears on
  `:hover` (sidebar row buttons, the unrated ad's rating pill, the eicon
  picker's ☆, close affordances) needs a coarse-pointer path via
  `@media (hover: none)`. Hover-only previews (eicon, link) degrade to tap or
  to nothing — never to an unreachable action. *(This clause originally cited
  "message row actions"; the package's sweep established there are none — a
  message row's only reveal-on-hover control is the ad rating pill. The list
  above is the swept inventory, not a guess.)*
- **G — docs + mobile e2e project.** A scoped Playwright project on a phone
  viewport covering the pane stack, the overflow toolbar and the overlays,
  plus the tier model written into `design/ui/COMPONENTS.md`.

PR order: **A + E + F** (foundation and the two independent polish packages),
then **C**, then **B**, then **D**, then **G**.

## 6. Invariants every package must hold

- Above `wide`, no visual or behavioural change. Existing desktop E2E and unit
  suites pass untouched; a diff that has to edit a desktop assertion is a bug
  in the change, not in the test.
- The message log's scroll invariants (#266 / #360 / #372 / #454 / #464)
  survive every layout switch — a tier flip must not strand the log off-tail.
- Tokens only, per `design/ui/COMPONENTS.md`. No hard-coded hex, no literal
  pixel breakpoint outside `layout-mode.ts`.
- Touch targets are MP2 scope; MP1 must not *reduce* any target below its
  current size.
