# EmberChat — Ad rotation (campaigns) + ad ratings (M11) component specs

Build reference for the auto-rotation **campaign** surfaces and the **rating**
affordances on the M10 ad block. Companion prototypes:

- `Campaign Flow.dc.html` — campaign setup + the running-campaign status surface
  (frames `CM·A`–`CM·F`)
- `Ad Ratings.dc.html` — rate affordance, editor popover, low-rated collapse, mini-card
  rating block (`RT·A`–`RT·E`)

Every value styles against the design-system tokens in `design-system/COMPONENTS.md` —
**never hard-coded hex outside the token table** — so the accent stays swappable (Amber /
Clay Red / Dusk Purple / Burnt Orange / Moss Green). Derived colors use the documented
`mix(a, b, t)` linear RGB lerp. IBM Plex Sans UI, IBM Plex Mono for timestamps, nicks,
counts, clock times. Radii, shadows and modal language match the Post Ads dialog (M10 §3),
Channel Browser (§11) and Preferences (§12).

**Extends, does not redesign:** the Post Ads dialog (`COMPONENTS-ad-center-search.md` §3,
whose footer carried the reserved **`Rotate… soon`** slot), the distinct **ad block** (§5),
the compact **matchPill** size, and the **popover** + **PrivateNote** precedents from
`COMPONENTS-profile-viewer.md` (§13 anchoring, §4 note editor). M11 places new surfaces on
these; it does not fork them.

**Copy register (mandate).** Plain language everywhere the user reads. Never protocol
jargon — no LRP/FKS/ERR codes, VAR names, "wire". The words are **ad**, **channel**,
**campaign** / **rotation**, **posting window**, **device attached**. Reasons are stated
in full sentences, never codes.

---

## Part 1 — Campaigns (auto-rotation)

### Product rules the UI must express (locked)

A character runs **at most one campaign**: a set of **tags** (their enabled ads cycle in
library order) × a set of joined channels that allow ads × a schedule the user mostly
doesn't drive.

- Each channel gets one ad roughly every **12–22 min** (12-min hard floor + deliberate
  randomness so it never looks mechanical). A channel whose description asks `[ads: N min]`
  uses **N as its floor instead when N > 12** — the UI shows the request is being honored.
- A campaign **expires after 1 hour**; renewable in one click. Expiry stops posting
  **visibly** — a distinct state, never an empty screen.
- Rotation runs **only while a device is attached**; detaching pauses the whole campaign
  (the expiry clock keeps running).
- A channel that **refuses** an ad (posted too soon from elsewhere) or **removes** the
  character (kick/ban) pauses **that channel** with a visible reason. Never silent, never
  auto-retried.
- A global **Stop everything** control is always one click away.
- **Manual posting stays available** alongside a running campaign.

---

### 1. CampaignSetupDialog  (`CM·A`)

Post-Ads dialog language: **648 × 600**, `side`, radius 14 (`radius + 5`), modal shadow
`0 40px 100px -20px rgba(0,0,0,.7)`, flex column (head · scroll body · footer). Opened from
the **Rotate…** slot in the Post Ads footer (§4).

- **Header:** "Set up a campaign" (17/700) + mono sub "as {identity} · rotates on its own
  for 1 hour".
- **StepLabel** (reused from M10 §3): 18px `accentSoft`/`accentMed` numbered dot + 13/600
  title + `faint` hint. Two steps.

#### 1a. TagRotationPicker — StepLabel 1 · "Pick tags to rotate"
Hint: "every enabled ad with these tags cycles, in library order".
- **TagPickMulti** chips (extends M10 §3a `tagPick` to multi-select): pad `5px 8px 5px 11px`,
  radius 20, 12/600, trailing mono count badge (enabled ads carrying the tag). **On** =
  `accent` fill, `bg` text, leading `✓`, count badge inverts to `accent`-on-`mix(bg,accent,.15)`.
  **Off** = `bg` fill, `border`, `dim`. Multiple tags select at once; the rotation set is the
  **union** of their enabled ads (deduped).
- **ResolveBox** — resolves the union to a concrete, ordered cycle so "what will post" is
  never ambiguous. `bg` card, `border`, radius 9. Header strip on `side2`: "**N ads will
  rotate**" (12/700 `accent`) + mono "library order · loops" right. Body: numbered rows —
  mono `n·` index (`accent`, 16px col) + ad first-line (12.5px, ellipsised). The last row
  carries a mono `↺ back to 1` marker to make the loop explicit.

#### 1b. CampaignChannelPicker — StepLabel 2 · "Choose channels"
Hint: "each gets one ad on its own schedule — never faster than every 12 min". Only channels
whose server mode allows ads (`ads` / `both`).
- **ChannelRowSetup** (extends M10 §3b): 18px checkbox (`accent` fill + `bg ✓` on) · mono `#`
  · mono name (13.5/600) + **ModeBadge** (M10 §3b) · **EffectiveInterval** sub-line ·
  right-aligned member count (`ok` dot + mono). **Selected** = `mix(accent,side,.9)` +
  `inset 2px 0 0 accent`.
- **EffectiveInterval** (the per-row schedule fact): 11px sub-line under the name.
  - no request → `≈ one ad every 12–22 min` (`faint`).
  - `[ads: N min]` present and N > 12 → `≈ one ad every N min · honoring [ads: N min]`
    (`accent`, so an honored request reads as active respect, not a limit).

#### 1c. DurationCard (the 1-hour is a fact, not a control)
Below the channel list: `accentSoft` fill, `accentMed` border, radius 9, pad `12px 14px`.
mono `⧗` (17px `accent`) + "**Runs for 1 hour, then stops**" (12.5/700) + sub "The length is
fixed — you can't change it here. One click renews it for another hour." (11.5 `dim`). There
is deliberately **no duration control**.

#### 1d. Footer
`side2`, top border, pad `13px 20px`. Left resolution recap "**N ads → M channels** · this
posts on its own until it expires" (`dim`, counts in `text`). Right: **Start campaign**
(36px `accent` primary). The "posts on its own until it expires" clause is mandatory — it is
the one line that makes auto-posting unmistakable.

```
Data (setup): {
  identity,
  tags:     [{ tag, count, sel }],            // count = enabled ads carrying the tag
  cycle:    [ adFirstLine ],                   // resolved union, library order
  channels: [{ name, mode:'ads'|'both', req?, members, sel }]   // req = [ads: N min] minutes
}
```

### 2. Setup edge states  (`CM·B`)

- **Campaign already running** → an inline **ReplaceBanner** above the steps (not a separate
  screen): `mix(warn, side, .86)` fill, `mix(warn, side, .55)` border, `⚠` (`warn`). Title
  "A campaign is already running as {identity}", body "{n} minutes left · {k} channels active.
  Starting a new one **replaces it** — the current one stops immediately." Actions: **Keep
  current** (ghost) + **Replace** (`warn` fill, `bg` text). Start-replaces-it is explicit and
  destructive-tinted, never silent.
- **No ads with those tags** → dashed-tile card (M10 §3d language): `○` glyph, "No ads with
  those tags", "None of your enabled ads carry the tags you picked. Choose other tags, or
  enable an ad in the Ad Center." → **Open Ad Center →**.
- **No channels allow ads** → dashed-tile card: `⊘` glyph, "No channels allow ads", "You
  haven't joined any channel whose mode is ads or both. Join one from the browser, then set
  up a campaign." → **Browse channels →**.

---

### 3. CampaignStatusSurface  (`CM·C`–`CM·E`) — the heart of M11

Same **648-wide** dialog shell; the Rotate… slot **reopens into this** when a campaign
exists (setup when it doesn't). Height ~500–520. Flex column: head · **ExpiryBar** · channel
scroll body · **StatusFooter**.

- **Header:** "Campaign" (17/700) + mono sub "as {identity} · N ads rotating · started HH:MM"
  (or "· expired HH:MM" / "· paused while you're away").

#### 3a. ExpiryBar — time left + Renew, one strip, three tones
Full-width strip below the header, pad `14px 20px`, with a 4px elapsed **track** (`bg` fill +
tone fill) beneath the row.
- **Live:** `mix(accent, side, .9)` fill, `mix(accent, side, .55)` border. Left: a **pulsing
  `ok` live dot** (`0 0 5px ok` glow, 1.6s ease pulse) + "**Posting live**" (13/700) + mono
  "K channels active · J waiting · L stopped". Right: mono "**expires in MM:SS**" (`accent`,
  600) + **↻ Renew** (28px small `accent`-outline button). Track fill = `accentMed` at
  elapsed fraction.
- **Detached (away):** `mix(warn, side, .9)` fill. mono `⏸` (`warn`) + "**Paused — no device
  attached**" + sub "Rotation resumes on its own when you reconnect. The 1-hour clock keeps
  running while you're away." Right: mono "expires in MM:SS" (`warn`). Track fill `mix(warn,
  side, .35)`. (See 3c.)
- **Expired:** `mix(danger, side, .9)` fill. Neutral `faint` dot + "**Campaign expired —
  posting has stopped**" + mono "ran HH:MM – HH:MM · 1 hour". Right: **Start again** (small
  `accent` primary). Track full, `mix(danger, side, .4)`. (See 3d.)

#### 3b. ChannelStatusRow — one row per channel, four states
Pad `10px 12px`, margin `0 2px`, radius 9, hairline `mix(border, side, .4)` between.
- **Active:** leading `ok` **live dot** (14px centered col) · mono `#` · mono name (13.5/600)
  + **ModeBadge** · EffectiveInterval sub ("every ≈N min · honoring their request" / "every
  12–22 min", `faint`). **Right block (right-aligned):** "**next ≈ HH:MM**" (mono 12.5,
  `accent` 600) over "in {Xm} · last {HH:MM}" (mono 10.5 `faint`). The `next ≈` countdown is
  the core affordance — the user reads when the channel posts next and when it last posted.
- **Waiting** (active but between posts, or held while away): whole row `opacity:.7`, the
  leading dot becomes a mono `⧗` (`faint`).
- **Refused** (`refused`): row `mix(warn, side, .93)` + `inset 2px 0 0 mix(warn,side,.45)`.
  Leading `⏸` (`warn`) · name · reason (11.5 `warn`) "**This channel got an ad from somewhere
  else — waiting out its window.**" Right: "retry ≈ HH:MM" (`warn` 600) over "last HH:MM".
  Never auto-retried; the estimate is when the window reopens.
- **Removed** (`removed`): row `mix(danger, side, .94)` + `inset 2px 0 0 mix(danger,side,.45)`.
  Leading `⊘` (`danger`) · name · reason (11.5 `danger`) "**You were removed from this channel
  — rotation stopped here.**" Right: **Drop ×** (`faint`, removes it from the campaign). This
  channel does not resume.

```
Data (status row): {
  name, mode, req?,
  state: 'active'|'waiting'|'refused'|'removed',
  next?, inMin?, last?, retry?         // next/inMin/last for active; retry+last for refused
}
```

#### 3c. Detached whole-campaign state  (`CM·D`)
ExpiryBar in **detached** tone (3a). All active/waiting rows render in the **waiting** look
(dot → `⧗`, `next` shown as `—`, "held"); refused rows keep their reason but show "retry
held". The plain contract: rotation is paused, resumes on reconnect, and the expiry clock is
still ticking — the user returns to this and understands it at a glance.

#### 3d. Expired state + run summary  (`CM·E`)
ExpiryBar in **expired** tone (3a). The body switches to a **RunSummary** (it earns its space
— it answers "what did that hour do?"):
- **TotalStrip:** `bg` band — "What went out" (`dim`) + mono "P posts across M channels".
- **SummaryRow** per channel: mono `#` name (13.5/600) + optional note (11 `faint`, e.g.
  "paused part of the run — a channel was posting elsewhere" / "you were removed at HH:MM") +
  right-aligned mono "**N posts**" (`ok` if N>0, else `faint`).
- **Footer:** "Nothing is posting now — renew to run another hour." + **Change tags** (ghost)
  + **↻ Renew for 1 hour** (`accent` primary).

#### 3e. StatusFooter (live/detached)
`side2`, top border. Left: **■ Stop everything** (36px `danger`-outline button) — the global
kill, always one click away. Right: "**Post once manually →**" (`accent` link) — manual
posting (M10 §3) stays reachable while a campaign runs.

---

### 4. Entry points & the live indicator  (`CM·F`)

The reserved M10 **Rotate… soon** slot comes alive; a running campaign is also surfaced
subtly at the point of action.

- **Post Ads footer — idle:** the slot is now an active **↻ Rotate…** button (36px,
  transparent, `accentMed` border, `accent`), left of the unchanged **Post now** primary.
  Opens the setup dialog (§1). The M10 "soon" tag is gone.
- **Post Ads footer — campaign live:** the slot becomes a **LiveIndicator** chip — `accentSoft`
  fill, `accentMed` border, a **pulsing `ok` dot** + "Campaign live" + mono time-left ("41m").
  Clicking reopens the status surface (§3). **Post now stays untouched beside it** — manual and
  campaign coexist.
- **Channel header chip:** a channel the running campaign posts into carries a quiet pill in
  its header — pulsing `ok` dot + "Campaign · posting here" (`accent` on `accentSoft`). Subtle,
  never a banner. Ads never affect unread counts (M10 §5 rule holds).

---

## Part 2 — Ratings

### Product rules the UI must express (locked)

The user rates **other posters'** ads: **★ 1–5 + an optional short note**, saved **locally on
this server only** — nothing ever goes to F-List, and copy may reassure. Ratings are **per
person, shared across the user's own characters**. Posters rated **≤ 2★ render dimmed/collapsed**
(one-line stub, click-to-expand — the ad is never unreachable); rated posters' ads show their
stars.

### 5. StarRating primitive

The rating scale, one source of truth. **★ 1–5**, filled `warn` `#d0a24f`, empty
`mix(faint, bg, .45)` — warm amber that reads distinctly from the accent (so it never looks
like a match/compat signal) and survives all five accents (`warn` is a fixed neutral-ish
token). Filled glyph `★` (U+2605), empty `☆` (U+2606) — the glyph swap is a second,
colorblind-safe channel.

- **Display (inline):** `inline-flex`, gap 1px, glyph size by context (10–11px on ad-row
  header, 15px on the mini card / spec). Optional trailing mono `n/5` count (size − 2, `dim`).
- **Interactive (editor):** 24px glyphs, `cursor:pointer`, hover fills up to the hovered star.
- **RatingChip** (ad-row header): the display stars in a pill — `mix(warn, bg, .86)` fill,
  `mix(warn, bg, .62)` border, pad `1.5px 7px 1.5px 6px`, radius 20. A note adds a trailing
  mono `✎` (`warn`). This is what a *rated* poster's ad shows instead of the Rate affordance.

```
Data: rating?: { score: 1..5, note?: string } | null    // per person, shared across your chars
```

### 6. Ad-block rating affordance  (`RT·A`, `RT·B`) — extends M10 §5

On the distinct **ad block** (M10 §5), in the header line's **flex spacer** (same place the
cached-only matchPill lives — absence leaves no hole).
- **Unrated poster:** a quiet **☆ Rate** pill — `border`, `faint`, `10.5/600, radius 20 —
  hidden (`opacity:0`) until the row is hovered, so it never adds clutter to the log. It sits
  after any matchPill.
- **Rated poster:** the **RatingChip** (§5) replaces the Rate pill on **every subsequent ad
  from that poster** — their stars ride along in the header. Because ratings are per person,
  this is consistent across all of the user's characters.
- **Click** opens the **RateEditor popover** (§7). Clicking the nick still opens the mini
  profile card (M10 §5 / M8 §13) — the two affordances don't collide.

### 7. RateEditor (popover)  (`RT·A`)

Anchored to the ad row per **§13** (below-start, flip, 8px clamp, dismiss on click-away /
Escape / opening another popover). Reuses the **PrivateNote editor** language (M8 §4).
**260px**, `side`, radius 9, popover shadow `0 20px 50px -10px rgba(0,0,0,.7)`.
- **Header** (`side2`, bottom border): 26px poster avatar (radius 7) + nick (13/600) + mono
  sub "shared across your characters".
- **Body:**
  - eyebrow "RATE THIS POSTER" (9.5/700 `.1em` `accent`) + a `Saved ✓` (mono 10 `ok`) once
    saved.
  - **5 interactive 24px stars** + a mono `n/5` (`warn`) or "tap to rate" (`faint`) hint.
  - **Note field:** `bg` card, `border` → focus `accentMed` border + `0 0 0 3px accentSoft`
    ring, min-height 56, 12px body with a blinking `accent` caret; placeholder "Add a private
    note (optional)…".
  - **Reassurance footer (mandate):** mono 9.5, `ok` dot + "**saved on this server only ·
    never sent to F-List**". Present on the editor and echoed on the mini card and the spec.
  - **Clear rating** (`danger`, 11/600) shown once a rating exists.

### 8. Low-rated collapse (≤ 2★)  (`RT·C`)

A poster the user rated **≤ 2★** does not render a full ad block — it collapses to a **dimmed
one-line stub**, so the log stays calm but the ad is never unreachable.
- **CollapsedRow:** margin `4px 16px`, pad `6px 12px`, `bg` fill, `border`, radius 9,
  `opacity:.6`, single line, ellipsised. Contents: a small outline **AD** tag (`faint`) · nick
  (12/600, dimmed via `mix(nickColor, bg, .4)`) · the **display stars** (10px) · the note in
  quotes (11 italic `faint`, ellipsised) *or* "you rated this poster low — ad hidden" · a
  trailing mono "**show ▾**".
- **Expanded:** clicking "show ▾" reveals the full ad block (M10 §5) in place — the RatingChip
  still opens the editor (rating stays editable), and the note is **surfaced** as a **YourNote**
  strip inside the block: a top hairline `mix(warn, side, .7)` + mono `YOUR NOTE` eyebrow
  (`warn`) + the note (11.5 italic `dim`). Collapse is per poster and reversible.

### 9. Rating on the mini profile card  (`RT·D`) — composes with M8

When the user has rated a person, a **"Your rating"** block composes into the **mini profile
card** (M8 §13 / `Mini Profile Viewer`) **below the compatibility block**, above the actions —
it does not disturb the M8 anatomy.
- Section: top hairline `mix(border, side, .35)`, pad `11px 14px`. Head row: GroupLabel "YOUR
  RATING" + mono "this server only" (`faint`). Body: **display stars 15px + `n/5`** + an
  **Edit** link (`accent`, right) → opens the editor (§7). If a note exists: it renders below
  in quotes (11.5 italic `dim`).
- A **low (≤ 2★)** rating shows the **same block** — only the in-log ad row collapses (§8),
  never the card. The card is always fully reachable.

```
Data (mini card, extends M8): { …M8 fields…, rating?: { score, note? } | null }
```

---

## Reuse notes

- **matchPill / MatchTier** unchanged — the compact ad-row size (M10 reuse note) still governs
  any match chip on the ad block; the RatingChip sits beside it in the same flex spacer under
  the same "absence is normal" rule.
- **Popover + PrivateNote** are reused verbatim in language (M8 §13 anchoring, §4 editor) — the
  RateEditor is a note editor with a star row on top; no new popover mechanics.
- **StepLabel, ModeBadge, CadenceHint, ChannelRow, tag chips, dashed edge-tiles** all extend
  the M10 Post Ads dialog rather than reinventing it — the campaign setup is the manual flow's
  second mode, not a separate design.
- All neutrals fixed; only `accent` + gender/per-nick colors change per accent option. `warn`
  (rating stars) and `ok` (live dots) are fixed tokens, so ratings and campaign liveness read
  identically across all five accents and with color removed (the star glyph swap and the pie
  fill both carry meaning without hue).
- **No jargon leaks:** every reason, countdown label, and reassurance is a plain sentence.
  Refused = "got an ad from somewhere else — waiting out its window"; removed = "you were
  removed — rotation stopped here"; away = "no device attached… the 1-hour clock keeps running";
  ratings = "saved on this server only · never sent to F-List".
