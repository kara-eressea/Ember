# Design brief: Profile surfaces + eicon picker (M8)

*A brief **to** the design agent — the counterpart of `README.md` in this
directory, which was the design agent's handoff to engineering. Produced
2026-07-16 during M8 planning. Deliverables come back in the same format as
the existing bundle: `.dc.html` prototypes plus `COMPONENTS.md`-style specs
(anatomy, exact tokens, states, `Data:` shape per component).*

## What EmberChat is (one paragraph)

A browser-based, IRC-native chat client for F-Chat (F-List.net's roleplay
chat): channel-first, ultra-compact monospace message log, a far-left
identity rail for switching between a user's characters, DMs, and a
roles-based member list. Users are adults; profiles describe roleplay
characters — appearance, preferences ("kinks", rated Fave/Yes/Maybe/No),
and freeform BBCode descriptions that authors often decorate heavily.

## Binding constraints (non-negotiable)

- **`COMPONENTS.md` in this directory is the design system.** Slate Cozy /
  Dusk Purple theme: fixed neutrals, swappable accent (all five accents must
  survive), colors derived via the documented `mix()` lerp — **never
  hard-coded hex outside the token table**. IBM Plex Sans UI / IBM Plex Mono
  for timestamps, nicks, counts. Radius 9px, modals 14px, documented shadow
  tokens, existing type scale.
- **Existing precedents to match:** the Preferences window (748×560 modal,
  left rail + content pane) and Channel Browser dialog are the modal
  language; the member context menu is the popover language; avatars are
  real F-List images (square, initial-on-color fallback); eicons render in
  ~60px boxes.
- **Density:** this is an IRC-style client — compact, information-dense,
  calm. No card-happy whitespace-heavy layouts.

## Screens to design

### 1. Mini profile card (highest priority with #2)

Discord-style popover opened by clicking a character name anywhere (message
log nick, member list row, `[user]` mention). Anchored at the click point,
viewport-clamped.

Content: avatar (~64px), character name, gender-appropriate accent (F-List
convention colors gender names; we may restyle within tokens), **★ friend /
⚑ bookmark badges** (the sidebar already uses these glyph semantics), 3–4
key infotags (orientation · age · species · dom/sub role), a
**compatibility summary** — one overall match chip plus the two most
notable dimension chips (see the five-tier system below) — and two actions:
**Open profile** (primary) and **Message**.

Data shape:

```
{ name, avatarUrl, isFriend, isBookmarked, infotags: [{label, value}],
  match?: { overall: Tier, highlights: [{dimension, tier, reason}] },
  stale?: "cached 3h ago" }
```

States: skeleton (avatar + name paint instantly, rest fills in), loaded,
stale (subtle "cached Xh ago" line), no-match-data (chips absent — the user
has no own-profile loaded), profile-not-found.

### 2. Full profile viewer

Modal (Preferences-window scale or larger — profile descriptions are long;
consider ~900×640). Two zones:

- **Left rail: view history.** "Recently viewed" list — avatar thumb, name,
  relative last-viewed time, per-row remove (×) affordance. Clicking loads
  that profile. This rail is the *only* history surface in the app. Empty
  state needed ("Profiles you view will appear here").
- **Main pane:** header (avatar, name, friend/bookmark badges, "fetched
  12m ago" + refresh button — including a disabled-with-tooltip state for
  "hourly profile budget exhausted, showing cached copy") over a tab strip.
  The header also carries a **private note** affordance: a per-character
  note visible only to the viewing identity ("what we RP'd last time") —
  design both the collapsed state (note exists: a peek/indicator; no note:
  a quiet "add note") and the inline editor (autosave, no modal-in-modal).
  Tabs:
  1. **Overview** — the BBCode description (see rendering mandate below) +
     a compact match summary strip when own-profile data exists.
  2. **Details** — infotags in their F-List groups (General, Appearance,
     RP preferences…), label/value rows, dense.
  3. **Kinks** — four columns: Fave / Yes / Maybe / No. Custom kinks appear
     with hover/expandable descriptions and nested subkinks. Each kink row
     carries a subtle tint by the *viewer's own* choice for that same kink
     (the "we both fave this" glance) — design the tint against tokens,
     with a colorblind-safe secondary signal.
  4. **Compare** — see #3.
  5. **Images** — thumbnail grid → lightbox/enlarged view.
  6. **Guestbook** — comment list (author avatar/name/date/BBCode body).
     May ship as a link-out if the API disappoints; design it anyway.
- States: loading, stale/budget-exhausted banner, profile-not-found, tab
  empty states (no images, no guestbook posts).

### 3. Compare view (a tab of #2)

Side-by-side: **your active character vs. theirs**.

- **Dimension table** — six rows (Orientation, Gender, Age, Anthro/human
  preference, Species, Sub/Dom role): each shows both characters' values, a
  tier chip, and a short reason string ("You prefer dominants; they are a
  switch").
- **Kink alignment list** — two-column rows (your choice ←kink name→ their
  choice), sorted worst-conflicts-first, tier-tinted. Potentially long;
  needs its own scroll region and maybe a "conflicts only" filter chip.

**The five-tier chip system is a first-class design task:** match /
weak match / neutral / weak mismatch / mismatch. Rising used green→red +
icons (heart, thumbs-up, neutral face, question, broken heart). Design our
own within the token system (`ok`/`warn`/`danger` + derivations), working
in every accent, **and colorblind-legible without color** (icon or glyph per
tier, not color alone). It will later reappear on roleplay-ad rows and
search results, so spec it as a reusable primitive.

Data shape:

```
MatchReport { overall: Tier, dimensions: {orientation|gender|age|
  furryPreference|species|subDomRole: {tier, label, reason}},
  kinks: [{name, yours: Choice, theirs: Choice, tier}] }
```

### 4. Link preview

An image link in the message log pops a **large floating preview beside the
log** (reference: F-Chat Rising — preview appears at the side, message
stays visible; screenshots available on request). Trigger is a user
preference: **click (default)** — a plain click on a media link opens the
preview (Ctrl/Cmd+click follows the link); or hover. Design:

- The link treatment itself in messages: link icon + label + dimmed
  `[host.com]` suffix (already close to current styling — refine as
  needed). Consider whether a *previewable* link warrants a subtle extra
  affordance (e.g. a tiny image glyph) so click-mode users know a click
  previews rather than navigates.
- The preview panel: max bounds (tall images, wide images), positioning
  rules relative to the log/viewport, loading shimmer, dismissal
  (Escape/click-away — click mode keeps it open until dismissed, hover
  mode follows the pointer), no-preview = *nothing* (failures must not
  flash broken-image chrome).

### 5. Eicon picker (secondary — may be a second pass)

Popover anchored above the composer's ☺ button, replacing the current
minimal panel. Tabs: **Favorites / Recents / Search.** 60px eicon grid,
click-to-insert, star affordance to (un)favorite, name on hover. The Search
tab has a **disabled state**: one-line explainer ("Searching uses
xariah.net, a third-party service") + link to Preferences. Also: empty
states (no favorites yet, no recents, no results), loading, and a "search
unavailable" error state.

## Rendering mandate: first-party BBCode

Profile descriptions arrive as BBCode with a wider tag set than chat:
`collapse` (accordion sections), `heading`, `quote`, `big`, alignment tags,
inline images. **Design our own treatment for each** — collapses, headings,
quotes styled as EmberChat components against tokens — explicitly *not*
mimicking f-list.net's site look. The whole point of this feature (per the
user) is that the viewer feels native, not like an embedded webpage.
Unsupported/unknown tags degrade to plain readable text.

## Out of scope for this brief

Ad-posting surfaces, character search results, and match scores on ads
(future milestone — but remember the tier chip will be reused there). Any
changes to the main chat shell.
