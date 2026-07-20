# Milestone 11 — Discovery extras: ad rotation & ratings

*Specced 2026-07-20 with the user (scope Q&A, three rounds). Ships as
**v0.10.0**. Created 2026-07-18 as the M10 deferral pool; the unpicked
candidates remain pooled at the bottom.*

**Depends on:** M10 (the ad library, manual posting path, per-channel LRP
gate, and ad-row rendering these features extend).

## Committed scope

### 1. Ad rotation (campaigns)

Timed re-posting of library ads — the M10 Post Ads dialog's reserved
**Rotate…** slot comes alive. Policy posture is deliberately conservative
(automated posting under the F-List developer policy); every figure below
was settled with the user against the M10 step-1 Horizon survey.

**Model — one campaign per character:**
- A campaign is: one or more **tags** (the M10-parked tag-union surface —
  the selected tags' union of enabled ads), a **channel set** drawn from
  joined ads/both channels, and the schedule below. At most **one active
  campaign per character**; starting a new one replaces it (with
  confirmation).
- Each tick posts **one ad to one channel** (the wire allows nothing
  else); the campaign **cycles the ad set in library order** per channel,
  so channels see variety and the library order stays meaningful.

**Schedule:**
- **Base interval 12 minutes per channel — a hard floor**, comfortably
  above the 10-minute `lfrp_flood` window. The flood VAR is the floor of
  the *wire*, never the schedule's target; the runtime VAR is still
  honored if it ever exceeds the base.
- A channel's **`[ads: N min]` description token raises that channel's
  floor to N** when N > 12 (M10 parses and displays it; M11 enforces it).
- **Horizon-style jitter**: a randomized start offset plus per-post
  variance over the base gap (Horizon's figures: ~3 min start / ~8 min
  per-post variance — net "12–22 min"); posting must never look
  metronomic.
- **App-wide spacing ≥ 7.5 s** between any two ads across all of a
  user's characters (server-side scheduler gate), and a **5 s no-ad
  window around the user's own manual posts** (both Horizon-surveyed).

**Bounds & lifecycle:**
- **Campaign expiry: 1 hour**, renewable with one click; on expiry the
  rotation stops **visibly** (status surface + a system line in the
  affected channels' logs — never a silent stop).
- **Attached-only:** rotation runs only while at least one of the user's
  devices is attached to the bouncer; detaching pauses the campaign and
  re-attaching resumes it (the expiry clock keeps running — a campaign
  never outlives its hour by being paused).
- On **ERR 56 or a kick/ban** from a channel: that channel's rotation
  **pauses with a visible warning** explaining what happened — never
  silently skip and retry (strictly better than Horizon, which loses
  refused ads).
- **Global kill switch** (one control stops every channel at once) and a
  per-channel **"next post at…"** status surface.
- Campaign state persists (DB) so a page reload or bouncer restart
  doesn't orphan a running campaign — but posting still requires
  attachment, and the absolute expiry timestamp governs regardless.

**Verification posture:** **no automated live testing** — rotation is
verified against fchat-sim's ERR 56 simulation and clock control only.
The supervised live pass may include one short manual campaign
observation at the user's discretion.

### 2. Ad ratings

Horizon-parity local ratings on other posters' ads. **Local-only: nothing
is ever sent to F-List.**

- **★ 1–5 with an optional short note**, set from an ad row affordance
  (and visible on the poster's profile card).
- **Per app user** — ratings describe the rated character, not the rating
  persona: one table keyed on (user, rated character), shared across all
  the user's identities.
- **≤ 2★ posters render dimmed/collapsed** with click-to-expand (the ad
  is never unrecoverable); 3★+ render normally with the stars visible on
  the ad block.
- REST CRUD + a client store; ratings apply to future *and* already
  rendered ads of that character.

## Step checklist (dependency-ordered)

- [ ] 1. Protocol + DB groundwork: campaign & rating DTOs and gateway
  cmds/events in `packages/protocol` (`campaign.start/stop/renew` +
  status events; ratings ride REST only), migrations for `campaigns` and
  `ad_ratings`
- [ ] 2. Server ratings module: ownership-scoped CRUD
  (`GET/PUT/DELETE` by rated character), validation (1–5, note length),
  integration tests
- [ ] 3. Server campaign scheduler (session engine): per-channel
  timelines with base-12 floor + cadence-token floor + jitter, app-wide
  7.5 s spacing + 5 s manual-post window, attached-only gating off the
  gateway subscription count, 1 h absolute expiry + renew, ERR 56 /
  kick / ban pause-with-warning, kill switch, persistence + restart
  behavior; gateway wiring; sim-clock tests (no live testing)
- [ ] 4. CD brief for the campaign surface (Rotate… slot setup +
  status/countdown/warning states, renewal, kill switch) and the rating
  affordances (row control, dimmed/collapsed ad, note editor) →
  design pass → review → sync deliverables into the repo
- [ ] 5. Web: campaign setup + status surface (built to the CD spec;
  plain-language copy pass)
- [ ] 6. Web: rating affordances + dimmed rendering (built to the CD
  spec; plain-language copy pass)
- [ ] 7. Verification suite + docs: E2E campaign journey against the sim
  (start → tick → refusal pause → renew → kill), ratings journey,
  feature-parity-audit rows, tracker sweep
- [ ] 8. Three-reviewer audit + fix pass, then the wrap-up ritual
  (user sign-off → main merge → v0.10.0)

## Deferred pool (not in M11 — revisit on demand)

- **Smart-filter auto-replies** — ⛔ parked: sends messages on the user's
  behalf; needs its own policy discussion before any speccing.
- **Keyword/regex ad-filter rules** — M10 judged the Chat/Ads/Both
  selector sufficient; the new ratings dimming covers part of the want.
- **Per-character "hide their ads only"** — partially covered by rating a
  poster ≤ 2★; revisit if full hiding is still wanted.
- **Hide-below-match-score filtering** — rejected while the click-only
  budget rule stands (only cached posters could be scored); needs a
  deliberate budget story.
- **Search extras** — search history beyond saved searches; more filter
  dimensions if the wire grows any.

## Explicitly elsewhere

- Ad center, manual posting, Chat/Ads/Both view, cache-only match chips,
  FKS search + saved searches → **M10**
  ([milestone-10-ads-and-search.md](milestone-10-ads-and-search.md)).
- Desktop client → **MX** (`standalone-client.md`).
