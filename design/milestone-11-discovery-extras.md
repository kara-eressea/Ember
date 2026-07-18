# Milestone 11 — Discovery extras (candidate pool)

*Created 2026-07-18 during the M10 scope session: everything the user
deferred out of M10. **Not yet specced** — candidate pool only; survey and
scope with the user at kickoff, after M10 ships.*

**Depends on:** M10 (the ad library, manual posting path, and FKS search
these features extend).

## Candidate pool (unspecced)

- **Auto-posting / rotation** — timed re-posting of library ads to their
  target channels. **Policy-sensitive** (automated posting under the
  F-List developer policy); posture was pre-decided at the M10 scope
  session so it survives until kickoff:
  - Conservative **hard minimum interval** well above the `lfrp_flood`
    floor (e.g. can't schedule under 10–15 min per channel); the flood VAR
    is the floor, never the target.
  - **Jitter/randomization** to avoid metronome posting — idea explicitly
    kept on the table, decide at kickoff.
  - On ERR 56 or kick/ban: **pause that channel's rotation** with a
    visible warning explaining what happened — never silently skip and
    retry.
  - **Global kill switch** + per-channel "next post at…" status surface.
  - **Cap on concurrent channels in rotation** (flood safety + policy
    conservatism) — imitate Horizon's cap if it has one (M10 step-1
    investigation should record it).
  - Open at kickoff: posting while detached (the bouncer posting with no
    browser attached is the most "unattended automation" posture).
  - **No automated live testing** — rotation is verified against
    fchat-sim's ERR 56 simulation only.
- **Ad ratings** (Horizon parity — rate/annotate posters' ads locally).
- **Smart-filter auto-replies** — parked here from the parity audit's ⛔:
  sends messages on the user's behalf; needs its own policy discussion
  before any speccing.
- **Keyword/regex ad-filter rules** (highlight-rules-style hiding by body
  content) — M10 judged the Chat/Ads/Both selector sufficient; revisit on
  demand.
- **Per-character "hide their ads only"** (stacks on ignore) — same
  status: revisit on demand.
- **Hide-below-match-score filtering** — rejected in M10 as inconsistent
  by construction under the click-only budget rule (only cached posters
  could be scored); revisit only with a deliberate budget story.
- **Search extras** — search history beyond M10's saved searches, extra
  filter dimensions if the wire grows any.

## Explicitly elsewhere

- Ad center, manual posting, Chat/Ads/Both view, cache-only match chips,
  FKS search + saved searches → **M10**
  ([milestone-10-ads-and-search.md](milestone-10-ads-and-search.md)).
- Desktop client → **MX** (`standalone-client.md`).
