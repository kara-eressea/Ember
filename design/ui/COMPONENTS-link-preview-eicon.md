# EmberChat — Link preview + Eicon picker (M8, screens 4–5)

> Delivered by the Claude Design agent 2026-07-17 (second pass), commissioned by
> `profile-viewer-brief.md` §4–§5. Synced into the repo verbatim apart from this
> note and repo-relative paths: the prototype lives in
> `prototype/Link Preview & Eicon Picker.dc.html`, the design system is
> `COMPONENTS.md` in this directory, and the profile bundle referenced below is
> `COMPONENTS-profile-viewer.md`.

Build reference for the message-log **link preview** (brief §4) and the composer
**eicon picker** (§5). Companion to `COMPONENTS-profile-viewer.md`; same binding rules —
style against the design-system tokens in `COMPONENTS.md`, **never hard-code
hex outside the token table**, derived colors via the documented `mix(a, b, t)` lerp,
IBM Plex Sans UI / IBM Plex Mono for times/nicks/counts, radius 9 (modals 14).

§4 (the eicon right-click menu — favourites & blocking) is a later addition, built on the
member/channel context-menu grammar rather than on a design-agent frame.

Prototype: `Link Preview & Eicon Picker.dc.html` (frames `L·A`–`L·D`, `K·A`–`K·E`).
Reuses the message-log row, composer, and popover-anchoring rules already specced for the
client shell (`COMPONENTS.md` §6/§8) and the profile bundle (`COMPONENTS-profile-viewer.md` §13).

---

## 1. Link treatment in the message log  (`L·D`)

A URL in a message body renders as an inline **LinkChip** (extends the design-system
markdown link token, §7):

- `inline-flex`, gap 6, padding `1px 7px 1px 6px`, radius 6, `color: accent`.
- **Leading glyph** distinguishes behavior: **`▣` previewable** media link · **`↗` plain**
  link. Previewable is the extra affordance click-mode users need — a plain click
  *previews* rather than navigates, so the glyph signals it.
- **Label** = filename / link text (500). **Trailing `[host.com]`** in mono 11px `faint`.
- Resting: underline (`text-underline-offset:2px`, `mix(accent,bg,.5)` color). **Active**
  (its preview open): `accentSoft` bg + `accentMed` border, underline dropped.

`Data: link = { url, label, host, previewable, mediaType }`

---

## 2. LinkPreview panel  (`L·A` / `L·B` / `L·C`)

A large floating preview beside the log — **the message stays visible** (never a modal,
never inline in the log flow).

**Shell:** `side` surface, `border`, radius 9, shadow `0 18px 44px -12px rgba(0,0,0,.6)`.
Image area (centered, `head` letterbox behind) over a footer strip (`head`, top border):
`▣` + mono `host/path` (11px `dim`, ellipsis) + close `✕` IconBtn.

**Trigger** — a client preference:
- **Click (default):** a plain click on a previewable link opens the panel;
  **Ctrl/Cmd+click** always follows the URL instead.
- **Hover:** the panel follows the pointer while hovering the link.

**Positioning:**
- Floats in the **gutter to the right** of the log, vertically near the anchor row.
- **Flip** to the **left** of the anchor when the right gutter can't fit the panel (`L·B`).
- **Clamp** into the viewport with an **8px** margin on every edge.

**Max bounds:** width fixed to fit the gutter (~272–340px); **tall** images clamp to a max
height (~300px) and scroll/scale within; **wide** images clamp to max width and letterbox
the height; smaller images render natural size. Never exceeds ~340×300.

**States:**
- **Loading** (`L·C`) — a shimmer skeleton fills the *target aspect box* (`.lpskel`,
  ~1.15s), footer shows "fetching…".
- **Loaded** — the image, footer with real host/path.
- **Failure / not an image** — **nothing renders**. No broken-image chrome, no flashing,
  no empty frame. Absence is the design.

**Dismiss:** click mode → **Esc** or **click-away** (stays open until then); hover mode →
leaving the link. Only one preview open at a time.

```
Data: preview = {
  anchorRect, viewport, url, host, path,
  natural: { w, h }, state: 'loading'|'loaded'|'none',
  mode: 'click'|'hover', placement: 'right'|'left'   // resolved after flip
}
```

---

## 3. EiconPicker (popover)  (`K·A`–`K·E`)

Popover anchored **above the composer's `☺` button**, replacing the current minimal panel.
Follows the profile bundle's popover anchoring/clamping rules (`COMPONENTS-profile-viewer.md` §13):
`side` surface, `border`, radius 11, shadow `0 24px 60px -14px rgba(0,0,0,.7)`, a small
**caret** pointing down at the `☺` button; flips/clamps into the viewport. **336px** wide.

**Anatomy** top→bottom: `TabStrip` · (Search only) search field · body grid (scroll) ·
footer hint.

- **TabStrip** — **Favorites · Recents · Search**. Tab padding `9px 11px 8px`, 12px; active
  = 600 `text` + `inset 0 -2px 0 accent`; inactive 500 `dim`. A **disabled** tab (Search
  off) is `faint` with a trailing `⊘` marker.
- **EiconTile** — **60px** square (per the brief + chat eicon rule), radius 6,
  `mix(accent,bg,.86)` fill, `border`; the eicon image fills it (mono name fallback).
  Name shows **on hover** (title/tooltip). **Star affordance** top-right: `★` (`warn`)
  favorited / `☆` (`faint`) not — click to (un)favorite. **Click the tile = insert** the
  `[eicon]name[/eicon]` at the cursor. **Right-click = the eicon menu** (§4). A **blocked**
  eicon's tile shows its bare name instead of the image — still insertable, never rendered.
- **Grid** — `repeat(5, 60px)`, gap 6, vertical scroll (`.lpscroll`).
- **Footer** — mono 9.5px `faint` hint: "click to insert · ☆ to favorite".

**Search field** (Search tab, enabled): 30px, `bg`+`border`, `⌕` + "Search eicons…" +
mono `xariah.net` service tag. Results grid captioned "N results · hover for name".

**Search disabled** (`K·D`) — the whole body is an explainer: `⊘` tile, "Eicon search is
off", "Searching uses **xariah.net**, a third-party service.", and an **Enable in
Preferences →** link. Favorites & Recents tabs stay fully usable.

**Body states** (`K·E`):
- **No favorites** — `☆` tile, "No favorites yet", "Tap the star on any eicon to keep it here."
- **No recents** — `↺` tile, "Nothing used yet", "Eicons you insert will show up here."
- **No results** — `⌕` tile, "No eicons match '…'", "Try a shorter or different term."
- **Loading** — grid of shimmer tiles.
- **Search unavailable** (error) — `⚠` tile, "Search is unavailable", "xariah.net didn't
  respond. Favorites & recents still work.", **Retry**.

```
Data: picker = {
  tab: 'favorites'|'recents'|'search',
  favorites: [name], recents: [name],        // local, per app-account
  searchEnabled: bool, query, results: [name],
  searchState: 'idle'|'loading'|'ok'|'empty'|'error'
}
// insert → emits `[eicon]{name}[/eicon]` at the composer caret
```

---

## 4. Eicon menu (right-click) — favourites & blocking

Right-clicking an eicon **wherever it renders** — a message body, the composer preview, a
picker tile — opens a context menu on the eicon itself. The handler `preventDefault()`s and
`stopPropagation()`s so it wins over the surrounding surface's own menu (and the browser's)
**on the eicon element only**; every other part of that surface keeps the menu it had.

Same popover grammar as the member/channel menus (`COMPONENTS.md` §10): fixed panel over a
click-away overlay, placed at the pointer and re-clamped after measuring, Escape closes,
arrows walk the items. Head: `☺` glyph + the eicon's name. Items:

- **Favourite / Unfavourite** — writes `eiconFavorites`, the same list the picker's `☆`
  writes and its **Favorites** tab shows. That tab opens selected, so a favourite is one
  click away when composing. Capped at 100; at the cap the oldest entry drops.
- **Block / Unblock** — writes `eiconBlocked`. Capped at 200; at the cap the toggle
  **refuses** with a notice (dropping the oldest would put a suppressed image back on
  screen) — the mute-list pattern.
- **Copy name** — the eicon's name to the clipboard.

**Blocked rendering.** A blocked eicon never draws its image. It falls back to the M5
name-chip treatment (`.eiconChip`) with the label `faint` + `line-through`, `title`
"`{name}` — blocked eicon", and — unlike the `eiconDisplay: 'name'` chip — **no hover
preview**: a block that still previews on hover is not a block. Blocking **outranks** the
`eiconDisplay` pref in both directions. Right-clicking the chip still reaches the menu,
which is how it gets unblocked in place.

Names match **case-insensitively** everywhere (the server's eicon index keys on
`name.toLowerCase()`); the stored entry keeps the casing the user acted on, which is what
the review lists show.

**Management surface** — *Preferences → Appearance → Eicons*, below the display/animate/
search controls: two compact review lists (**Favourite eicons**, **Blocked eicons**) reusing
the muted-conversations chip list (`.ruleList`/`.ruleChip`/`.ruleRemove`), each with a
per-item `✕` and an empty-state line pointing back at the right-click affordance.

Both prefs fan out like every other (`prefs.set` → `prefs.updated` → every device), and the
log repaints live: `RichText` memoizes only the prefs-independent BBCode parse, while the
per-eicon component subscribes to prefs itself.

---

## Reuse notes
- **Popover anchoring/clamping** (anchor to trigger rect, flip when overflowing, 8px
  viewport clamp, single-open, Esc/click-away) is the **same primitive** as the mini
  profile card and is specced once in `COMPONENTS-profile-viewer.md` §13 — the eicon
  picker and link preview both consume it.
- The **message-log row, LinkChip, and composer** extend the design-system client shell
  (`COMPONENTS.md` §6/§7/§8) — no new message primitives introduced.
- Eicons render in **60px boxes** everywhere (picker, chat log, profile BBCode) — one size.
- All neutrals fixed; only `accent` changes per accent option. Verified across all five.
