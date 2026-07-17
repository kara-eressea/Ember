# Milestone 9 — Client polish

*Split out of M8 on 2026-07-16: when M8 was committed to the
profile/compatibility/eicon feature set, the client-polish pool that had been
riding along moved here unchanged.*

**Goal:** the day-to-day ergonomics round — search, composer affordances, a
light theme, and the accumulated small stuff.

**Depends on:** M8. **Not yet specced** — the list below is the carried-over
candidate pool, to be scoped when M9 becomes active.

## Committed scope (decided 2026-07-17, spec at kickoff)

- **Opt-in at-rest credential storage + boot-time session resume**
  (decisions.md §15, amending §3): per-F-List-account "remember on this
  server" opt-in (default off) storing the password encrypted with an
  env-file key; on server start, sessions that were connected at shutdown
  and are within the `DETACHED_DISCONNECT_HOURS` window reconnect
  unattended (ticket discipline + backoff as usual — one TicketManager,
  ≥10s reconnect backoff, 1 req/s). Custody question resolved
  disclosure-only; docs must state plainly that the env key protects
  dumps/backups, not a full-box compromise (the desktop-client guarantee).
  Decide at build time whether the credentials table rides the automatic
  pg dumps, and document either way.

## Candidate scope (unspecced)

- **In-log search** (the pool's headline — confirmed wanted 2026-07-16,
  Discord-shaped) — server-side search over the `messages` table (per
  identity), surfaced as a search box scoped to the current channel/DM with
  a results panel. Scope when speccing: query semantics (Postgres full-text
  vs. `ILIKE` — at personal-instance scale start simple), Discord-style
  filters (`from:`, before/after dates, current conversation vs. all), and
  the fiddly part — **jump-to-context**: landing the virtualized log on an
  arbitrary old message and backfilling around it.
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
- **Activity heatmap on Insights** (user idea 2026-07-16, explicitly "a
  much later thing") — on the profile viewer's Insights tab (M8), a
  "when is this character usually active" heatmap: hour-of-day and
  day-of-week grids aggregated from the message timestamps the bouncer
  has observed for them. Great for scheduling RP. Honest-data caveat
  (same stance as M8's insights/decisions.md §11): it reflects only
  activity we've *seen* — shared channels and DMs — not global presence;
  no NLN/FLN presence-history tracking. Rides entirely on the M8
  insights route; zero F-List traffic.
- **Graduated audit LOWs** — promote deserving items from the M2–M8 audit
  backlogs in `milestones.md` § Standing to-dos.

## Explicitly elsewhere

- Profile viewer, compatibility, eicon search, link hover-previews → **M8**.
- Ad tooling + character search → **M10**.
- Desktop client → **MX** (`standalone-client.md`).
