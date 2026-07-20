# Design brief — Ad rotation (campaigns) & ad ratings (M11)

*EmberChat Milestone 11. Two commissioned surfaces: the campaign
(auto-rotation) flow living in the Post Ads dialog's reserved Rotate…
slot, and rating affordances on the M10 ad block. Everything extends the
shipped M10 deliverables — reuse their language, don't reinvent it.*

## Context you already have

- `COMPONENTS.md` — the design system. **All values must trace to the
  token table or `mix()` derivations; five accents must survive; both
  themes.** No hard-coded hex, ever.
- `references/COMPONENTS-ad-center-search.md` — the shipped M10 spec this
  milestone extends: the Post Ads dialog (§3) whose footer carries the
  reserved **`Rotate… soon`** slot, the distinct ad block (§5), the
  compact `matchPill` size precedent.
- Register: plain language in all user-facing copy. Never LRP/FKS/ERR
  codes/VAR names/"wire". "Ad", "channel", "posting window",
  "campaign"/"rotation" are the words.

## Product rules (locked — design around them, don't soften them)

**Campaigns.** A character runs at most **one campaign**: a set of
**tags** (their enabled ads cycle in library order), a set of joined
channels that allow ads, and a schedule the user mostly doesn't control:

- Each channel gets one ad roughly every **12–22 minutes** (12-minute
  hard floor + deliberate randomness so posting never looks mechanical).
  A channel whose description asks `[ads: N min]` gets N as its floor
  instead when larger — show that the request is being honored.
- A campaign **expires after 1 hour**, renewable with one click; expiry
  stops posting **visibly** — an expired campaign is a distinct state,
  not an empty screen.
- Rotation **only runs while the user has a device attached**; detaching
  pauses it (the expiry clock keeps running). Paused-because-away is a
  state the user returns to and must understand at a glance.
- A channel that **refuses an ad** (posted too soon from elsewhere) or
  **removes the character** (kick/ban) pauses *that channel* with a
  visible explanation. Never silent, never auto-retried.
- A **global "stop everything" control** is always one click away.
- Manual posting (§3 flow) stays available alongside a running campaign.

**Ratings.** The user rates *other posters'* ads: **★ 1–5 with an
optional short note**, saved locally on this server only — nothing is
ever sent to F-List, and copy may reassure about that. Ratings are per
person, shared across the user's own characters. **Posters rated ≤ 2★
render dimmed/collapsed** (one-line stub, click-to-expand — the ad is
never unreachable); rated posters' ads show their stars.

## Commissioned surfaces

### §A Campaign setup (the Rotate… slot comes alive)

From the Post Ads dialog footer. Setup needs: tag selection (multi —
the union of the chosen tags' enabled ads is the rotation set; show
which/how many ads that resolves to and their cycle order), channel
selection (reuse the §3 channel-row language: mode badge, cadence chip,
member count; a channel's effective interval — base or its `[ads: N
min]` request — should be readable per row), the 1-hour duration as
fixed fact (not a control), and a start affordance that makes "this will
post on its own until it expires" unmistakable. Edge states: no tagged
enabled ads, no eligible channels, a campaign already running
(start-replaces-it confirmation).

### §B Campaign status surface

The heart of the milestone. While a campaign runs the user needs, at a
glance: time left until expiry + one-click **Renew**; per-channel rows
with **"next post at HH:MM" countdowns** and last-posted times; paused
channel rows with the reason in plain words (refused: "this channel got
an ad from somewhere else — waiting out its window" register; removed:
"you were removed from this channel — rotation stopped here"); the
paused-because-detached whole-campaign state; the **expired** state with
Renew/Start-again; and the global **Stop** control. Decide where this
lives (the Rotate… slot reopens into it; consider also a compact
indicator that a campaign is live — e.g. in the Post Ads entry point —
but keep it subtle). Show a stopped/expired campaign's summary (what
posted where, how many times) if it earns its space.

### §C Rating affordances on the ad block

On the M10 ad block (§5): an unobtrusive hover/overflow affordance to
rate the poster (★ 1–5 + optional note editor — popover language, see
the M8 popover precedents); stars render on subsequent ads from that
poster; the **dimmed/collapsed ≤ 2★ row** (one-line stub naming the
poster + their stars, click expands to the full block, with the rating
still editable); the note surfaced somewhere honest (tooltip or the
expanded state). Also show the rating (stars + note) on the mini profile
card if it composes cleanly with the M8 card spec.

## Deliverables

Same shape as the M10 delivery: `.dc.html` prototype pages (one per
surface or sensibly grouped, all states demonstrated including edge and
empty states, both themes implied by token discipline) plus a
`COMPONENTS-rotation-ratings.md` component spec with exact metrics,
states, and copy. Copy in the deliverables is production copy — plain
language throughout.
