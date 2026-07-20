# Design brief: Ad center + character search (M10)

*A brief **to** the design agent — the M10 counterpart of
`profile-viewer-brief.md`, produced 2026-07-18 after the M10 scope and
investigation steps. Deliverables come back in the established format:
`.dc.html` prototypes plus `COMPONENTS.md`-style specs (anatomy, exact
tokens, states, `Data:` shape per component).*

## Context (one paragraph)

EmberChat is a browser-based, IRC-native client for F-Chat (F-List.net's
roleplay chat). This round adds **roleplay-ad tooling** and **in-app
character search**. Roleplay ads are a first-class F-Chat message type
(LRP): periodic "looking for scene partners" posts allowed only in
channels whose mode permits them, paced by the server at one ad per
channel per ~10 minutes. Users author a small per-character library of
ads, then manually post selected ads to selected channels. There is **no
auto-posting in this milestone** — every post is an explicit user action.
Search (FKS) finds online characters by kink ids + enum filters and
returns bare names.

## Binding constraints (non-negotiable)

- **`design-system/COMPONENTS.md` is the design system.** Slate Cozy /
  Dusk Purple: fixed neutrals, swappable accent (all five accents must
  survive), colors via the documented `mix()` derivations — never
  hard-coded hex. IBM Plex Sans UI / IBM Plex Mono for timestamps, nicks,
  counts. Existing radii, shadows, type scale.
- **Existing precedents to match:** the Preferences window (748×560 modal,
  left rail + pane) and Channel Browser dialog are the modal language; the
  member context menu / eicon picker are the popover language; the
  composer input bar with its `Ⓜ`/`Aa`/`☺`/`?` control cluster already
  exists, as does an **Ad toggle** on the composer (M6) and distinct ad
  rendering in the log.
- **Reuse the M8 primitives:** the five-tier **MatchTier** chip
  (colorblind-legible pie-fill fraction — see
  `references/COMPONENTS-profile-viewer.md`) and the **mini profile card**
  are already designed and shipped; M10 *places* them, it does not
  redesign them.
- **Density:** IRC-style — compact, information-dense, calm.

## Screens to design

### 1. Ad Center (highest priority)

A per-character ad library, opened from a new **composer-toolbar button**
(design the button; it joins the existing input-bar cluster). Modal in the
Preferences-window language.

**Library view:** list of the identity's ads, order = display order.
Per row: content preview (first line, ellipsized), tag chips, a
**disabled** toggle (a disabled ad is skipped by the post flow but kept),
reorder affordance, delete. Add-new. Cap: 50 ads. Empty state ("Write an
ad once, post it anywhere").

**Editor:** Markdown textarea (the composer's Markdown dialect) with:

- **Live preview** through the existing render pipeline (same as the
  composer's preview panel).
- **Length counter** against the server ad limit (`lfrp_max`, default
  50 000 bytes — runtime value). Hard cap at the limit; the counter turns
  **amber then red** as it approaches (design the thresholds and the
  at-cap state — typing past the cap is impossible).
- **Lossiness warnings:** the translator reports Markdown that will reach
  the wire as literal text (headings/lists/quotes/fences, `_underscore_`
  emphasis, unterminated `**`, unsupported BBCode like `[center]`, bad
  params). Advisory only — **never blocks saving or posting**. Design the
  surface: per-diagnostic message + snippet, presumably a compact warning
  strip/list between editor and preview. Data:
  `[{ kind, at, snippet }]` with ~6 kinds; copy per kind is ours to write
  but design for 1–4 concurrent warnings and an overflow ("+3 more").
- **Tag input:** free-form chips (max 10 per ad, 30 chars). Tags are
  purely local organization — the post flow selects ads by tag. An ad
  saved with no tags gets `default`.
- Disable checkbox; save/cancel. Multi-device note: the library can be
  edited elsewhere concurrently — a save can come back with "Ads changed
  on another device" (409); design that conflict notice (re-load and
  review, no merge UI).

```
Ad { id, content /* Markdown */, tags: string[], disabled: boolean }
```

### 2. Post flow ("Post ads")

From the Ad Center (and/or a channel-header affordance — your call): pick
**tags** → pick **channels** → post now. Manual, immediate, no scheduling.

- **Tag picker:** chips for every tag on enabled ads, each showing how
  many ads it selects; selecting several tags unions the matching ads. A
  small preview of which ads will go ("3 ads selected").
- **Channel picker:** joined channels whose mode allows ads (`ads`/`both`)
  with select-all. Per channel row: title, mode badge, and two etiquette
  surfaces:
  - a parsed **`[ads: N min]` cadence hint** when the channel's
    description declares one (community convention — display it so the
    user can honor it; we don't enforce in M10);
  - **"next allowed in Xm"** when the channel is still inside the
    server's ~10-min ad window from a previous post (posting there is
    blocked until it clears — the row should communicate why).
- **Result feedback:** posting to N channels yields per-channel outcomes
  (sent ✓ / refused with the server's reason in our friendly-error copy).
  Design the summary state, including partial failure.
- Empty/edge states: no eligible channels, no enabled ads match the
  selected tags, everything-on-cooldown.

### 3. Channel view selector (Chat / Ads / Both)

Channels whose server mode is `both` get a per-channel **view filter** in
the channel header (F-Chat Rising precedent: a small "Show" selector).
`Chat` hides ad rows, `Ads` hides chat rows, `Both` shows everything —
filtered rows still exist in history, and ads never affect unread counts.
Design: the header control (segmented or menu — match the header chip
language; visible only when the channel mode is `both`), and its
interaction with the composer's existing Ad toggle (in `Ads` view the
composer naturally composes ads; chat and ad **drafts are kept
separate**). Persisted per channel.

### 4. Match chips on ad rows

Ad rows in the log gain a **MatchTier chip** (the M8 primitive) — but
*only when the poster's profile is already in the local cache*; there is
no fetch-on-render, so most rows have **no chip at all**. Design the
chip's placement on the existing ad row treatment such that its absence
is the normal look and its presence is a quiet bonus, not a hole when
missing. Clicking the poster's name opens the existing mini card.

### 5. Character search (FKS) — may be a second pass

A search surface alongside the Channel Browser (same dialog language).

- **Filters:** kinks (required by the wire, multi-select over F-List's
  ~300-entry kink vocabulary — needs search-within-the-picker), plus
  optional multi-selects: genders (8), orientations (9), languages (14),
  furry preference (5), roles (6). Dense but scannable; a cleared/default
  state that makes "pick at least one kink" obvious.
- **Search action:** the server enforces a 5 s pace between searches —
  design the button's cooldown state. Server refusals to surface: **no
  results**, **too many results — narrow your search**.
- **Results:** rows in the Channel Browser's list language: avatar,
  name (gender-accented per the client's nick convention), cached-only
  MatchTier chip (same rule as #4 — absence is normal). Click opens the
  mini profile card. A **free-text filter box** narrows the returned
  names client-side (the wire has no text search).
- **Saved searches:** save the current filter set under a name; a saved
  list (entry point: your call — tab or rail within the dialog) where
  rerunning shows a **"N new"** badge for characters that weren't in the
  last run's results. Design the save affordance, the list, and the badge.

```
SearchFilters { kinks: KinkId[], genders?, orientations?, languages?,
  furryprefs?, roles? }
SavedSearch { id, name, filters, lastRunAt?, newCount? }
Result rows: string[] of character names (+ avatar by name; match data
  only from cache)
```

## Out of scope for this brief

Auto-posting/rotation UI (deferred milestone — but the post flow should
not paint itself into a corner: a future "rotate" affordance will slot
beside "post now"), ad filtering rules, any changes to the main chat
shell beyond the two header/composer affordances above.
