# Milestone 8 — Nice-to-haves

*Reshaped 2026-07-16 with the user. History: originally "service admin
tooling + Electron" (managed-service era); rewritten to "client polish" by
the M7 standalone design pass when the tenancy pivot killed the multi-user
admin surface; now the nice-to-haves milestone — the user wants a round of
quality-of-life features (an in-app profile viewer, plus features borrowed
from the third-party client Horizon) **before** committing to the desktop
app, which moves out to **MX** (undated, after M8).*

**Goal:** the quality-of-life round that makes EmberChat pleasant to live
in day to day — user-facing niceties over infrastructure.

**Depends on:** M7. **Not yet specced** — the list below is a candidate
pool to scope with the user when M8 becomes active, not a committed plan.

## Candidate scope (unspecced)

- **In-app profile viewer** — view an F-List character's profile inside the
  client (pulled up from the post-v1.0 wishlist, where the M6 parity audit
  had parked it as "eventually, not v1.0"). Character-data budget rules from
  the developer policy apply; scope the depth (basic card vs. full profile)
  when we plan it.
- **Horizon-inspired features** — mine the third-party client
  [Horizon](https://horizn.moe/) for quality-of-life features worth
  adopting. **To be surveyed with the user** — they'll point at what they
  liked, or I'll do a feature pass at M8 kickoff (the way the M6 parity
  audit mined chat3client). Do not spec until then.
- **Client polish (carried from the previous rewrite):** in-log search
  (server-side over the messages table); composer affordances (BBCode/
  Markdown toolbar, `/help` slash reference, warn-code support); a light
  theme (the full token-set pass deferred from M5, decisions.md §10);
  graduated LOWs from the M2–M7 audit backlogs.

## Explicitly elsewhere

- **Desktop client** → **Milestone MX** (undated). The embedded-bouncer
  plan in `standalone-client.md` (library extraction → pglite seam →
  Electron shell → packaging) is deferred until after this nice-to-haves
  round; the user does not want to build it at the M8 slot yet.
  - *Exception, available anytime:* extracting the session engine into
    `packages/session-engine` (standalone-client.md phase 1) is
    independently useful — cleaner boundaries, isolatable tests — and is
    **not gated behind MX**. It can be done as an ordinary refactor whenever
    it helps, without committing to the desktop app.
- **Admin tooling** — none needed at current tenancy; the admin CLI covers
  account create/reset. Revisit only if multi-user instances ever return.
