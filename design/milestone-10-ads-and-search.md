# Milestone 10 — Ads & character search

*Created 2026-07-16 during the M8 scope session: the user wants Horizon's ad
tooling eventually, combined with an in-app character search — deliberately
deferred until the M8 profile/matcher foundation exists to build on.*

**Goal:** the discovery round — authoring, posting, and filtering roleplay
ads, plus in-app character search, both leaning on M8's profile service and
compatibility matcher.

**Depends on:** M8 (reuses `ProfileDto`, the profile cache/budget, and
`@emberchat/matcher`). **Not yet specced** — candidate pool only; survey and
scope with the user at kickoff.

## Candidate scope (unspecced)

- **Ad center** (Horizon-inspired) — author ads once, tag them, manage
  centrally; post to selected channels.
- **Auto-posting / rotation** — timed re-posting respecting per-channel ad
  cooldowns (`ERR 56` pacing, LRP flood rules). **Policy-sensitive:**
  `feature-parity-audit.md` flagged automated posting as an area to treat
  carefully under the developer policy — the speccing session must settle
  posture (e.g. conservative minimum intervals, hard per-channel compliance,
  no posting while detached?) before any implementation.
- **Ad filtering / smart filters** — hide ads/posts by content category or
  by poster; hide ads from specific characters.
- **Match scores on ads** — the M8 matcher applied to incoming LRP ads
  (colored score chip on ad rows). Mind the character-data budget: scoring
  an ad requires the poster's profile — likely cache-only or
  explicit-action, never bulk prefetch.
- **FKS in-app character search** — the chat-protocol search command
  (kinks/genders/orientations/languages/roles filters), skipped at the M6
  parity audit; results integrate with the M8 mini card / profile viewer,
  optionally match-scored (same budget caution).

## Explicitly elsewhere

- Profile viewer, matcher, eicon search → **M8** (the foundation this builds
  on).
- Client polish → **M9**.
- Desktop client → **MX** (`standalone-client.md`).
