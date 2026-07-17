# Handoff: EmberChat — Profile surfaces (M8)

> Delivered by the Claude Design agent 2026-07-16/17, commissioned by
> `profile-viewer-brief.md` — the cover note to engineering, counterpart of
> `README.md` (the M1-era client handoff). Synced into the repo with paths
> adjusted: prototypes live in `prototype/`, the design system is
> `COMPONENTS.md` in this directory, and the rendered screenshots stay in the
> design project (re-render the `.dc.html` files instead). The second pass
> (2026-07-17) completed the brief: **link preview** (§4) and **eicon picker**
> (§5) — see `COMPONENTS-link-preview-eicon.md`.

## Overview
This package covers the **profile surfaces** for EmberChat:

1. **Mini Profile Viewer** — a lightweight click popover card summarizing a character.
2. **Full Profile Viewer** — a Preferences-scale modal (900×640) with seven tabs, a
   recently-viewed history rail, private notes, and full loading / stale / not-found
   states.
3. **Compare view** — your active identity vs. another character: a dimension table +
   a kink-alignment list.
4. **MatchTier** — a reusable five-tier compatibility primitive (pie glyph + pill/chip
   forms) shared by all of the above and reused on future ad rows / search results.

## About the design files
The `.dc.html` files are **design references** — prototypes showing intended look and
behavior, **not production code to copy directly**. They are authored with a small
custom `<x-dc>` runtime (`prototype/support.js`) used by the design tool; **do not
reuse that runtime**. Recreate the designs in the existing React stack using its
established patterns; all data in the mocks is placeholder.

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii, and states are final and exact —
every value is taken from the design-system token table (`COMPONENTS.md` → *Design
Tokens*) or from the companion spec `COMPONENTS-profile-viewer.md`. Build against
**tokens** (never hard-coded hex) so the accent stays swappable. The only thing left
open is data binding and the profile-fetch layer.

## Interactions & behavior
- **Open profile:** click any nick → mini card; **Open profile** hands off to the full
  viewer modal, pushing the character onto the HistoryRail (most-recent first, deduped).
- **HistoryRail:** click a row to load that profile; `×` removes it from history.
  History is local to the app and stays live during loading / not-found states.
- **Tabs:** client-side switch, no refetch (the profile is fetched whole).
- **Refresh (`⟳`):** re-fetches. When the hourly profile budget is exhausted the button
  is disabled (opacity .6, `faint`) with a hover tooltip ("Hourly profile budget
  exhausted — refresh available in 48m").
- **Lightbox:** prev/next cycle; Escape / backdrop / `✕` closes back to the grid.
- **Private note:** click peek/none → inline editor; autosaves debounced; no save button.
- **Conflicts-only filter (Compare):** toggles the kink list between all rows and
  mis/weak-mismatch only.
- **Compare-row reason:** shown on hover (title/tooltip).
- **Popover placement:** see `COMPONENTS-profile-viewer.md` §13 (anchor to trigger rect,
  below-start preferred, flip + 8px viewport clamp, one popover at a time).

## States
- **Loading** — avatar + chrome paint instantly; header meta, infotags, and body shimmer
  in (~1.15s linear shimmer). HistoryRail is local, so it stays live.
- **Stale / budget-exhausted** — warn-tinted banner under the header
  (`background: mix(warn, side, .86)`, bottom border `mix(warn, side, .62)`, `⚠` +
  copy); refresh disabled; content is the last cached copy.
- **Profile not found** — dashed `?` tile, plain-language reason, `Retry` +
  `Open on website ↗`; HistoryRail untouched.
- **Empty states** — HistoryRail empty; Insights never-crossed-paths; Guestbook empty;
  no-match-data (MatchStrip omitted, mirrors the mini card); Images empty.

## State management (shape the prototypes assume)
```
viewer: {
  identity,                                    // viewer's active character (drives Compare)
  history: [{ name, initial, color, ago }],    // recently-viewed, most-recent first
  activeProfile: {
    name, gender, avatarUrl, isFriend, isBookmarked, fetched, stale?, budgetExhausted?,
    infogroups: [{ group, rows: [[label, value]] }],
    kinks: [{ name, custom?, subkinks?, description?, yourChoice }],   // 'fave'|'yes'|'maybe'|'no'|'none'
    insights?: {                                 // viewer's OWN local history w/ this char; null → empty state
      messagesExchanged, firstEncountered:{date,channel}, lastChatted, lastSeenTalking,
      online, sharedChannels:[name], timesViewed, firstViewed, isBookmarked, friendSince
    } | null,
    images: [url], guestbook: [{ author:{name,initial,color,accent}, date, body }],
    note?: { body } | null
  },
  match: { overall, dimensions, kinks },       // MatchReport — compute once per profile load
  activeTab, lightboxIndex?, conflictsOnly, loadState: 'loading'|'ok'|'stale'|'notfound'
}
```

## Assets
No raster assets. Avatars and profile images come from the F-List API at runtime
(initial-on-color fallback). Fonts: IBM Plex Sans + IBM Plex Mono. Icons are Unicode
glyphs (`★ ⚑ ⟳ ‹ › ✕ ♥ ✎ ⚠`).

## Files
| File | What it shows |
|---|---|
| `prototype/Full Profile Viewer.dc.html` | The full modal — 14 frames: all seven tabs (incl. Insights loaded + empty), Compare (with conflicts-only filter), lightbox, loading, stale/budget banner + disabled-refresh tooltip, not-found, empty history rail, and the private-note + reusable-chip detail specs. |
| `prototype/Mini Profile Viewer.dc.html` | The mini popover card + the MatchTier primitive spec frames (7 frames incl. skeleton, stale, no-match, not-found, colorblind proof). |
| `prototype/Link Preview & Eicon Picker.dc.html` | Second pass (2026-07-17), 9 frames: link preview loaded/flip-left/loading + LinkChip trigger-rule spec (`▣` previewable vs `↗` plain); eicon picker Favorites/Recents/Search tabs, search-disabled explainer, and the five body states (no favorites/recents/results, loading, search unavailable). |
| `design/ui/COMPONENTS-profile-viewer.md` | Component-by-component spec for the profile surfaces — primary build reference for steps 7–10. |
| `design/ui/COMPONENTS-link-preview-eicon.md` | Component spec for the link preview + eicon picker — primary build reference for steps 11–13. |
