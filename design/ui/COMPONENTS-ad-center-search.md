# EmberChat — Ad center + character search (M10) component specs

Build reference for the roleplay-ad tooling and in-app character search. Companion
prototypes:

- `Ad Center.dc.html` — library + editor + composer entry (frames `AC·A`–`AC·F`)
- `Post Ads Flow.dc.html` — the manual post flow (`PA·A`–`PA·C`)
- `Ad Rows & Channel View.dc.html` — in-log ad rows + the Chat/Ads/Both selector (`AV·A`–`AV·C`)
- `Character Search.dc.html` — the FKS search dialog (`CS·A`–`CS·D`)

Every value styles against the design-system tokens in `COMPONENTS.md` — **never
hard-coded hex outside the token table** — so the accent stays swappable (Amber /
Clay Red / Dusk Purple / Burnt Orange / Moss Green). Derived colors use the
documented `mix(a, b, t)` linear RGB lerp. IBM Plex Sans UI, IBM Plex Mono for
timestamps, nicks, counts, byte figures. Radii, shadows and modal language match
the Preferences window (§12) and Channel Browser dialog (§11).

**Reused verbatim, not redesigned:** the five-tier **MatchTier** primitive
(`references/COMPONENTS-profile-viewer.md` §0 — `pie` / `matchPill` / `dimChip`)
and the **mini profile card** (opened from any nick per §13 popover anchoring).
M10 only *places* them.

---

## 1. AdComposerButton  (`AC·F`)

New button in the composer input-bar control cluster (design-system §8), after
`Ⓜ` / `☺`, past a 1px `border` divider.

- **Anatomy:** `inline-flex`, height 28, pad `0 8`, radius 7, `gap 5`. Glyph `▤`
  (13px) + mono 11px "Ad" label.
- **States:** idle = `faint`, transparent, no border (matches its siblings);
  **active/open** = `accent` text, `accentSoft` bg, `1px accentMed` border.
- **Behavior:** opens the Ad Center modal. It **never posts**. Distinct from the
  existing per-message **Ad toggle** (M6), which flags a single composed line as an
  LRP ad — that control is unchanged.

---

## 2. AdCenter (modal)  (`AC·A`)

Preferences-window language, master–detail: **880 × 588**, `side`, radius **14px**
(`radius + 5`), modal shadow `0 40px 100px -20px rgba(0,0,0,.7)`, `overflow:hidden`.
Flex row: **LibraryColumn** (fixed 278) + **EditorPane** (flex).

```
Data: {
  identity,                                  // "as Vesna Marlowe"
  ads: Ad[],                                 // display order = post order; cap 50
  selected                                   // index of the open ad
}
Ad { id, content /* Markdown */, tags: string[], disabled: boolean }
```

### 2a. LibraryColumn
`side2`, `border-right`, flex column.
- **Header** (pad `15px 16px 12px`, `border-bottom`): "Ad Center" (15/700) + mono
  cap `N / 50` right-aligned; mono `faint` identity sub-line.
- **AdRow** (pad `9px 10px`, margin `1px 6px`, radius 9): a drag grip `⁝` (mono
  `faint`, `cursor:grab`) · content **first line** (12.5px, ellipsised) with an
  `off` tag when disabled · tag chips (§2e) below · trailing delete `✕` (`danger`
  on hover). **Active** = `accentSoft` + `inset 2px 0 0 accent`. **Disabled ad** =
  whole row `opacity:.6`, label `faint`.
- **Footer:** dashed `+ New ad` button (`accentMed` border, `accent`).
- **Empty state** (`AC·B`): the pane shows a dashed `✎` tile + **"Write an ad once,
  post it anywhere"** + one primary CTA; the list column keeps its header (`0 / 50`)
  and the New-ad button.

### 2b. EditorPane
Flex column: **head** (title "Edit ad" + a right-aligned **Disabled** toggle with a
"kept, skipped when posting" sub-label; toggle = the 34×20 Preferences pill) ·
optional **ConflictBanner** (§2f) · **scroll body** · **footer** (dirty/"Saved"
state + Cancel / Save ad).

Body, top→bottom: **MarkdownField** → **LossinessStrip** (§2d, only when warnings
exist) → **Preview** → **TagInput** (§2e).

- **MarkdownField:** `bg` card, `border` (focus = `accentMed` border + `0 0 0 3px
  accentSoft`). Header strip on `side2`: `MARKDOWN` label + the **LengthCounter**
  (§2c). Body is mono 12.5px/1.55, `min-height 96`, blinking accent caret on focus.
- **Preview:** `side` card, header `PREVIEW · as posted` (mono 9.5/700 `faint`) with
  a right note "what the channel sees". Body renders through the message tokenizer
  (design-system §7). **Mandate:** unsupported *block* Markdown (headings, lists,
  quotes, fences) renders as **literal `dim` text**, so the preview is wire-truth
  and visually agrees with the lossiness warnings.

### 2c. LengthCounter  (`AC·C`)
**Counts the translated BBCode wire bytes, not the Markdown source** — the composer's
Markdown is translated to BBCode before it hits the wire and is usually *longer* than
what you typed, so the build must measure the translated output against the limit, not
the editor text. Bytes against the runtime `lfrp_max` (default **50 000**).
- 54×4 track (`bg`) + fill + mono `n,nnn / 50,000` count.
- **Thresholds:** normal `faint` / `accentMed` fill → **amber** (`warn`) at
  **≥ 90 %** → **red** (`danger`) at **≥ 98 %** → **at-limit** shows a mono
  `AT LIMIT` chip (`danger` on `mix(danger,bg,.85)`). At the cap the field stops
  accepting input — overflow is impossible, never truncated on save.

### 2d. LossinessStrip  (`AC·D`)
Advisory list between editor and preview. **Never blocks saving or posting.**
- Container `mix(warn, side, .9)` + `mix(warn, side, .62)` border, radius 9.
- **Header:** mono `N will post as plain text` (`warn`) + right note
  "advisory · won't block saving".
- **Diagnostic row:** `⚠` (`warn`) · **label** (12/600) + friendly **copy**
  (11.5px `dim`) + optional **snippet** (mono chip, `bg`, ellipsised) · trailing
  mono `@L{n}` line ref. Rows split by a faint `warn`-tint hairline.
- **Overflow:** a `+N more…` row (`warn`, 600). Design for **1–4 concurrent**
  warnings then overflow.

```
Data: warnings: [{ kind, at, snippet }]     // ~6 kinds
kind ∈ { blockMd, fence, underscore, unterminated, bbcode, badParam }
// copy per kind is ours (see warnKinds() in the prototype)
```

### 2e. TagInput  (`AC·A`)
Free-form chips, **max 10 per ad, 30 chars**. Chip = radius 5, `bg`, `border`,
`dim`; removable variant adds a trailing `✕`. Field = wrap flex on `bg`+`border`,
"add tag…" placeholder + blinking caret. Helper: an ad with no tags is filed under
mono `default`. Tags are **local organization only** — the post flow selects ads by
tag.

### 2f. ConflictBanner (409)  (`AC·E`)
A save can return **"Ads changed on another device."** Banner below the pane head:
`mix(danger, side, .86)`, `⟳` glyph, title + reload-and-review copy, a `danger`
**Reload** button. **No merge UI**; the unsaved draft stays visible below so nothing
is lost.

---

## 3. PostAdsFlow (dialog)  (`PA·A`)

Channel-Browser dialog language: **648 × 596**, `side`, radius 14, flex column
(head · scroll body · footer). Opened from the Ad Center (or a channel-header
affordance). Manual, immediate, **no scheduling**.

- **Header:** "Post ads" (17/700) + mono sub "as {identity} · N enabled ads ·
  filtered by {tag}" + close `✕`.
- **StepLabel:** a `18px accentSoft`/`accentMed` numbered dot + 13/600 title +
  `faint` hint. Used for **1 · Pick one ad** and **2 · Choose channels**.

### 3a. AdPicker
**One ad posts per action** — the server permits one LRP ad per channel per ~10-min
window, so a single post can never land multiple ads in a channel. Multi-ad
selection is deferred to the M11 rotation surface.
- **Tag filter:** pill chips, each `tag + count badge` (how many enabled ads it
  carries; an `all` chip clears the filter). Selected = `accent` fill, `bg` text,
  count badge inverts. Picking a tag **narrows** the ad list below — it does not
  select ads.
- **AdList (single-select):** radio-style rows on `bg`, one selectable. Each
  **AdRow**: a 16px radio (`accent` dot when on) · ad title (12.5px, ellipsised) +
  its tag chips (mono 10px, `bg`/`border`). Selected = `mix(accent,side,.9)` +
  `inset 2px 0 0 accent`. Empty-filter / no-match states as in the library.

### 3b. ChannelPicker
Select-all row (checkbox + "Select all eligible") then **ChannelRow**s. Only
channels whose server mode allows ads (`ads` / `both`).
- **Checkbox:** 18px, `accent` fill + `bg ✓` when on.
- **Row:** `#` · mono name · **ModeBadge** · **CadenceHint** · right-aligned member
  count (`ok` dot + mono). **Selected** = `mix(accent,side,.9)` + `inset 2px 0 0
  accent`.
- **ModeBadge:** mono 9px uppercase — `ads` = `accent` on `accentSoft`/`accentMed`;
  `both` = `dim` outline on `bg`.
- **CadenceHint:** parsed `[ads: N min]` from the channel description — mono `⧗ Nm`
  chip. Community convention, **displayed not enforced** in M10.
- **Cooldown row:** when the channel is still inside the server's ~10-min ad window,
  the row is `opacity:.62`, the checkbox becomes a `⧗` glyph, and a `warn` sub-line
  reads **"On the server ad window · next allowed in Xm."** Not selectable.
- **Footer:** "1 ad → N channels · posts immediately" + **Post now** (`accent`). A
  disabled **Rotate…** `soon` slot is reserved to the left: the tag-union selection
  explored in the prototype is exactly the M11 campaign-setup surface, so the
  thinking is kept — it just doesn't drive the manual flow (out of scope this
  milestone).

### 3c. Results  (`PA·B`)
Replaces the body. Head sub names the posted ad ("posted '{ad title}…' · HH:MM").
Summary banner ("Posted to N of M channels", `warn` on partial failure) + per-channel
**ResultRow**: a status disc (`✓` `ok` / `✕` `danger`) · `#` name · on failure, the
server's reason in **our friendly-error copy** (`danger`) · trailing mono "sent
HH:MM" (`ok`) or "not sent". Footer: **Retry N failed** + Done. Nothing retries
automatically.

### 3d. Edge states  (`PA·C`)
Dashed-tile cards: **no eligible channels** (→ Browse channels), **no ads match
those tags** (→ Open Ad Center), **everything on cooldown** (earliest window + "the
picker updates live").

```
Data: {
  tags:     [{ tag, count }],                // count = enabled ads carrying the tag
  ads:      [{ title, tags, sel }],          // single-select; exactly one sel:true
  channels: [{ name, mode:'ads'|'both', cadence?, members, cooldown?, sel }],
  results:  [{ name, ok, at?, reason? }]      // outcomes for the one posted ad
}
```

---

## 4. ChannelViewSelector (Chat / Ads / Both)  (`AV·A`, `AV·B`)

Per-channel view filter in the **ChannelHeader** (design-system §5), **visible only
when the channel's server mode is `both`**. F-Chat Rising precedent.

- **Anatomy:** mono `SHOW` label + a 3-segment control on `bg`+`border` (pad 2):
  `Chat` · `Ads` · `Both`. Selected segment = `accent` fill, `bg` text; others
  `dim`. A mono `both` mode chip sits beside the channel name.
- **Behavior:** `Chat` hides ad rows, `Ads` hides chat rows, `Both` shows
  everything. Filtered rows still exist in history; **ads never affect unread
  counts**. **Persisted per channel.**
- **Composer coupling:** in `Ads` view the composer switches to compose an ad (the
  input gains an `AD` chip + `accentMed` border); **chat and ad drafts are kept
  separate** per channel, so toggling the view never loses either draft.

---

## 5. AdLogRow (LRP)  (`AV·A`, `AV·C`)

Distinct in-log rendering for a roleplay ad, so it never reads as a normal chat
line.
- **Anatomy:** a bordered block — margin `4px 16px`, `mix(accent, side, .93)` fill,
  `border` + **3px `accentMed` left rail**, radius 9. Header line: mono `AD` tag
  (`accent` on `accentSoft`/`accentMed`) · gender-accented mono nick (clickable) ·
  mono `[time]` · **flex spacer** · optional **MatchTier chip**. Body renders the ad
  Markdown through the message tokenizer at 12.5px.
- **Cached-only MatchTier chip (mandate):** the short `matchPill` appears **only
  when the poster's profile is already in the local cache** — **no fetch-on-render**,
  so most rows carry **no chip**. It lives in the flex spacer, **not a reserved
  column**, so its absence leaves no hole: absence is the normal look, presence is a
  quiet bonus. Same rule governs search results (§6d).
- **Behavior:** clicking the nick opens the mini profile card (§13 anchoring). Ads
  never affect unread counts.

```
Data: AdRow { nick, genderColor?, time, body /* Markdown */, match?: Tier }
// match present ⇔ profile in local cache
```

---

## 6. CharacterSearch (dialog)  (`CS·A`–`CS·D`)

FKS kink search, alongside the Channel Browser in the same dialog language: **748 ×
596**, `side`, radius 14, flex row — **SavedRail** (196) + main column (head ·
filter/results body · **ActionBar**).

```
Data:
SearchFilters { kinks: KinkId[], genders?, orientations?, languages?, furryprefs?, roles? }
SavedSearch   { id, name, filters, lastRunAt?, newCount? }
Results       string[] of character names (+ avatar by name; match only from cache)
```

### 6a. Filters  (`CS·A`)
- **KinkField (required):** header carries a mono `required` tag + "N selected · the
  wire needs at least one". The field is a wrap of selected **kink chips**
  (`accent`/`accentSoft`) + an `+ Add kinks…` opener. **Empty & required** →
  `mix(danger,bg,.5)` border and Search disabled.
- **Optional FilterGroups:** a `92px / 1fr` grid per group — `faint` label + wrap of
  toggle **FilterChip**s (radius 20; on = `accent` fill / `bg` text, off = `bg` /
  `border` / `dim`). Groups: genders (8), orientation (9), role (6), languages (14),
  furry (5); long lists show a mono `+N more`.
- **Default/cleared state:** a dashed `accent`-tinted primer — **"Pick at least one
  kink to search"** — explains kinks are required and the rest are optional narrowing
  filters.

### 6b. KinkPicker  (`CS·B`)
Popover over the field for the ~300-entry vocabulary. `side`, radius 11, popover
shadow. **Search-within-the-picker** field (`accentMed` border) + mono `~300 kinks`
· scrollable checkbox rows (16px `accent` check; selected row `accentSoft`) · footer
"N selected · Done". Selected kinks flow back as chips in the field.

### 6c. ActionBar  (`CS·C`)
Footer on `side2`: a left status line + the **Search** button.
- **disabled** (no kinks): button dimmed, status "Pick at least one kink to search".
- **ready:** `accent` Search, status "Kinks + optional filters · online characters
  only".
- **cooldown:** the server paces searches **one per 5 s** — button becomes a
  non-interactive **"Wait Ns…"** with a small accent spinner ring; status "Server
  paces searches — one every 5 seconds".

### 6d. Results  (`CS·C`)
Channel-Browser row language. A sticky bar: a **free-text FilterBox** ("Filter these
names…", narrows the returned names **client-side** — the wire has no text search) +
mono result count. **ResultRow:** 30px avatar (radius 7) · **gender-accented** name
(per the nick convention) · **cached-only MatchTier chip** (same rule as §5) ·
`ok` online dot with glow. Click opens the mini profile card.

### 6e. SavedRail + SavedSearch  (`CS·A`, `CS·D`)
Left rail, `side2`, `border-right`. `SAVED SEARCHES` label · **SavedRow** (name +
mono "N kinks · M filters"; active = `accentSoft` + `inset 2px 0 0 accent`) · a
dashed `☆ Save current` footer. **"N new" badge** (mono, `accent` fill, `bg` text)
on a saved row when a rerun returns characters that weren't in the last run's
results — computed from `newCount` against `lastRunAt`.

### 6f. Server refusals  (`CS·D`)
Centered dashed-tile empty states in the results area:
- **No results** (`∅`): "No online characters matched this search" — loosen the
  optional filters or drop a kink, then search again.
- **Too many results** (`⊞`): "The server capped this search" — add a kink or a
  filter to narrow below the limit, then search again.

---

## Reuse notes
- MatchTier (`pie` / `matchPill`) and the mini profile card are shared verbatim with
  M8 — one source of truth; M10 places them on ad rows (§5) and search results (§6d)
  under the same **cached-only, absence-is-normal** rule.
- **`matchPill` gains an official compact size variant** for IRC-density surfaces
  (ad rows §5, search results §6d): pad `2.5px 9px 2.5px 7px`, 10.5px/600, gap 5,
  `pie(10)` — versus the M8 default (pad `4px 11px 4px 9px`, 11.5px/600, gap 6,
  `pie(11)`). Same primitive, two documented sizes — not a fork; tokens, tier colors
  and the pie geometry are identical.
- All neutrals fixed; only `accent` + gender/per-nick colors change per accent
  option. The five accents survive across every surface here.
- No auto-posting in M10: every post is an explicit user action. The post flow
  reserves a **Rotate…** slot so the deferred rotation UI slots in beside **Post
  now** without a redesign.
