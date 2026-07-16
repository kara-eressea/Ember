# EmberChat — Profile surfaces (M8) component specs

> Delivered by the Claude Design agent 2026-07-16 (project "EmberChat Design"),
> commissioned by `profile-viewer-brief.md`. Synced into the repo verbatim apart
> from this note and repo-relative paths: the prototypes live in
> `prototype/Full Profile Viewer.dc.html` / `prototype/Mini Profile Viewer.dc.html`,
> and the design system referenced below is `COMPONENTS.md` in this directory.

Build reference for the **Full Profile Viewer** + **Compare** view + the reusable
**MatchTier** primitive. Companion to `Mini Profile Viewer.dc.html` (mini card, same
milestone). Every value styles against the design-system tokens in
`COMPONENTS.md` — **never hard-coded hex outside the token table**, so
the accent stays swappable (Amber / Clay Red / Dusk Purple / Burnt Orange / Moss Green).
Derived colors use the documented `mix(a, b, t)` linear RGB lerp.

Prototype: `Full Profile Viewer.dc.html` (frames `P·A`–`P·L`).

---

## 0. MatchTier — the reusable five-tier primitive

> First-class, framework-agnostic. Shipped on the mini card; reused here on the compare
> table, kink rows, and (future) ad rows / search results. Spec it once, reuse everywhere.

**Tiers** (monotonic, worst→best is meaningful):

| Tier | `frac` | Label | Color |
|---|---|---|---|
| `match` | 1.0 | Match | `ok` `#8bb173` |
| `weakMatch` | 0.75 | Weak match | `mix(ok, warn, .55)` |
| `neutral` | 0.5 | Neutral | `mix(dim, faint, .4)` |
| `weakMismatch` | 0.25 | Weak mismatch | `warn` `#d0a24f` |
| `mismatch` | 0.0 | Mismatch | `danger` `#e08a6a` |

**Colorblind-legible without color (mandate).** The **pie glyph** encodes tier as a
fill fraction — full disc → empty ring — so alignment reads monotonically with hue
removed. Color is a *second, reinforcing* channel, never the only one. Draw the pie as
**SVG** (not a glyph font, not `background-clip`) so every fill level is metrically
identical and crisp at any size:

- circle radius `r = size/2`, stroke width `1.4`, ring drawn in tier color;
- `frac >= 1` → filled `<circle>`; `0 < frac < 1` → pie `<path>` starting at 12 o'clock
  (`-π/2`), sweeping clockwise, `large-arc = frac > .5 ? 1 : 0`; `frac == 0` → ring only.

**Forms:**
- **`matchPill(tier, {short})`** — `inline-flex`, gap 6, pad `4px 11px 4px 9px`, radius
  `20px`, 11.5px/600. `color: tier`, `background: mix(tier, bg, .83)`, `border: mix(tier,
  bg, .58)`. Pie(11) + label. `short` drops the " match"/" mismatch" suffix.
- **`dimChip(dimension, tier)`** — small chip, radius 5, pad `3px 8px`, 11px/500,
  `color: dim`, `background: mix(tier, side, .86)`, `border: mix(tier, side, .6)`.
  `dimension` label + pie(10) trailing.
- **Bare pie** — `pie(tier, size, color?)` for inline use (e.g. filter chips, headers).

`Data: Tier = 'match' | 'weakMatch' | 'neutral' | 'weakMismatch' | 'mismatch'`

---

## 1. ProfileViewer (modal)

Preferences-window language, larger: **900 × 640**, `side` fill, radius **14px**, modal
shadow `0 40px 100px -20px rgba(0,0,0,.7)`, `overflow:hidden`. Flex row: **HistoryRail**
(fixed) + main column (flex).

**Anatomy** — main column top→bottom: `ProfileHeader` · optional `StaleBanner` ·
`TabStrip` · content scroll region (`flex:1; overflow:auto`, `.pvscroll` thin bar).

**States:** loading (`P·H`), loaded, stale / budget-exhausted (`P·I`), profile-not-found
(`P·J`). Rail history is local, so it stays live in every state.

```
Data: {
  identity,                                   // viewer's active character (for compare)
  profile: { name, gender, avatarUrl, isFriend, isBookmarked, fetched:"12m ago",
             stale?: true, budgetExhausted?: true },
  note?: { body } | null,                     // private, per-viewing-identity
  activeTab: 'overview'|'details'|'kinks'|'compare'|'images'|'guestbook'
}
```

---

## 2. HistoryRail

Left column, **208px**, `side2`, `border-right`. The app's **only** view-history surface.
- **Header:** `GroupLabel` "Recently viewed" (10px/700 uppercase, `.1em`, `faint`),
  `border-bottom`.
- **HistRow** (pad `6px 8px`, radius 9): 28px avatar (radius 6) · name (12.5px, `dim`;
  active 600 `text`) + mono relative time (10px `faint`) · trailing remove `×` (mono,
  `faint`, opacity .5 → 1 on hover). **Active** row: `accentSoft` bg + `inset 2px 0 0
  accent`. Click loads that profile.
- **Empty state** (`P·K`): dashed 40px tile + "Profiles you view will appear here."

`Data: history: [{ name, initial, color, ago }]` (most-recent first, active = current).

---

## 3. ProfileHeader

Pad `16px 22px 0`, subtle gender-tinted gradient `linear-gradient(180deg, mix(genderAccent,
side, .9), side)`.

- **Avatar** 56px (radius 9), real F-List image; initial-on-color fallback.
- **Name** 20px/700 in the gender accent (per-nick / gender color within tokens) +
  badges: `★` friend (`warn`), `⚑` bookmark (`accent` if bookmarked, else `faint`) —
  reuse the mini card's 22px badge chip.
- **Meta row:** mono 11px `faint` "fetched 12m ago" + **refresh** IconBtn (`⟳`, 30px,
  `bg`+`border`). **Budget-exhausted:** refresh `disabled` (opacity .6, `faint`) with a
  hover **tooltip** (`head` bg, `border`, 6px radius) "Hourly profile budget exhausted —
  showing cached copy."
- **PrivateNote** affordance, right-aligned (§4).

---

## 4. PrivateNote  (`P·L`)

Per-character note visible only to the viewing identity. No modal-in-modal — inline,
autosave.

- **None:** dashed pill, `+ Add private note`, 11.5px/500 `faint`.
- **Peek (collapsed):** 232px card, `bg`+`border`, radius 9. Accent dot + "PRIVATE NOTE"
  eyebrow (`accent`) + `✎`, then a one-line ellipsised preview (`dim`). Click → editor.
- **Editor:** 240px, `bg`, `accentMed` border + `0 0 0 3px accentSoft` focus ring. Label
  + `Saved ✓` (`ok`), editable body with a blinking accent caret, footer "autosaves ·
  only you can see this" (mono 9.5px `faint`).

`Data: note?: { body } | null`

---

## 5. TabStrip

Row on `mix(side, bg, .35)`, `border-bottom`. Tab pad `11px 13px 10px`, 12.5px. Active =
600 `text` + `inset 0 -2px 0 accent`; inactive 500 `dim`. Order: **Overview · Details ·
Kinks · Compare · Insights · Images · Guestbook**.

---

## 6. Tab — Overview  (`P·A`)

- **MatchStrip** (only when own-profile data exists): `bg` card, `border`, radius 9.
  "COMPATIBILITY WITH {you}" label + `Full compare →` (accent) → overall `matchPill` +
  the notable `dimChip`s. Absent in the no-match-data case (mirrors mini card).
- **BBCodeBody** — first-party rendering (§10).

---

## 7. Tab — Details  (`P·B`)

Infotags in F-List groups, `column-count:2`, `column-gap:34px`, groups
`break-inside:avoid`. Group = `GroupLabel` + rows `grid 150px / 1fr`, pad `7px 0`, hairline
`mix(border, side, .45)`. Label 12px `faint`; value 12.5px/500 `text`. Groups: **General ·
Appearance · RP preferences** (extend as the API returns more).

`Data: infogroups: [{ group, rows: [[label, value]] }]`

---

## 7b. Tab — Insights  (`P·E²` / `P·E³`)

The viewer's **own** relationship stats with this character, computed from the client's
local stored history — **nothing is fetched from F-List**. Same label/value language as
Details (`column-count:2`, `column-gap:34px`, groups `break-inside:avoid`, rows
`grid 168px / 1fr`), but framed as *about you-and-them*: an accent eyebrow "● YOU × {them}"
(9.5px/700 uppercase, `accent` + 5px accent dot) with a mono `faint` sub-note "from your
local history, never fetched from F-List". Headline stats (messages exchanged, currently
online) take `accent`/600 on the value; the rest are normal `text`/500.

- **Groups:** *Conversation* (messages exchanged, first encountered, last chatted, last
  seen talking) · *Right now* (currently online + shared channels) · *This profile*
  (times you've viewed, first viewed, bookmarked, friend-since).
- **Empty state** (`P·E³`): dashed `⇄` tile + "You haven't crossed paths yet" +
  "Once you share a channel or exchange messages with {them}, your history together will
  show up here."

```
Data: insights?: {
  messagesExchanged, firstEncountered:{date,channel}, lastChatted, lastSeenTalking,
  online: bool, sharedChannels: [name], timesViewed, firstViewed, isBookmarked, friendSince
} | null    // null → empty state
```

---

## 8. Tab — Kinks  (`P·C`)

Four columns **Fave / Yes / Maybe / No** (`grid repeat(4, 1fr)`, gap 12, `align:start`).
Each column: `bg` card, `border`; header = 8px tier-ish color square + uppercase label +
mono count.

- **KinkRow** — tinted by the **viewer's own** choice for that kink (the "we both fave
  this" glance): `background: mix(choiceColor, bg, .9)` + `inset 2px 0 0 mix(choiceColor,
  bg, .5)`. Colorblind-safe secondary: a **ChoiceMark** glyph badge (15px, mono) — `♥`
  fave / `+` yes / `~` maybe / `×` no / `·` none — colored `mix(choiceColor, side, .82)`.
  Choice colors: fave `ok`, yes `mix(ok,warn,.5)`, maybe `warn`, no `danger`.
- **Custom kink** — `CUSTOM` tag (mono 8.5px, `accent` on `accentSoft`) + expand `+/−`.
  Expanded: description (11.5px `dim`) + **subkink** chips (`bg`+`border`, radius 4).
- Legend row above the grid maps glyph → choice.

`Data: kinks: [{ name, custom?, subkinks?, description?, yourChoice: Choice }]`,
`Choice = 'fave'|'yes'|'maybe'|'no'|'none'`

---

## 9. Tab — Compare  (§3, `P·D` / `P·E`)

Your active character vs. theirs. Header: overall `matchPill` + one-line summary.

### 9a. DimensionTable
`grid 118px / 1fr / 1fr / 132px`. Header row: Dimension · **{you}** (your identity color)
· **{them}** (their gender accent) · Match (right). Six rows — Orientation, Gender, Age,
Anthro/human, Species, Sub/Dom role — each `background: mix(tier, side, .94)`, hairline
between, both values (12.5px/500), trailing short `matchPill`. **Reason** string surfaces
on row hover (title / tooltip): e.g. "You prefer submissives; Vesna plays as a switch."

### 9b. KinkAlignmentList
Own scroll region (`.pvscroll`, `max-height ~196px` unfiltered). Header: "Kink alignment"
+ mono "sorted worst-first · N shown" + **Conflicts-only** filter chip (pill; active =
`danger` text, `mix(danger,bg,.85)` bg, pie glyph). Column captions You · Kink · Vesna.

- **CmpKinkRow** — `grid 104px / 1fr / 104px`, `background: mix(tier, bg, .9)` + `inset
  2px 0 0 mix(tier, bg, .45)`. Left = your choice (glyph + label), center = tier pie +
  kink name, right = their choice (mirrored). Sorted mismatch→match.
- **Filter active** (`P·E`): list = only `mismatch` + `weakMismatch` rows.

```
Data: MatchReport {
  overall: Tier,
  dimensions: { orientation|gender|age|furryPreference|species|subDomRole:
                { tier, yours, theirs, reason } },
  kinks: [{ name, yours: Choice, theirs: Choice, tier }]   // presort worst-first
}
```

---

## 10. BBCodeBody — first-party rendering (mandate)

Native EmberChat treatment, **not** an f-list.net reskin. Unknown/unsupported tags →
plain readable text (never raw `[tags]`).

| Tag | Treatment |
|---|---|
| `heading` | 15px/700 `text`, `margin:20px 0 9px`, leading 3px `accent` bar. |
| `quote` | `bg` block, 2px `accentMed` left border, radius `0 6px 6px 0`, italic 12.5px `dim`; optional mono "— attribution". |
| `collapse` | Accordion: `side2` header (`▶` accent chevron rotates, title, mono `collapse` tag), `border`, radius 9; body reveals below a hairline. Open + closed states. |
| `big` | Up-scaled heading (≈22px/700). |
| align tags | `text-align` on the block. |
| inline `[eicon]`/`[icon]` | fixed ~60px box (`mix(accent,bg,.8)` fill, `border`), matches chat log's eicon rule. |
| inline md (`**`, `*`, `` ` ``, links) | reuse the message tokenizer (design-system §7). |

---

## 11. Tab — Images  (`P·F`)

`grid repeat(4, 1fr)`, gap 12, square thumbs (radius 9, `border`, mono `n/8` caption).
Click → **Lightbox**: dimmed `rgba(10,9,8,.86)` overlay *within the modal* (not a new
window), centered enlarged image (max ~380px, `4/3`), mono `2/8` counter + `‹ › ✕`
IconBtns. Empty state = "No images" tab message. Dismiss: Escape / click-away / `✕`.

---

## 12. Tab — Guestbook  (`P·G`)

Comment list: `GbPost` = 32px avatar (radius 7) · name (13px/600, per-nick accent) + mono
date · BBCode body (12.5px/1.55). Hairline between. Inline compose box (`bg`+`border`) +
`Post` (accent). **Empty state:** dashed `"` tile + "No guestbook posts yet" + "Sign
guestbook". May become an API link-out — ships native regardless.

`Data: guestbook: [{ author:{name,initial,color,accent}, date, body }]`

---

## 13. Popover anchoring & clamping (mini card + any click-popover)

Governs the **Mini Profile card** (opened from any nick — message-log nick, member-list
row, `[user]` mention) and applies to future click-popovers (eicon picker). Popover shadow
`0 8px 24px -6px rgba(0,0,0,.7)`, radius 9, `side` surface, `border`.

- **Anchor** to the trigger's bounding rect, not the raw cursor point, so repeated opens
  are stable. Preferred placement **below-start**: top edge = `anchor.bottom + 6`, left
  edge = `anchor.left`.
- **Flip** when it would overflow: if `anchor.bottom + gap + popH > viewportH`, place
  **above** (`bottom = anchor.top - 6`); pick whichever side has more room if neither
  fully fits.
- **Clamp** along the cross axis into the viewport with an **8px margin**: `left =
  clamp(left, 8, viewportW - popW - 8)` (same for `top` when flipped). Never let the card
  leave the viewport; clamp rather than shrink.
- **Max size:** width fixed (~300px); height caps at `viewportH - 16`, then the card's
  body scrolls (`.pvscroll`) — the header/actions stay pinned.
- **Dismiss:** click-away, Escape, or opening another popover. Only one profile popover
  open at a time. Opening **Open profile** hands off to the full viewer modal (§1) and
  closes the popover.
- **Layering:** above the chat shell and member list, below the profile modal + its
  lightbox.

```
Data (placement, computed): {
  anchorRect: {top,left,bottom,right}, viewport: {w,h}, gap: 6, margin: 8,
  placement: 'below'|'above'   // resolved after flip
}
```

---

## Reuse notes
- MatchTier (§0), avatar, badge, and the no-match-data prompt are **shared verbatim**
  with `Mini Profile Viewer.dc.html` — one source of truth.
- The tier primitive will reappear on ad rows / search results (future milestone) — keep
  it decoupled from the profile viewer.
- All neutrals fixed; only `accent` + gender/per-nick colors change per accent option.
  Verified legible across all five accents and with color removed.
