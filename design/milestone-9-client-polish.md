# Milestone 9 — Client polish

*Split out of M8 on 2026-07-16: when M8 was committed to the
profile/compatibility/eicon feature set, the client-polish pool that had been
riding along moved here unchanged.*

**Goal:** the day-to-day ergonomics round — search, composer affordances, a
light theme, and the accumulated small stuff.

**Depends on:** M8. **Not yet specced** — the list below is the carried-over
candidate pool, to be scoped when M9 becomes active.

## Candidate scope (unspecced)

- **In-log search** — server-side search over the `messages` table (per
  identity), surfaced in the client; scope the query semantics (plain text
  vs. per-conversation vs. global) when speccing.
- **Composer affordances** — BBCode/Markdown formatting toolbar, a `/help`
  slash-command reference, warn-code support.
- **Light theme** — the full token-set design pass deferred from M5
  (decisions.md §10 committed to dark variants only at the time).
- **Quick-switcher** — a Ctrl/Cmd+K palette to jump to any channel, DM, or
  identity by typing; pairs naturally with the in-log search work.
- **Status-message history** — recent status messages offered for one-click
  reuse when setting status (Rising had this); a small pref-backed recents
  list, same convention as eicon recents.
- **Colorblind mode** — a token-level pass (alternative ok/warn/danger hues
  + shape/glyph reinforcement), sibling of the light-theme token work; the
  M8 match chips are already specced glyph-coded, this extends the idea
  app-wide.
- **Graduated audit LOWs** — promote deserving items from the M2–M8 audit
  backlogs in `milestones.md` § Standing to-dos.

## Explicitly elsewhere

- Profile viewer, compatibility, eicon search, link hover-previews → **M8**.
- Ad tooling + character search → **M10**.
- Desktop client → **MX** (`standalone-client.md`).
