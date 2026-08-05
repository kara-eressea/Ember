# EmberChat — Component Cheat Sheet

Framework-agnostic build reference. Every value here is exact and taken from the design. Build components against **tokens**, never hard-coded hex, so the accent stays swappable.

> **Deviation (2026-07-12, see `../decisions.md` §6):** all avatars (IdentityRail, MeBar, IdentityPicker, MemberRow, context menu, DM rows) render the character's real F-List profile image instead of the mono initial. The initial-on-color spec below remains as the loading/error fallback; sizes, radii, and presence-dot specs are unchanged.
>
> **Deviation (2026-07-12, see `../decisions.md` §8):** the MessageLog also renders inline `[eicon]`/`[icon]` images (small, often animated GIFs) inside MessageLine bodies at a fixed ~60px box with explicit dimensions — not shown in the mockups. The composer's ☺ hint button is the eicon insert helper.

---

## Design Tokens

### Color — neutrals (per base theme; contrast pass 2026-07-21, issue #186)

Ratios are WCAG 2.1 relative-luminance contrast. Target: **4.5:1** body text · **3:1** large text and UI objects. Two text-role rules govern every neutral: **if a human must read the characters, it is `meta` or better; if it is a glyph, dot, marker, or disabled affordance, it is `faint`.**

| Token | Slate | Charcoal | Parchment | Use |
|---|---|---|---|---|
| `bg` | `#1b1917` | `#121110` | `#f6f1e7` | app background, main chat, inputs |
| `side` | `#232120` | `#171615` | `#efe8db` | left sidebar surface |
| `side2` | `#2a2725` | `#1c1a19` | `#e7dfd0` | rail, member list, me-bar, elevated strips |
| `head` | `#201e1c` | `#141312` | `#f2ecdf` | channel header background |
| `text` | `#ece7e0` | `#e9e4dd` | `#2e2a24` | primary text |
| `dim` | `#a89e92` | `#a49a8e` | `#675f52` | secondary text, topic, muted labels, offline names (≥4.76:1) |
| `meta` | `#988e83` | `#8b8377` | `#696154` | **readable meta**: timestamps, helper text, placeholders, empty states, section labels, count pills (AA ≥4.6:1 on every surface) |
| `faint` | `#787065` | `#6e675d` | `#887e70` | **decorative only**: glyphs, pin markers, disabled, presence dots — allowed to fail body contrast |
| `border` | `#332f2b` | `#282520` | `#ddd3c2` | all 1px hairlines / dividers |

Derivations: `meta = mix(dim, faint, {slate: 0.30, charcoal: 0.46, parchment: 0.05})`; `faint = mix(faint₀, text, {slate: 0.05, charcoal: 0, parchment: 0.12})`.

### Color — accent (swappable; default = Dusk Purple)
| Token | Hex | Notes |
|---|---|---|
| `accent` | `#a892c6` | fills only: active bars, badges, mention-row backgrounds, buttons, dots, rings |
| `accentText` | `mix(accent, text, W)` | accent used **as text**: links, `@mentions`, `#channel`, "Show more". `W = 0.04` on dark themes, `0.62` on Parchment. ≥4.55:1 dark / ≥4.86:1 Parchment for all five accents |
| `ok` | `#8bb173` | online presence, success, connected |
| `warn` (idle) | `#d0a24f` | idle presence |
| `danger` | `#e08a6a` | ignore / destructive |

**Accent options** (user-selectable): Amber `#e6a75a` · Clay Red `#c87d6a` · Dusk Purple `#a892c6` · Burnt Orange `#dd955a` · Moss Green `#88ac72`. When accent is Moss Green, shift the idle/warn dot to `#c9a25e` so it doesn't clash.

`accentText` per accent (dark themes / Parchment, via `mix()`): Amber `#e6aa5f`/`#745a39` · Clay `#c9816f`/`#694a3f` · Dusk `#ab95c7`/`#5c5262` · Burnt `#de985f`/`#715339` · Moss `#8cae76`/`#505b42`.

### Derived colors (compute from a `mix(a, b, t)` = linear RGB lerp, `t` = weight toward `b`)
| Token | Formula | Dusk value |
|---|---|---|
| `accentSoft` | `mix(accent, bg, 0.84)` | `#322c33` — mention row bg, active-row bg, chips |
| `accentMed` | `mix(accent, bg, 0.5)` | `#62566f` — unread badge bg, focus rings, borders |
| `codebg` | `mix(text, bg, 0.90)` | `#302e2b` — inline code + code blocks |
| `hoverMain` | `mix(text, bg, 0.95)` | row hover in main |
| `ownSoft` | `mix(text, bg, 0.92)` | `#2c2927` — own-message row bg (hue-free, so it never competes with the accent-tinted mention row) |
| `ownSoftHover` | `mix(text, bg, 0.885)` | `#33312e` — own-message row hover |
| `hover` | `mix(text, side, 0.93)` | row hover in sidebar |

```js
function mix(a, b, t) {            // a, b = "#rrggbb"
  const p = h => [1,3,5].map(i => parseInt(h.slice(i, i+2), 16));
  const A = p(a), B = p(b);
  return '#' + A.map((v,i) => Math.round(v*(1-t) + B[i]*t).toString(16).padStart(2,'0')).join('');
}
```

### Typography
- **UI font:** `'IBM Plex Sans', system-ui, sans-serif`
- **Mono font:** `'IBM Plex Mono', ui-monospace, monospace` — timestamps, code, server addresses, channel `#`, counts
- **Message body:** UI sans (this is the "Slate Cozy" choice — the log is line-based but bodies are sans; of the log's columns only the timestamp is mono)
- **Sender names:** UI sans at the message font size, regular weight — *identical* type to the message body they label, distinguished by their nick colour alone. Applies everywhere a name is rendered: log gutter, ad heads, roll lines. (Amended 2026-08-01: nicks were originally specced mono, and a `font: inherit` bug rendered them sans for most of the project's life; when the bug was fixed the user chose the sans they had been living with. Don't put nicks back on mono.)
- Scale: 10–11px uppercase labels (`.09em` tracking), 12.5–13px body/rows, 13–14px inputs, 15px section titles, 17–18px channel name, 22px dialog titles, 28–46px landing headings.

### Radius & elevation
- `radius` = **9px** (Slate Cozy). Rows, inputs, buttons, chips use it; small chips/tags use 4–5px; pills/badges use full (`20px`+).
- Modal/window radius: `radius + 5` = 14px.
- Modal shadow: `0 40px 100px -20px rgba(0,0,0,.7)`. Popover: `0 20px 50px -10px rgba(0,0,0,.7)`. Window: `0 30px 80px -20px rgba(0,0,0,.6)`.

### Presence system
| State | Dot color | Extra |
|---|---|---|
| online | `ok` | `box-shadow: 0 0 4px ok` (subtle glow) |
| idle | `warn` `#d0a24f` | — |
| offline | `faint` | row reads as *secondary*, not faded: name on `dim` at full opacity, avatar at `opacity: .55`, no blanket row opacity (#186) |

### Role system (IRC)
| Role | Glyph | Glyph color | Name weight |
|---|---|---|---|
| owner | `~` | `accent` | 600 |
| admin | `@` | `mix(accent, text, .4)` | 600 |
| member | *(none)* | `faint` | 400 |

### Per-nick colors (deterministic)
Assign each nick a stable color: `palette[ sum(charCodes(nick)) % palette.length ]`.
Dark-theme palette: `['#a892c6','#c294b0','#8f9bc9','#a6bd94','#88b0b8','#cfa2d4','#c69ac2','#98bda8']` (rotate hues with accent).
Parchment palette (same hues, `mix(c, text, 0.52)` — nicks are must-read body text): `['#695c72','#755d67','#5d6073','#68715a','#596a6b','#7b6478','#776070','#617163']`.

### Gender colors (member list)
Colour member-list character names by their F-Chat gender — supplementary info only: the name stays full-contrast readable without the hue, and gender is never encoded in colour alone (colorblind-safe). Written as `--eb-gender-<slug>`; unknown / `None` genders take the default text colour. Every value clears WCAG AA (4.5:1) on the member-list ground `side2` for all three bases (dark values checked against the lighter slate `side2` `#2a2725`; light values against parchment `side2` `#e7dfd0`).

| Gender | slug | Dark | Parchment |
|---|---|---|---|
| Male | `male` | `#6ea8ff` | `#2f5fb0` |
| Female | `female` | `#f28fb8` | `#a63368` |
| Transgender | `transgender` | `#7cc7b5` | `#276b5b` |
| Herm | `herm` | `#c39be6` | `#7b46b0` |
| Shemale | `shemale` | `#e79cd6` | `#963982` |
| Male-Herm | `male-herm` | `#69c0e0` | `#1c6187` |
| Cunt-boy | `cunt-boy` | `#8fc873` | `#41692a` |

---

## Layout — AppShell

CSS grid, full viewport. Columns (desktop):

```
[ rail 60px ] [ sidebar 244px ] [ main 1fr ] [ members 232px ]
```

- `rail` column only present when >1 identity is connected (or always, if you prefer a persistent switch).
- Optional browser chrome strip (38px) above, only for the marketing/preview framing — not part of the real app.
- Overlays (context menu, dialogs) are `position: absolute/fixed` above the grid.

**Responsive:** see **Layout tiers** below — the shell has three named ones, and no component invents a fourth.

---

## Layout tiers

The shell is responsive in exactly three shapes. They are named once, in `lib/layout-mode.ts`, and no stylesheet or component re-derives them from a pixel count of its own.

| Tier | Effective width | Shell shape |
|---|---|---|
| `phone` | `< 768` | One pane at a time: conversation list ⇄ conversation. Rail folds into the list header. Members / DM profile are full-height overlays. |
| `compact` | `768 – 940` | The desktop grid minus the right column by default; sidebar narrows; the conversation toolbar collapses into `⋯`. |
| `wide` | `> 940` | The desktop grid, unchanged. |

### The `data-layout` contract

The live tier is stamped on `<html>` as `data-layout="phone" | "compact" | "wide"`, from boot (`main.tsx`, right after `applyInterface`) rather than from a React effect — nothing may paint untiered, and the login / identity-picker screens live outside `AppShell` but are still laid out.

**Shell geometry keys off the attribute, never off a `max-width` media query.** `:root[data-layout="phone"] .sidebar { … }`, not `@media (max-width: 767px)`. This is not a style preference:

- The interface-scale pref applies `zoom` to `:root`. Media queries and `getBoundingClientRect` are evaluated *before* that zoom, so at 125% a 1000px window lays the shell out as if it were 800px — cramped, single-column territory — while every media query still reports 1000 and hands it the full desktop grid. The columns then overflow.
- So the tier is decided in JS from the **effective width**, `window.innerWidth / uiZoom()`, and recomputed on two signals: the window's `resize`, and a `MutationObserver` on the root's `style` attribute (a scale change fires no resize event of its own). Both coalesce into one animation frame.

Write the tier attribute selectors **positively** — `:is([data-layout="phone"], [data-layout="compact"])`, never `:not([data-layout="wide"])` — so a root that has not been stamped yet gets the desktop shape rather than a flash of the narrow one.

Media queries remain right for questions genuinely about the *device* rather than the layout box: `prefers-reduced-motion`, `pointer: coarse`, `hover: none`.

### `data-pane` — the phone stack

On `phone` the shell carries `data-pane="list" | "conversation"` on `[data-testid="app-shell"]`, and only there: on `compact` and `wide` the attribute is absent, which is itself the contract — a rule that wants the two-column grid asks for the absence, and nothing has to keep a third value in sync. The value is derived from the route, not from state of its own: an identity route with no conversation is `list`, a conversation route is `conversation`. Back is therefore a route change, so the browser's Back button and the Android back gesture walk the stack for free.

### `data-eb-surface` — floating surfaces cap at the viewport

Every floating surface — popover, context menu, preview card, anchored panel — carries the bare attribute `data-eb-surface`, and `styles/base.css` caps all of them in one place at `calc(100vw / var(--eb-ui-zoom, 1) - 2 * var(--eb-popover-margin))`. Only `max-width`: a surface keeps its own preferred width and the cap bites only when the screen cannot hold it. A module that restates the arithmetic (`max-width: calc(100vw - 32px)`) is stating the zoom-blind version of the same rule and should carry the attribute instead.

Anything sized against the viewport outside that cap — an edge-anchored drawer, a lightbox image — divides `vw`/`vh` by `var(--eb-ui-zoom, 1)` itself. `vw` is a *visual* length: inside the root's `zoom` a 100vw box paints 1.25× the screen.

### `data-eb-hover-reveal` — controls that only exist on hover

A control revealed by `:hover` does not exist on a touchscreen; the event never fires and nothing stands in for it. Each such control (sidebar row buttons, the unrated ad's rating pill, the eicon picker's ☆) carries the bare attribute `data-eb-hover-reveal`, and `base.css` leaves it at `opacity: 1` under `@media (hover: none)`. Hover-only *previews* (eicon, link) degrade to tap — never to an unreachable action. The behavioural half is `lib/pointer.ts` (`useNoHover()`).

`hover: none` rather than `pointer: coarse`, deliberately: a touchscreen laptop reports a coarse pointer among its inputs but still has a mouse as its primary one, and should keep the quiet rows.

### Invariants

- Above `wide`, no visual or behavioural change, ever. A diff that has to edit a desktop assertion is a bug in the change.
- No literal pixel breakpoint outside `layout-mode.ts`. A width that is about the *window* belongs there; a width that is about one *row* belongs to that row and is measured, not guessed (`lib/useRowWidth.ts`).
- The message log's scroll invariants survive every tier flip — a layout change must not strand the log off-tail.
- The scroll invariants hold under touch as well as wheel and keyboard — see **Touch conventions** below.

---

## Touch conventions

What the `phone` tier and a coarse pointer add on top of the shell shapes above. The tier answers questions about the *layout box*; these answer questions about the *finger*, and they are not the same question — a 390px window on a desktop is `phone` and still has a mouse.

### `data-eb-press` — long-press opens the context menu

Every context menu in the app hangs off `onContextMenu`. Desktop fires it from the right button and Android synthesizes it from a hold; **iOS Safari never fires it at all**, so on an iPhone none of those menus existed. `lib/useLongPress.ts` is the second opener: a hold on a claimed element calls the same handler the right-click calls, with the same event shape.

- **Installed only where the primary pointer cannot hover** (`useNoHover()`). With a hover-capable pointer the hook returns an empty props object — no listeners, no attribute — because the right-click already works there and a long left-press means text selection.
- **The recognizer**, in pointer events rather than touch events (a touch pointer is implicitly captured to the element that got `pointerdown`, and a scroll announces itself as `pointercancel`): a **450ms** hold, cancelled by movement past a **10px** slop radius, by `pointercancel`, or by a second finger. It never sets `touch-action: none` — every claimed target sits inside something scrollable, and taking the gesture off the compositor would cost that scroll.
- **`PressEvent`** is the contract with the menus: `{ clientX, clientY, currentTarget, preventDefault, stopPropagation }` — the subset of a `contextmenu` MouseEvent an opener actually reads. A menu takes `(event: PressEvent) => void` and is then openable by either route without knowing which fired.
- **Two suppressions the press owns.** Android's synthetic `contextmenu` is deduplicated in both directions (ours swallows a duplicate arriving within **700ms** of the press; the platform's disarms our pending timer if it gets there first), so one hold opens one menu. The compatibility "ghost" click the engines synthesize after `pointerup` is swallowed on `window` in the capture phase within **350ms** of the lift — it is told apart from a real tap by having no `pointerdown` of its own, and it does not reliably land where the finger was.
- **The attribute is the scope.** Claimed elements carry the bare `data-eb-press`, and `base.css` puts `-webkit-touch-callout: none` and `user-select: none` on exactly those — iOS's own callout sheet and selection handles appear at roughly our threshold and would race the menu. Nothing else is touched, which is how **message prose keeps native text selection**: a long press on what someone said still selects it. Only discrete interactive elements are ever claimed.

### `MenuSurface` — one menu, two shapes

The five context menus (eicon, member, channel, section-offline, identity rail) render through `components/common/MenuSurface.tsx`, which decides the shape and nothing else. The item list is authored once, in the menu component, as the JSX it always was.

| Tier | Shape |
|---|---|
| `compact`, `wide` | The anchored popover, unchanged: a fixed panel measured and clamped to the press point over a click-away overlay. |
| `phone` | A full-width bottom sheet: the menu's own header plus a ✕, 44px rows, backdrop tap / Escape / ✕ to close, modal (focus trap, focus returns to the opener). The channel menu's "Show ▸" flyout drops inline and indented — in a full-width sheet there is no "beside". |

**Keyed on the tier alone, not tier-and-pointer.** The question the sheet answers is geometric — is there room beside the finger for a panel — and that is what the tier already is. Keying on the pointer too would hand a mouse user in a 390px window the cramped popover the sheet exists to replace, and hand a tablet with a paired mouse a sheet it has the width to avoid.

The sheet's rows are selected by the ARIA role each item already carries (`[role^="menuitem"]`), not by class: every menu lives in a different CSS module, and the roles are both the stable contract across that boundary and an accurate description of what gets a 44px row.

### `--eb-keyboard-inset` — the soft keyboard

A soft keyboard shrinks the **visual** viewport. What it does to the **layout** viewport — the box `100%` and `100vh` resolve against — is engine-specific: iOS Safari leaves it alone (so a bottom-anchored composer sits *behind* the keyboard, which is the case this exists for), Chrome Android does the same by default, Firefox Android resizes it and needs no help.

`lib/visual-viewport.ts` is the one source of keyboard truth — one subscription over `window.visualViewport` (`resize` + `scroll`), same shape as `layout-mode.ts`. It publishes `layoutHeight − visualHeight − offsetTop`, divided by `var(--eb-ui-zoom)` for the same reason every other viewport measurement is (`vh` and the two viewport heights are visual lengths; a `calc()` term inside the zoomed root is not), floored at zero, and ignored below **120px** so the browser's own retracting chrome is never mistaken for a keyboard.

- **Published as a CSS custom property on `:root`, not as React state.** A keyboard animates open over ~250ms; routing that through `useSyncExternalStore` would re-render the virtualized log and every visible row ~15 times, on the devices with the least CPU to spare. `data-keyboard="open"` rides along for anything that needs to switch rather than subtract. Both are *removed* when the keyboard closes, so the `var(--eb-keyboard-inset, 0px)` fallback is the single definition of "no keyboard". `useKeyboardInset()` exists for the rare consumer that needs the number in JS.
- **One rule reads it: the shell shrinks.** `:root[data-layout="phone"] .shell { height: calc(100% - var(--eb-keyboard-inset, 0px)) }`. Shrinking the shell rather than padding the composer's row is a choice about how many boxes have to agree — the shell's rows are `auto minmax(0, 1fr)`, so taking height off the bottom shortens the log's track and carries the composer and its toolbar up in one reflow, and every fixed/absolute child positioned against the shell stays correct. Padding the row would leave the shell overlapping the keyboard and need a correction per floating surface.
- **The viewport meta deliberately does not carry `interactive-widget=resizes-content`.** It works, and it is Chromium-only — so the module has to exist for iOS and Firefox regardless, and adding it would take the one engine most of our phone testing runs on out of the code path.
- Tracking is armed once at boot in `main.tsx`, beside `startLayoutTracking`, for the same reasons: the value must exist before the first paint, and the login screens live outside `AppShell` but are still typed into.

### `overscroll-behavior` — a scroll region keeps its own overscroll

Every scroll region that can reach an end on a phone carries `overscroll-behavior: contain`: the message log, the conversation list, the member list, the eicon picker's grid, the sheet's item list. Without it the leftover momentum chains to the nearest scrollable ancestor — on a phone that is the page, so reaching the top of the backlog rubber-bands the whole shell, and in an installed PWA (MP3) the same overscroll at the top is what the platform reads as pull-to-refresh, i.e. a reload of the client mid-read.

`contain` rather than `none`: the elastic bounce *inside* the region is the platform's own "you are at the end" feedback and there is no reason to take it away.

### `--eb-log-reveal` — pull the message log sideways for its timestamps

The phone log has no timestamp column (§6). The stamps still exist, parked at a negative inline offset outside the log's clip edge; a horizontal drag translates the rows right and uncovers them, per row, and lets go. iMessage's gesture, mirrored, because our stamps have always been on the left. `lib`-shaped but log-local: `components/chat/pull-reveal.ts`.

- **Axis-locked, decided once.** The recognizer arms on `pointerdown` and watches; the first movement past **8px** on either axis decides it. Predominantly horizontal claims the gesture; anything else — including an exact diagonal, which goes to the scroll — releases it *for the rest of that gesture*, so a flick that wanders sideways is never stolen mid-momentum. The claim point, not the touchdown point, is what the travel is measured from, so the rows start at rest instead of jumping the threshold's worth.
- **`touch-action: pan-y pinch-zoom` on the log is the mechanism**, not `preventDefault` — a `pointermove`'s default action is not cancelable in any way that matters. The declaration tells the compositor this element pans vertically and nothing else: a horizontal gesture is therefore never handled by the browser and its moves reach JS, while a vertical one still scrolls on the compositor and arrives here as the `pointercancel` that releases us. Declared as a `pan-y` fallback plus the `pan-y pinch-zoom` pair, so an engine that does not know `pinch-zoom` loses pinch rather than the axis lock. The log also takes `overflow-x: clip`, because `overflow-y: auto` computes the other axis to `auto` and the translated rows would otherwise be horizontally scrollable content.
- **Transform, not layout.** Travel is published as `--eb-log-reveal` written imperatively on the log element — the `--eb-keyboard-inset` pattern, for the same reason: a drag produces a move event per frame and React must not see any of them. Capped at **72px** (sized from the widest stamp the prefs can produce) with an asymptotic rubber band that adds at most 24px more; release animates home in 180ms, instantly under `prefers-reduced-motion`.
- **The tier installs it; the pointer type narrows it.** `phone` alone decides whether the gesture exists — the question is geometric, like the action sheet's. Inside it the recognizer still ignores a **mouse** pointer, because a horizontal mouse drag across prose is a text selection and there is no way to have both; a finger cannot select without a hold first, so nothing is taken from it.
- **Nothing else moves.** A claimed pan fires no scroll event, so the #454 stick-intent gate and the bottom-stick cannot see it. `useLongPress`'s 10px slop sits just outside the 8px claim, so any pull that is visibly doing anything has already cancelled the press it may have started on — the two nest by threshold rather than by arbitration.

### `--eb-touch-target` — 44px hit areas on `phone`

`44px` is where Apple's HIG and WCAG 2.5.5 AAA agree. It is a floor on the **hit area, never on the glyph**: a 30px IconBtn wearing an invisible 44px target is the goal; a row of 44px buttons that used to be 30px is a redesign nobody asked for. Two mechanisms carry it, and **what sits next to a control decides which one it gets**:

- **A stacked row grows** (sidebar rows 28→44, member rows 38→44, overflow-menu rows 34→44, prefs rail items). A hit area taller than the row would reach into the rows above and below, where the neighbour is another target and a finger cannot tell them apart. Rows are the one place the floor is allowed to cost pixels.
- **Everything else keeps its box** and gains a centred `::after` sized `max(100%, var(--eb-touch-target))`, so it expands only in the dimension it is short in and shrinks nothing.

**Adjacency rule:** where two expanded neighbours would contest the same pixels, the **row opens up** — a wider `gap` on `phone` (the conversation toolbar, composer toolbar, sidebar toolbar and MeBar go to 16px, the colour-swatch row to 22) — rather than shipping two controls fighting over one target. Two targets that share a boundary each lose the pixel on it, so the gap arithmetic is set from the measurement, not from the exact sum.

Both mechanisms are gated on `data-layout="phone"` in the module that owns the control — the tier rather than a media query for the interface-zoom reason above, and the tier rather than `hover: none` because the rules that come with it are about a row's width, which is a layout question. Every module that expands a target says which mechanism it used and why.

**Measured, not eyeballed.** An `::after` has no node for a rect API to report, so `e2e/touch-targets.ts` hit-tests every operable element on a surface and `mobile-targets.spec.ts` walks the shell asserting both rules over everything it finds, rather than over a hand-written list that stops catching the ninth control. `base.test.ts` asserts the stylesheet's `44px` and the sweep's `TARGET_MIN_PX` agree.

**The documented shortfall** is message-log prose — sender names, name-mode eicon chips, links and mentions sit in a 21px line box whose neighbours above and below are the same kind of target, so a 44px hit area there would hand the press to the wrong line. Every action behind them stays reachable from a surface that does meet the floor (the member list, the action sheet). An exclusion added later without that argument is a bug in the change.

### Hover is a *behaviour* question too, not only a style one

`@media (hover: none)` keeps every reveal-on-hover control drawn (`data-eb-hover-reveal`). The matching rule for JavaScript is `lib/pointer.ts`, and it is the one that keeps getting missed: an `onMouseEnter` that **opens a UI state** is a hover affordance in exactly the same way, and a touchscreen fires the compatibility `mouseenter` — including the one synthesized by the press that *raised* the surface — while never sending the `mouseleave` that was supposed to close it again.

**The rule is either/or, never both.** Where the primary pointer cannot hover, the hover pair is not attached at all and the click carries the whole interaction. Two places state it:

- `lib/useSubmenuTrigger.ts` — the nested "Invite to ▸" / "Show ▸" panels. Under a mouse the trigger's click is deliberately *open-only* (the pointer must enter the wrapper before it can click, so a toggle would shut what hover just opened); under a finger it is an ordinary toggle, and there is no `mouseenter` to expand the panel unasked as a sheet rises.
- `RichText`'s eicon chip — the name-only preview, `hoverProps` or `tapProps`, never the two together (one tap would otherwise open and immediately close it).

A new hover-driven behaviour goes through one of those shapes or states its own argument. Styles are swept by the media query; behaviours are not swept by anything, which is why they are written down here.

### Invariants

- Above `phone`, no change on a hover-capable device. Coarse-pointer `compact`/`wide` gaining a long-press opener is the one exception — the menu it opens is still the anchored one.
- The log's scroll invariants (#266 / #360 / #372 / #454 / #464) hold under touch momentum and under a keyboard opening: a fling's tail must not re-stick a reader mid-scroll, and a log at the tail when the keyboard opens is at the tail after the resize settles.
- Native text selection on message prose survives the recognizer.
- No capability probes outside `lib/pointer.ts` / `lib/layout-mode.ts`; no `dvh`/`svh` units — `lib/visual-viewport.ts` is the one source of keyboard truth.

---

## Components

### 1. IdentityRail
Far-left vertical switch between connected server identities. Background `side2`, `border-right`.
- **Item:** 40px avatar, mono initial, `color: bg` on a per-identity color fill.
  - **Active:** avatar becomes a rounded square (`radius+2`), row shows `inset 3px 0 0 accent` bar.
  - **Inactive:** avatar stays a circle.
  - Presence dot bottom-right (11px, `2.5px solid bg` ring).
  - **Badge** top-right for background identities: unread count (`accentMed` bg) or `@`/`@n` mention (`accent` bg, `bg` text). Active identity shows no badge.
- **Add button:** 40px dashed circle, `+`, `faint`.
- **Behavior:** click = switch active identity → swaps the *entire* session context (see AppShell data). Right-click (to build): Set status / Reconnect / Disconnect / Reorder.
- **Data:** `{ id, name, initial, color, presence, active, unread, mention }[]`.

### 2. Sidebar (unified nav)
Vertical flex on `side`. Top→bottom: ServerHead · Search · NavScroll (sections) · MeBar.

**ServerHead** — `--eb-topbar-height` tall (the same variable the conversation header uses, so the two bottom borders make one line across the top of the app), `padding: 0 14px`, bottom border, baseline-aligned. App name (14px/700) + the running version beside it (mono 10.5px `meta`, e.g. `v0.19.1`). No presence here: the identity rail and the MeBar already carry it. When the server's update check has seen a newer release the version tints `accentText` and becomes the link to the releases page (title `vX.Y.Z available`) — the whole announcement, no banner.

**Search** — 30px pill, `bg` fill, `border`, `⌕` + "Jump to…" placeholder (`meta`).

**MeBar** — bottom, on `side2`, top border. 30px accent avatar (self initial, `bg` text) · nick (13px/600) + status row with dot · gear.

### 3. SectionHeader
Sidebar group label. Padding `12px 16px 4px`, 10.5px/700 uppercase, `.09em` tracking, `meta`. Optional right-aligned count (10px `meta`). Sections in order: **Pinned · Channels · Direct Messages · Friends · Bookmarks**.

**The whole row is the collapse toggle** (#496) — one `<button>`, not a button hugging the label inside a wider strip, which left the gap after the word and the count at the far right looking exactly as clickable as the label while doing nothing. The count rides inside it and is `aria-hidden`, so the accessible name stays the section's word; anything *interactive* added to the right of a heading later goes outside the button. The heading is also a `data-eb-press` target (the people sections' "Show offline", #329), and it is the same element — MP2's ghost-click swallow is what keeps a hold from also collapsing the section.

> Pinning is cross-type: a pinned channel *or* pinned DM both surface under **Pinned** and auto-rejoin/reopen on connect. The same item still logically belongs to its type.

### 4. NavItem (channel / DM / friend / bookmark row)
One row component, variants by `glyph` + presence. Padding `5px 10px`, margin `1px 6px`, `radius`.
- **Leading glyph** (`faint`): `#` channel (13px mono, or the round tinted token when sidebar avatars are on) · none for DMs (presence dot instead) · star friend · pennant bookmark.
- **Presence dot** (7px) for people rows.
- **Label** (13px): ellipsis. Weight 600 active / 500 normal / 400 muted. Color: `text` active or unread/mention; `dim` normal; `faint` muted.
- **Trailing column** — one right-aligned slot, same order on every row: **muted** (bell-with-slash) · **pinned** (thumbtack) · **badge**. The two state glyphs are `faint`, `role="img"` with a name ("Muted", "Pinned"). The hover-revealed ✕ (#291) takes the whole column's turn, not the badge's alone; under `hover: none` both stay and the row reserves the ✕'s width.
- **Badge:** unread number (`accentMed` bg, `text`) or mention `@`/`@n` (`accent` bg, `bg` text). Radius 9px, mono 10px/700.
- **Active:** `background: accentSoft` + `inset 2px 0 0 accent`.
- **Data:** `{ kind:'channel'|'dm'|'friend'|'bookmark', label, pinned, muted, presence?, unread?, mention?, active }`.

**Glyphs are stroked inline SVG** at 14px, from the shared `icons/Glyphs.tsx` set the conversation toolbar uses (#490) — the sidebar's own row and heading markers (`▸ ▾ ⚲ ★ ⚑`) were the last Unicode ones in the shell, set at 9–11px, i.e. *below* the type they annotate, and at that size a font decides how much of a `⚲` survives. Every glyph in that module takes a `size`, and the stroke is re-derived from it so a 14px glyph paints the same 1.2px line as a 17px one.

### 5. ConversationHeader (channel + DM toolbar)
One row, both conversation kinds, on `head` with a bottom border: fixed `--eb-topbar-height` (46px) height — shared with the sidebar's ServerHead, which is the other half of the same top line — and `padding: 0 10px 0 18px`, so the log never shifts when a conversation has no topic. It runs on the **composer toolbar's language** (component 8) — the same 30×30 IconBtn, the same 1×18px `border` cluster dividers — so the top and bottom edges of a conversation read as one instrument. No system emoji anywhere: every action is a stroked inline SVG in `currentColor`.

**It is a shell row, not part of the chat column.** The shell grid gains a first row (`auto`, so it collapses to nothing with no conversation open) and the toolbar occupies `grid-column: 3 / -1` — the chat column *and* the right column — so it rides above the member list / profile panel and reaches the window's right edge. When `membersClosed` drops the 4th track it spans the chat column alone, unchanged. It carries `min-width: 0` (the `.main` trick) or its nowrap topic would force the `1fr` track wider than the window, and `position: relative; z-index: 7` so it stacks over the column resize handles instead of letting a 6px drag strip cross the row. The right column therefore has **no head of its own** — the member list opens straight into its filter, and the docked profile panel into its hero.

Left → right:

- **Identity** (flex, takes the spare width): leading `#` (17px mono `faint`) for channels or a 9px presence dot for DMs · **name** (15px/700, ellipsis, capped at `24ch`, floored so it never vanishes) · 1×15px hairline · **topic**.
- **Topic slot** — the channel's CDS description or the DM partner's status line (`{status} — {statusmsg}`), inline at 12px `meta`, one line, ellipsis. The inline copy is `inert` (no tab stops, no clicks reaching its BBCode chips); clicking the slot opens a **popover** under it with the whole thing live, links included. This replaces the old Show more / Show less row. Eicons in the inline copy are clamped to 15px so a topic can never grow the row.
- **Partner clock** (DMs, when a zone is known — #439): clock glyph + `HH:MM` in mono `faint`, `tabular-nums`, tooltip naming the zone and its source. It sits *outside* the topic slot and never shrinks — inside it, an overlong status would truncate it away.
- **Action chips** (IconBtn, `aria-pressed` on the toggles): channel — pin, mute, room settings (op+ only, gear); DM — pin, mute, ignore. Toggled = `accentSoft` + `accentText` + `inset 0 -2px 0 accent`; ignore uses the same shape in `danger`.
- **Campaign pill** (M11, conditional): a quiet accent pill with a pulsing `ok` dot, reading "Campaign".
- **Divider** · **view toggles**: channel — members (people glyph + mono count); DM — profile panel, conversation menu (⋮), close (✕).
- **Inbox chip** (#467), between the view toggles and the search field — the notification inbox, per *identity* rather than per conversation, parked here because this row is the one thing always on screen while a conversation is open. An IconBtn like the rest, carrying a **paper-tray** glyph (deliberately not a bell: the bell two chips left is the mute toggle) and, when anything is unseen, a `accentSoft`/`accentText` count pill on its top-right corner — mono, `tabular-nums`, 9.5px, "99+" past the cap. Opening it marks everything seen, so the pill clears on the click.
- **Search field**, last and flush to the window's right edge — the row spans the right column, so this is where a search box belongs. The sidebar filter's pill reused: 28px tall, 14px radius, `bg` fill, magnifier + "Search log" placeholder in `meta`. It **owns the query**; results drop out of a `side` card anchored under it — scope segments ("This conversation" / "Everywhere") and a close ✕ on a hairline-separated head, then the hit rows. Focus = `accent` border + `accentSoft` ring.

**Narrow behaviour**, in the order things give way: the topic shrinks first, then — outside the `wide` tier — the search field parks as a magnifier chip and grows back on focus, taking the topic's room rather than the name's. Below that the row sheds controls into a `⋯` overflow menu, in this order: topic + clock, then pin + mute, then ignore / room settings / close, then the partner actions menu, then the member-list and profile-panel toggles. **Search and the inbox chip never collapse**, and on `phone` they are the only two left inline (see Layout tiers).

The collapse point is **measured, not a breakpoint**: the row is `window − rail − sidebar`, both of which the user can hide or drag, so what a window width implies about this row is a guess. It watches its own width (`lib/useRowWidth.ts`) and drops the next item when what remains no longer fits — which is also why a channel header, carrying three chips fewer than a DM's, keeps its description a good deal longer. Above `wide` it never collapses at all, so the desktop row is unchanged by construction.

- **Data:** `{ conversation, memberCount, pinned, muted, ignored?, topic, canManageRoom, notificationsUnseen }`.

#### 5a. Notification inbox (dropdown)
Drops out of the inbox chip on the search panel's card: `side` fill, 1px `border`, `radius`, the same 18/44px shadow, 340px wide, `max-height: min(60vh, 520px)`, anchored `top: calc(100% + 8px); right: 0`. A hairline-separated head reads **Notifications** (13px/600) with **Newest first** in `faint` on the right — the direction has to be stated, because it is the opposite of the log underneath: newest at the top, **older paging in as you scroll DOWN**. (A dropdown that grew upward from its anchor would push its own newest row off the top edge on every page.)

A row is a flex **container** (`radius`, `hover` on hover and `:focus-within`) holding the entry's button and, after it, the entry's own controls — a button inside a button being no kind of markup. The **entry button** takes the spare width at 6/8px: a **kind glyph** in mono `accentText` (`@` mention · `♥` friend request · `✉` note · `❝` comment reply) · a two-line text column — the headline ("Nyx mentioned you in #Frontpage", "Tally sent a friend request", "New note from …") over an optional excerpt in `tiny`/`meta`, one line, ellipsis — · a relative timestamp in mono `faint` (`ago`). Rows **unseen at the moment the panel opened** carry `inset 2px 0 0 accent`; they keep it for that open, then read as ordinary log entries.

**Trailing cluster**, right-aligned, same order on every row (#505/#506): the friend-request answer, then the trashcan.

- **Answer a friend request inline** — glyph-only ✓ / ✕ (`Accept friend request from …` / `Decline friend request from …`), `faint` at rest, tinting `ok` / `danger` on hover and focus. They call the same endpoint the sidebar's request rows do, and they are drawn only while the request is **pending** — which is read off the live request list, never off the row: a request answered on another device, or on f-list.net, resolves the entry here with no verdict stored anywhere. Resolved, the slot reads **Accepted** / **Declined** in `tiny` `faint`. Before this device has the social lists, the slot is empty rather than guessing. v1 keeps the sidebar's request rows as a second surface.
- **Remove notification** — a trashcan, `faint`, tinting `danger`, hidden until the row is hovered or the button focused (`opacity`, so it stays tab-reachable) and permanently drawn under `hover: none` (`data-eb-hover-reveal`); the row reserves its width either way. It removes the **log line only**: a deleted friend-request entry leaves the request pending on its other surfaces. On `phone` the row's controls all **grow to 44px** rather than wear overlays — they are immediate neighbours, and the neighbour is the difference between accepting a request and deleting the line about it.

It is a **log, not a to-do list**: entries persist after they are read or acted on — the trashcan is the one way a row leaves, by the user's own hand. Clicking the entry closes the panel first (it covers exactly the part of the log a jump lands in), then acts: a mention jumps the log to that message through the M9 search-jump path; a friend request goes to that identity and flashes the sidebar's request rows; notes and comment replies open f-list.net. Escape and an outside pointerdown dismiss — a light popover, no focus trap, the same ceremony as the search panel.

Muted conversations still get their entries — mutes silence alerts, not history (decisions.md §10) — they simply never count toward the chip's pill.

- **Data:** `{ entries: [{ id, kind, character, excerpt, convId?, messageId?, muted, createdAt }], unseen, lastSeenId, hasMore }`, plus the identity's live social lists (which of the friend-request entries are still pending).

### 6. MessageLog (IRC-compact)
Scroll region, `padding: 12px 0`. Four row types, all `display:flex; gap:9px; align-items:baseline`:

- **DateDivider** — centered mono 11px `meta` between two `border` hairlines.
- **SystemLine** (join/part/topic/etc.) — `[time]` · glyph · italic text (12.5px `dim`). Join `→` `ok`; topic `⚑` `accent`.
- **MessageLine** — `[time]` (mono 11.5px `meta`, `tabular-nums`) · `<nick>` (mono 12.5px/600, per-nick color, nowrap) · body (13px/1.5 `text`). Padding `2px 16px`.
  - **Mention/highlight** (matches a highlight rule or your nick): `background: accentSoft` + `inset 3px 0 0 accent`, padding `4px 16px`.
  - **Own message** ("Tint your own messages", default on): `background: ownSoft` (`ownSoftHover` on hover) — no edge bar and no padding change, so consecutive own rows read as one seamless block and the tint stays clearly quieter than a mention. Mention wins if a row were ever both. Ads, rolls, system and queued-send lines keep their own treatment.
- **CodeBlock** (fenced) — its own line, `margin: 3px 16px 5px 76px` (the 76px left indent aligns it under the message body), `codebg` fill, `border`, mono 12px, `white-space: pre`, horizontal scroll.
- Toggle "Show join/part/quit" (Preferences) hides SystemLines of that kind.
- **LoadingSkeleton** (#460) — covers the log viewport while the buffer is fetching and while the virtualizer's first measurement pass settles; the real rows stay laid out but unpainted underneath (measurement needs layout), and swap in the frame the positions agree with the measured sizes. Message-shaped placeholder rows — `[time]` stub · name bar · 1–3 body bars of varying width — carrying the same shimmer as the profile viewer's loading placeholders. Deterministic widths per row index, never random. No spinner and no minimum duration: a channel whose heights are already known reveals within a frame or two.

**On `phone` the row is a different shape (#513), and the tier decides it, not the prefs.** A MessageLine there is `display: block` — the name leads the paragraph and the body wraps to the full width under it, rather than a flex row whose every wrapped line is indented past the name. `alignedColumns` is *overridden* (never written): a 12em name column plus a timestamp is over half a 393px screen, and roleplay-length prose beside it renders one word wide. The pref keeps applying above phone, and the log publishes which shape it is in as `data-log-flow="aligned" | "inline"`. Timestamps leave the line entirely and become the **pull-to-reveal gutter** (see Touch conventions); `timestampFormat: off` is still obeyed, and ads keep their inline stamp — an ad head is a chip row, not prose. Nothing about the day dividers or the unread bar's "since ⟨time⟩" changes.

### 7. Markdown rendering (message body + composer preview)
Inline tokenizer over these patterns → styled spans:
| Token | Rendered as |
|---|---|
| `**bold**` | `font-weight:700`, `color:text` |
| `*italic*` | `font-style:italic` |
| `` `code` `` | mono, `codebg` bg, 3px radius, `1px 4px` pad |
| `@name` | `color:accent`, `accentSoft` bg, 3px radius, 600 |
| `#channel` | `color:accent`, clickable |
| `https://…` | `color:accent`, underline, `text-underline-offset:2px` |

Order matters — match longest/most-specific first (`**` before `*`). Fenced ``` ``` ``` blocks render as a CodeBlock row (component 6), not inline.

### 8. Composer
Below the log, `padding: 0 20px 16px`. Toolbar + input read as **one bordered MessageBox** (#205): `side` fill, `border`, `radius`; `focus-within` = `accent` border + `accentSoft` ring.
- **Toolbar row** (top, 36px, `padding 0 8px`, `gap 2px`, bottom hairline `border`): promoted actions in six clusters split by dividers (1×18px `border`, `margin 0 6px`) — **Bold·Italic·Underline·Strikethrough** | **Superscript·Subscript** | **Spoiler·Code·No-parse** | **Colour·Eicon·Character icon** | **Add link·Character profile link** | **Timer** — then an `auto` spacer and the pinned-right `?` help. Tooltips are plain-language, never BBCode jargon.
- **IconBtn** (30×30, radius 7): glyph `dim` at rest (never `faint`), hover = `hoverMain` fill + `text` glyph, toggled = `accentSoft` fill + `accentText` glyph + `inset 0 -2px 0 accent` bar (buttons reflect the format under the caret; Ctrl+B/I/U mirror them), disabled = `faint`. Glyphs are inline SVG stroked in `currentColor` (17px, 1.7) or UI-font letters — never system emoji.
- **Colour popover:** "Text colour" head (11px/700 uppercase `meta`), 6×2 grid of 22px swatches on the twelve `--eb-bbc-*` tokens (plain-name tooltips; selected = `2px side` + `2px accent` double ring), "✕ Remove colour" row under a hairline. The button is a bold **A** over a 3px bar tinted to the last-used colour. The `--eb-bbc-*` set is retuned into the readable band (≥4.5:1) like the nick palette: one dark set; Parchment darkens via `mix(name, text, .52)` with `white → text`, `black → heading`.
- **Timer** (send timing — replaces the old footer send-mode dropdown): off = instant. Popover radios Off · 15s · 30s · 1m · 5m · Custom (protocol caps 300s) with note "Gives you time to edit before it sends." Armed = the one accent-filled control: `accent` fill, `bg` glyph, widened with a mono delay label (`⏱ 30s`). While a send is parked, a countdown chip `⏱ 0:29 · Edit · Cancel` sits at footer-left (Edit recalls the text into the input; Cancel discards).
- **Spoiler:** wraps in `||…||` (client Markdown; the pipes ride the wire as plain text — never a `[spoiler]` tag). Renders as a covered bar (`text` fill, transparent content) that toggles on click, viewer-local.
- **Link / character popovers:** small input popovers (title, field(s), note, Cancel/accent confirm). Add link = Text + Address → `[url]` ("With no text, the address itself becomes the link"). Character profile link → `[user]` — note *"Does not notify or ping them — F-Chat has no mentions."* Character icon → `[icon]` ("No notification is sent."). There is **no mention/ping** anywhere.
- **Narrow widths:** the row never wraps or scrolls — lower-priority actions collapse into a right-slot `⋯` overflow menu (plain labels + Formatting help), in order Sub/Sup → Underline/Strike → Spoiler/Code/No-parse → Links → Char-icon → Colour; **Bold, Italic, Eicon, Timer** survive to the narrowest. A fully-collapsed cluster drops its divider.
- **Input row:** 46px inside the MessageBox. Leading `+` (attach, 20px `faint`), text input (13.5px, mono or sans per body setting) — no trailing hints.
- **Live Markdown preview panel** (toggle): appears *above* the MessageBox. `side` card, `border`, header strip ("PREVIEW · markdown", mono 9.5px/700 `meta` on `side2`), body renders the composed text through the component-7 tokenizer at 13px.
- **Footer row** (both runs 11px `meta` — never `faint`): left `Ⓜ Markdown` (on = `accent`) · `♥ Ad` · `▤ Ad Center` · countdown chips; right "Enter to send · ⇧⏎ newline" + byte counter (mono, tabular-nums, counts translated wire bytes).
- **Behavior:** typing updates the preview live; toggle shows/hides the preview panel; Enter sends (schedules while the timer is armed), Shift+Enter breaks the line.

### 9. MemberList
Right column on `side2`, `border-left`, starting under the conversation toolbar (component 5) that spans it.
- **No header of its own:** the toolbar above carries the count on its member-list chip, so the filter is the column's first row. (Same for the docked profile panel — it opens on its hero. The narrow DM *drawer* is a fixed overlay above the toolbar, so it keeps its own "Profile »" head and its way out.)
- **Grouped** by presence/role: **Owner · Admins · Online · Idle · Offline**. Group head 10px/700 uppercase `meta`.
- **MemberRow:** padding `4px 8px`, `radius`. 30px avatar (real F-List image, initial fallback) with presence dot (8px, `2px solid side2` ring); to its right a body column, vertically centred against the avatar: nick line (role glyph + nick 13px, weight per role, gender colour, ellipsis) and, when present, an italic status line beneath (`meta`, 11px, BBCode stripped to text, clamped to two lines with ellipsis). A status-less row centres the name against the avatar. Offline rows read as secondary: name on `dim` full opacity, avatar `.55`, dot `faint` — no blanket row opacity.
- **Behavior:** left-click = open profile (server website, new tab); right-click = MemberContextMenu.
- **Data:** `{ nick, role, presence, status? }` grouped.

### 10. MemberContextMenu
Right-click popover on a member. `side` fill, `border`, `radius+2`, popover shadow, 5px padding, ~204px wide.
- **Header:** avatar + nick + role tag (mono 10px `faint`), bottom border.
- **Items** (7px 10px, `radius`, hover `hover`):
  - Message
  - **View profile ↗ website** — opens the user's profile on the server's website in a new tab (client does not render a profile popout; trailing "↗ website" hint in `accent`).
  - Add bookmark
  - Add friend
  - *(divider)* — **Ignore** (`danger`)
  - *(divider)* — admin-only: **Give voice**, **Kick** (each dim, with a mono `admin` tag right-aligned). Only render for admin/owner viewers.
- **Data/logic:** menu items gated by viewer role and target relationship (already-friend hides "Add friend", etc.).

### 11. ChannelBrowser (dialog)
620×588 modal, `side`, `radius+5`, modal shadow.
- **Header:** "Browse channels" (17px/700) + mono sub ("emberchat · irc.emberchat.chat · 142 rooms", room count in `ok`); close `✕`.
- **Search** row (38px, `bg`, `border`): "Find by name or topic…" (#492 — every search field in the app says *find*, never *filter*).
- **Tabs:** **Official** and **Open rooms**, each with a mono count pill. Active tab: `bg` fill + `border`; count pill in `accentSoft`/`accent`.
  - *Official* = curated server channels. *Open rooms* = user-created public rooms. (Server returns these as two query types.)
- **Row** (single line, `align-items:center`, `border-bottom` hairline): `#` · name (mono 14px/600) · type chip (`official` = `accent` on `accentSoft`; `open` = `dim` outline) · spacer · **member count** in a fixed **62px right-aligned column** (mono, `ok` dot + number) · **action button** fixed **86×30** so all right edges align.
  - Button states: **Join** (accent fill) · **✓ Joined** (`ok` outline, non-interactive) · **⚲ Pinned** (mono, `faint` outline).
  - Rows have **no description** — the server doesn't return one on query. Keep rows compact/single-line.
- **Footer** (on `side2`, top border): label "Not listed? Join a hidden channel by name" + an input (`#` prefix, `accentMed` border) + **Join** button; helper note that hidden/invite-only rooms won't appear above.

### 12. Preferences (window)
748×560, two-pane: rail + pane. `side`.
- **Rail** (204px, `side2`): title "Preferences", nav items (General · Appearance · Highlights · Away & logs · Notifications · Network). Active item = `accentSoft` + `inset 2px 0 0 accent`, glyph in `accent`. Foot note: "Account & profile live on the server website ↗" (there are **no** account/profile settings in-app — read-only from server site).
- **Pane:** head (16px/700 + bottom border), scroll body.
- Panes to implement:
  - **Appearance:** **Accent color** swatch row (the 5 accents; selected shows a `2px bg` + `2px color` ring — all variants stay available), base theme segmented, message density (Compact/Cozy), timestamp format (`[12:04]`/`[12:04:33]`/off), 24-hour toggle, group-consecutive toggle, **show join/part/quit** toggle, message font size (S/M/L; default **M**). Ramp (#188): body 13/14/15px with a proportional secondary ramp — timestamp/mono meta 11.5/12/13px, `<nick>` 12.5/13/14px. S preserves the pre-#188 density.
  - **Highlights:** highlight-on-nick toggle; a list of **rules** (word / nick / `/regex/`) each a mono chip with a type tag + remove `✕`; an add-rule input; "when highlighted" → play sound / flash tray / bump-to-top toggles; highlight tint swatch.
  - **Away & logs:** auto-away toggle, idle threshold segmented (5/10/20/30 min), away message input, clear-on-return toggle; **chat logs** → log-to-disk toggle, storage location (mono path), **export** (.txt/.html/.json segmented + Export button), retention (30d/90d/1yr/Forever).

**Preference control primitives** (reuse across panes):
- **Toggle:** 38×22 pill; on = `accent` track + `bg` knob at right; off = `mix(text,bg,.82)` track + `dim` knob at left.
- **Segmented:** inline-flex on `bg`+`border`, 3px pad; selected segment = `accent` fill, `bg` text; others `dim`.
- **Field row:** label (13.5px/600) + optional help (11.5px `meta`) on the left, control on the right, `border-bottom` hairline.
- **GroupLabel:** 10.5px/700 uppercase `meta`.
- **Text input:** 34px, `bg`, `border`, `radius`.
- **Swatch:** 26px circle; selected = double ring.

### 13. Auth — AppAccount (create / login)
Centered 400px card on a darkened (`mix(bg,#000,.35)`) backdrop. Card: `side`, `border`, 14px radius.
- **Wordmark** (`components/common/Wordmark.tsx`), title (22px/800), sub. The mark is the ServerHead's — the config'd product name at 14px/700 — and there is exactly one of it in the app (#537). The purple initial chip beside a lowercased mono "emberchat" was the prototype's placeholder: two derivations of a name a self-hoster is free to change, and a second wordmark for a product that has one. The running version does **not** come along; it is read from the authenticated `/api/meta`, which a login screen has no session to ask with.
- **Fields** (44px, `bg`, `border`, focus = `accent` border + `0 0 0 3px accentSoft` ring): 
  - **Create:** Username (with "available ✓" in `ok`), Email, Password (dot mask + blinking accent caret + "show", plus a 4-segment strength meter), terms checkbox, **Create account** (full-width accent). *No display name, no home server — this is only the app login.*
  - **Login:** Username or email, Password (+ "Forgot?" link `accent`), "Keep me signed in" checkbox, **Log in**, then a note "Next: choose which server identity to connect with."
- **Checkbox:** 18px `accent` square with `bg` `✓`. **Inline links:** `accent`, 600. **Primary button:** 44px, `accent` fill, `bg` text, 700.

**On `phone` the card is the screen (#535).** These two screens sat outside AppShell and predate the tiers, so the MP rounds swept the shell around them and left a 400px card floating on a darkened page at 390px wide. On the tier the backdrop stops darkening anything and stretches, and the panel goes full width and full height with no border and no radius, keeping the card's own `side` fill — every control inside it is designed as a `bg` control on a `side` surface, and flattening the two would cost each one its edge. It is also what the shell already does here: its list pane is the sidebar, edge to edge, in this colour, with base.css's safe-area strips showing `bg` through. Padding is `24px 16px`, and the bottom one carries `--eb-keyboard-inset`: this panel is a form the *document* scrolls, not a shell anchored to the viewport's bottom edge, so what a soft keyboard costs it is somewhere for the last control to scroll to, not height.

### 14. Auth — IdentityPicker (connect a server identity — the second login)
Same card style, 440px. This is where you pick which server identity to connect as (F-List "character select").
- **Account bar** (top, bottom border): app-account avatar + username + "…@… · app account" + "Sign out".
- Title "Choose an identity" + sub: identities live on the server, managed on the **website ↗** (inline link).
- **IdentityRow** (per identity): 38px avatar (per-identity color), name (14.5px/700) + optional `default` tag (`accent` on `accentSoft`), mono meta line (`server · role · presence`), then the action group.
  - **Connected:** "● Connected" (`ok` outline, nowrap). **Available:** "Connect" (accent fill). Connected row also gets `accentSoft` bg + `accentMed` border.
- **Add row:** dashed, `+` chip + "Add a server identity".

**The action group is ordered by consequence (#536).** The way in leads — **Open** / **Connect**, the accent-filled primary — and the two ways to lose something follow it at the trailing edge: **Disconnect**, then the remove ✕. Disconnect keeps the quiet outline (it is not the row's headline action) but wears `danger`, so the row reads as one way in and one way out rather than two buttons of equal weight. That order is the DOM order at every tier, so it is also the tab order and no tier reorders with CSS.

**On `phone` the group takes its own line**, with the primary spending all the slack and a 16px gap between every pair (§Touch conventions' adjacency rule) — three controls, an avatar and a name do not cross 390px without the name being squeezed to nothing and the buttons ending up shoulder to shoulder, which is the mis-tap being designed out. **Disconnect also arms rather than acts on this tier**, in RemoveButton's two-step shape ("Disconnect?"), because the two mistakes cost wildly different things: tapping Open when you meant Disconnect costs a Back press, while tapping Disconnect when you meant Open drops the held session — the feature this client exists for — and getting it back costs a reconnect and a fresh ticket. Tier-keyed like MenuSurface's sheet, not pointer-keyed: a 390px desktop window is somewhere a mis-click is cheap to make too.

### 15. Landing page
1120px browser-framed marketing page on `bg`.
- **Nav:** brand lockup · text links (Channels/About/Status, `dim`) · "Log in" (ghost) + "Create account" (accent 36px button).
- **Hero** (2-col grid): left = eyebrow (mono `.14em` `accent`), h1 (46px/800, `#f4ecde`), lede (16px `dim`), CTAs (accent "Create account" + ghost "Log in ↗"), mono trust line. Right = a scaled-down live preview of the client (`transform: scale(.4)` inside a cropped, bordered frame).
- **Feature cards** (3-col): 34px `accentSoft` glyph tile (`accent`), title (15px/700), body (13px `dim`). Content = the three pillars: *Pin & auto-rejoin*, *Friends & bookmarks*, *Highlights & away*.

### 16. BrowserFrame (presentational only)
The traffic-lights + URL bar chrome around mocks is **presentation for the reference files only**. Don't build it into the real app.

---

## State model (per connected identity)
Each identity keeps an independent session object; switching the rail swaps the *active* one:
```
identity = {
  id, name, initial, color, presence,          // rail + self
  channels: [{ name, topic, descShort, descFull, pinned, muted, unread, mention }],
  dms:      [{ nick, presence, pinned, unread }],
  friends:  [{ nick, presence }],               // tier 1
  bookmarks:[{ nick, presence }],               // tier 2
  activeChannel,                                // drives ChannelHeader + MessageLog + MemberList
  members:  [{ nick, role, presence, status }],
  log:      [ ...rows ],
  ignored:  [nick]                              // hides their messages
}
```
- **Pin** = persisted membership; on connect, auto-rejoin pinned channels / reopen pinned DMs.
- **Friend vs Bookmark** = two independent lists; a person can be neither, one, or both.
- **Highlight rules** are per app-account (global), applied to every identity's log.
- **Ignore** is per identity.

## Interactions summary
- Rail click → switch identity (whole context swaps). Rail right-click → status/disconnect/reorder.
- NavItem click → open channel/DM. Right-click → pin/unpin, mute, leave, move to Friends/Bookmarks.
- Description **Show more/less** → expand inline.
- Member left-click → profile on website (new tab). Right-click → MemberContextMenu.
- Composer: type → live MD preview; Enter send / Shift+Enter newline; Markdown toggle.
- Channel browser: tab switch, Join, and join-hidden-by-name.
- Preferences: accent swatch changes theme live; toggles/segments persist to app-account settings.

## Animation
Keep it restrained: 0.15s ease on identity avatar radius (circle↔square) and toggles; blinking caret 1.1s step-end in inputs. No page transitions.
