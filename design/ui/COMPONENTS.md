# Emberline — Component Cheat Sheet

Framework-agnostic build reference. Every value here is exact and taken from the design. Build components against **tokens**, never hard-coded hex, so the accent stays swappable.

> **Deviation (2026-07-12, see `../decisions.md` §6):** all avatars (IdentityRail, MeBar, IdentityPicker, MemberRow, context menu, DM rows) render the character's real F-List profile image instead of the mono initial. The initial-on-color spec below remains as the loading/error fallback; sizes, radii, and presence-dot specs are unchanged.
>
> **Deviation (2026-07-12, see `../decisions.md` §8):** the MessageLog also renders inline `[eicon]`/`[icon]` images (small, often animated GIFs) inside MessageLine bodies at a fixed ~60px box with explicit dimensions — not shown in the mockups. The composer's ☺ hint button is the eicon insert helper.

---

## Design Tokens

### Color — neutrals (fixed across all themes)
| Token | Hex | Use |
|---|---|---|
| `bg` | `#1b1917` | app background, main chat, inputs |
| `side` | `#232120` | left sidebar surface |
| `side2` | `#2a2725` | rail, member list, me-bar, elevated strips |
| `head` | `#201e1c` | channel header background |
| `text` | `#ece7e0` | primary text |
| `dim` | `#a89e92` | secondary text, topic, muted labels |
| `faint` | `#726a5f` | timestamps, glyphs, meta, disabled |
| `border` | `#332f2b` | all 1px hairlines / dividers |

### Color — accent (swappable; default = Dusk Purple)
| Token | Hex | Notes |
|---|---|---|
| `accent` | `#a892c6` | active markers, links, mentions, primary buttons |
| `ok` | `#8bb173` | online presence, success, connected |
| `warn` (idle) | `#d0a24f` | idle presence |
| `danger` | `#e08a6a` | ignore / destructive |

**Accent options** (user-selectable): Amber `#e6a75a` · Clay Red `#c87d6a` · Dusk Purple `#a892c6` · Burnt Orange `#dd955a` · Moss Green `#88ac72`. When accent is Moss Green, shift the idle/warn dot to `#c9a25e` so it doesn't clash.

### Derived colors (compute from a `mix(a, b, t)` = linear RGB lerp, `t` = weight toward `b`)
| Token | Formula | Dusk value |
|---|---|---|
| `accentSoft` | `mix(accent, bg, 0.84)` | `#322c33` — mention row bg, active-row bg, chips |
| `accentMed` | `mix(accent, bg, 0.5)` | `#62566f` — unread badge bg, focus rings, borders |
| `codebg` | `mix(text, bg, 0.90)` | `#302e2b` — inline code + code blocks |
| `hoverMain` | `mix(text, bg, 0.95)` | row hover in main |
| `hover` | `mix(text, side, 0.93)` | row hover in sidebar |

```js
function mix(a, b, t) {            // a, b = "#rrggbb"
  const p = h => [1,3,5].map(i => parseInt(h.slice(i, i+2), 16));
  const A = p(a), B = p(b);
  return '#' + A.map((v,i) => Math.round(v*(1-t) + B[i]*t).toString(16).padStart(2,'0')).join('');
}
```

### Typography
- **UI font:** `'IBM Plex Sans', system-ui, sans-serif`
- **Mono font:** `'IBM Plex Mono', ui-monospace, monospace` — timestamps, nicks, code, server addresses, channel `#`, counts
- **Message body:** UI sans (this is the "Slate Cozy" choice — the log is line-based but bodies are sans; only timestamp + `<nick>` are mono)
- Scale: 10–11px uppercase labels (`.09em` tracking), 12.5–13px body/rows, 13–14px inputs, 15px section titles, 17–18px channel name, 22px dialog titles, 28–46px landing headings.

### Radius & elevation
- `radius` = **9px** (Slate Cozy). Rows, inputs, buttons, chips use it; small chips/tags use 4–5px; pills/badges use full (`20px`+).
- Modal/window radius: `radius + 5` = 14px.
- Modal shadow: `0 40px 100px -20px rgba(0,0,0,.7)`. Popover: `0 20px 50px -10px rgba(0,0,0,.7)`. Window: `0 30px 80px -20px rgba(0,0,0,.6)`.

### Presence system
| State | Dot color | Extra |
|---|---|---|
| online | `ok` | `box-shadow: 0 0 4px ok` (subtle glow) |
| idle | `warn` `#d0a24f` | — |
| offline | `faint` | containing row rendered at `opacity: .5` |

### Role system (IRC)
| Role | Glyph | Glyph color | Name weight |
|---|---|---|---|
| owner | `~` | `accent` | 600 |
| admin | `@` | `mix(accent, text, .4)` | 600 |
| member | *(none)* | `faint` | 400 |

### Per-nick colors (deterministic)
Assign each nick a stable color: `palette[ sum(charCodes(nick)) % palette.length ]`.
Palette: `['#a892c6','#c294b0','#8f9bc9','#a6bd94','#88b0b8','#cfa2d4','#c69ac2','#98bda8']` (rotate hues with accent).

---

## Layout — AppShell

CSS grid, full viewport. Columns (desktop):

```
[ rail 60px ] [ sidebar 244px ] [ main 1fr ] [ members 232px ]
```

- `rail` column only present when >1 identity is connected (or always, if you prefer a persistent switch).
- Optional browser chrome strip (38px) above, only for the marketing/preview framing — not part of the real app.
- Overlays (context menu, dialogs) are `position: absolute/fixed` above the grid.

**Responsive:** below ~900px, collapse `members` to a toggle (header ☰ button), and turn `sidebar` into a slide-over drawer. Rail stays. Message rows stay single-line; let the body wrap.

---

## Components

### 1. IdentityRail
Far-left vertical switch between connected server identities. Background `side2`, `border-right`.
- **Item:** 40px avatar, mono initial, `color: bg` on a per-identity color fill.
  - **Active:** avatar becomes a rounded square (`radius+2`), row shows `inset 3px 0 0 accent` bar.
  - **Inactive:** avatar stays a circle.
  - Presence dot bottom-right (11px, `2.5px solid bg` ring).
  - **Badge** top-right for background identities: unread count (`accentMed` bg) or `@`/`@n` mention (`accent` bg, `bg` text). Active identity shows no badge.
- **Add button:** 40px dashed circle, `+`, `faint`.
- **Behavior:** click = switch active identity → swaps the *entire* session context (see AppShell data). Right-click (to build): Set status / Reconnect / Disconnect / Reorder.
- **Data:** `{ id, name, initial, color, presence, active, unread, mention }[]`.

### 2. Sidebar (unified nav)
Vertical flex on `side`. Top→bottom: ServerHead · Search · NavScroll (sections) · MeBar.

**ServerHead** — padding 14px, bottom border. Left: 9px `ok` dot (glow), server name (14px/700) + mono sub-line (`irc.emberline.chat · connected`, 10.5px `faint`). Right: gear (`faint`).

**Search** — 30px pill, `bg` fill, `border`, `⌕` + "Jump to…" placeholder (`faint`).

**MeBar** — bottom, on `side2`, top border. 30px accent avatar (self initial, `bg` text) · nick (13px/600) + status row with dot · gear.

### 3. SectionHeader
Sidebar group label. Padding `12px 16px 4px`, 10.5px/700 uppercase, `.09em` tracking, `faint`. Optional right-aligned count (10px `faint`). Sections in order: **Pinned · Channels · Direct Messages · Friends · Bookmarks**.

> Pinning is cross-type: a pinned channel *or* pinned DM both surface under **Pinned** and auto-rejoin/reopen on connect. The same item still logically belongs to its type.

### 4. NavItem (channel / DM / friend / bookmark row)
One row component, variants by `glyph` + presence. Padding `5px 10px`, margin `1px 6px`, `radius`.
- **Leading glyph** (13px mono, `faint`): `#` channel · none for DMs (presence dot instead) · `☆` friend · `⚑` bookmark.
- **Presence dot** (7px) for people rows.
- **Label** (13px): ellipsis. Weight 600 active / 500 normal / 400 muted. Color: `text` active or unread/mention; `dim` normal; `faint` muted.
- **Pin marker** `⚲` (mono 10px `faint`, rotated 45°) when pinned.
- **Badge** (trailing): unread number (`accentMed` bg, `text`) or mention `@`/`@n` (`accent` bg, `bg` text). Radius 9px, mono 10px/700.
- **Active:** `background: accentSoft` + `inset 2px 0 0 accent`.
- **Data:** `{ kind:'channel'|'dm'|'friend'|'bookmark', label, pinned, muted, presence?, unread?, mention?, active }`.

### 5. ChannelHeader
On `head`, bottom border, padding `12px 20px`.
- **Row 1:** `#` (20px mono `faint`) · channel name (18px/700) · "⚲ pinned" chip (mono 10.5px, pill border) · spacer · header buttons `☆` (favorite) `⌕` (search) `☰ {count}` (toggle members). Buttons `dim`, mono.
- **Row 2 — Topic:** `TOPIC` tag (mono 9.5px/700, `accent` on `accentSoft`, 4px radius) + topic text (13px `dim`, single-line ellipsis). The short, editable IRC topic.
- **Row 3 — Description:** longer server-provided blurb (12px `faint`), collapsed by default with a trailing **Show more / Show less** toggle (`accent`, 600). Expands to full text inline.
- **Data:** `{ channel, memberCount, pinned, topic, descShort, descFull, descExpanded }`.

### 6. MessageLog (IRC-compact)
Scroll region, `padding: 12px 0`. Four row types, all `display:flex; gap:9px; align-items:baseline`:

- **DateDivider** — centered mono 11px `faint` between two `border` hairlines.
- **SystemLine** (join/part/topic/etc.) — `[time]` · glyph · italic text (12.5px `dim`). Join `→` `ok`; topic `⚑` `accent`.
- **MessageLine** — `[time]` (mono 11.5px `faint`, `tabular-nums`) · `<nick>` (mono 12.5px/600, per-nick color, nowrap) · body (13px/1.5 `text`). Padding `2px 16px`.
  - **Mention/highlight** (matches a highlight rule or your nick): `background: accentSoft` + `inset 3px 0 0 accent`, padding `4px 16px`.
- **CodeBlock** (fenced) — its own line, `margin: 3px 16px 5px 76px` (the 76px left indent aligns it under the message body), `codebg` fill, `border`, mono 12px, `white-space: pre`, horizontal scroll.
- Toggle "Show join/part/quit" (Preferences) hides SystemLines of that kind.

### 7. Markdown rendering (message body + composer preview)
Inline tokenizer over these patterns → styled spans:
| Token | Rendered as |
|---|---|
| `**bold**` | `font-weight:700`, `color:text` |
| `*italic*` | `font-style:italic` |
| `` `code` `` | mono, `codebg` bg, 3px radius, `1px 4px` pad |
| `@name` | `color:accent`, `accentSoft` bg, 3px radius, 600 |
| `#channel` | `color:accent`, clickable |
| `https://…` | `color:accent`, underline, `text-underline-offset:2px` |

Order matters — match longest/most-specific first (`**` before `*`). Fenced ``` ``` ``` blocks render as a CodeBlock row (component 6), not inline.

### 8. Composer
Below the log, `padding: 0 20px 16px`.
- **Input bar:** 46px, `side` fill, `border`, `radius`. Leading `+` (attach, 20px `faint`), text input (13.5px, mono or sans per body setting), trailing format hints `**B**` `` `code` `` `☺` (mono 11px `faint`).
- **Live Markdown preview panel** (toggle): appears *above* the input. `side` card, `border`, header strip ("PREVIEW · markdown", mono 9.5px/700 `faint` on `side2`), body renders the composed text through the component-7 tokenizer at 13px.
- **Footer row:** `Ⓜ Markdown` toggle (`accent`) on the left, hint "Enter to send · Shift+Enter for newline" on the right (11px `faint`).
- **Behavior:** typing updates the preview live; toggle shows/hides the preview panel.

### 9. MemberList
Right column on `side2`, `border-left`.
- **Header:** "Members {count}" (13px/700, count mono `faint`), bottom border.
- **Grouped** by presence/role: **Owner · Admins · Online · Idle · Offline**. Group head 10px/700 uppercase `faint`.
- **MemberRow:** padding `4px 12px`, `radius`. 22px avatar (per-nick color, mono initial) with presence dot (8px, `2px solid side2` ring); role glyph (see role system); nick (13px, weight per role, ellipsis); optional italic status text (`faint`, right-aligned). Offline rows at `opacity:.5`.
- **Behavior:** left-click = open profile (server website, new tab); right-click = MemberContextMenu.
- **Data:** `{ nick, role, presence, status? }` grouped.

### 10. MemberContextMenu
Right-click popover on a member. `side` fill, `border`, `radius+2`, popover shadow, 5px padding, ~204px wide.
- **Header:** avatar + nick + role tag (mono 10px `faint`), bottom border.
- **Items** (7px 10px, `radius`, hover `hover`):
  - Message
  - **View profile ↗ website** — opens the user's profile on the server's website in a new tab (client does not render a profile popout; trailing "↗ website" hint in `accent`).
  - Add bookmark
  - Add friend
  - *(divider)* — **Ignore** (`danger`)
  - *(divider)* — admin-only: **Give voice**, **Kick** (each dim, with a mono `admin` tag right-aligned). Only render for admin/owner viewers.
- **Data/logic:** menu items gated by viewer role and target relationship (already-friend hides "Add friend", etc.).

### 11. ChannelBrowser (dialog)
620×588 modal, `side`, `radius+5`, modal shadow.
- **Header:** "Browse channels" (17px/700) + mono sub ("emberline · irc.emberline.chat · 142 rooms", room count in `ok`); close `✕`.
- **Search** row (38px, `bg`, `border`): "Filter by name or topic…".
- **Tabs:** **Official** and **Open rooms**, each with a mono count pill. Active tab: `bg` fill + `border`; count pill in `accentSoft`/`accent`.
  - *Official* = curated server channels. *Open rooms* = user-created public rooms. (Server returns these as two query types.)
- **Row** (single line, `align-items:center`, `border-bottom` hairline): `#` · name (mono 14px/600) · type chip (`official` = `accent` on `accentSoft`; `open` = `dim` outline) · spacer · **member count** in a fixed **62px right-aligned column** (mono, `ok` dot + number) · **action button** fixed **86×30** so all right edges align.
  - Button states: **Join** (accent fill) · **✓ Joined** (`ok` outline, non-interactive) · **⚲ Pinned** (mono, `faint` outline).
  - Rows have **no description** — the server doesn't return one on query. Keep rows compact/single-line.
- **Footer** (on `side2`, top border): label "Not listed? Join a hidden channel by name" + an input (`#` prefix, `accentMed` border) + **Join** button; helper note that hidden/invite-only rooms won't appear above.

### 12. Preferences (window)
748×560, two-pane: rail + pane. `side`.
- **Rail** (204px, `side2`): title "Preferences", nav items (General · Appearance · Highlights · Away & logs · Notifications · Network). Active item = `accentSoft` + `inset 2px 0 0 accent`, glyph in `accent`. Foot note: "Account & profile live on the server website ↗" (there are **no** account/profile settings in-app — read-only from server site).
- **Pane:** head (16px/700 + bottom border), scroll body.
- Panes to implement:
  - **Appearance:** **Accent color** swatch row (the 5 accents; selected shows a `2px bg` + `2px color` ring — all variants stay available), base theme segmented, message density (Compact/Cozy), timestamp format (`[12:04]`/`[12:04:33]`/off), 24-hour toggle, group-consecutive toggle, **show join/part/quit** toggle, message font size (S/M/L).
  - **Highlights:** highlight-on-nick toggle; a list of **rules** (word / nick / `/regex/`) each a mono chip with a type tag + remove `✕`; an add-rule input; "when highlighted" → play sound / flash tray / bump-to-top toggles; highlight tint swatch.
  - **Away & logs:** auto-away toggle, idle threshold segmented (5/10/20/30 min), away message input, clear-on-return toggle; **chat logs** → log-to-disk toggle, storage location (mono path), **export** (.txt/.html/.json segmented + Export button), retention (30d/90d/1yr/Forever).

**Preference control primitives** (reuse across panes):
- **Toggle:** 38×22 pill; on = `accent` track + `bg` knob at right; off = `mix(text,bg,.82)` track + `dim` knob at left.
- **Segmented:** inline-flex on `bg`+`border`, 3px pad; selected segment = `accent` fill, `bg` text; others `dim`.
- **Field row:** label (13.5px/600) + optional help (11.5px `faint`) on the left, control on the right, `border-bottom` hairline.
- **GroupLabel:** 10.5px/700 uppercase `faint`.
- **Text input:** 34px, `bg`, `border`, `radius`.
- **Swatch:** 26px circle; selected = double ring.

### 13. Auth — AppAccount (create / login)
Centered 400px card on a darkened (`mix(bg,#000,.35)`) backdrop. Card: `side`, `border`, 14px radius.
- Brand lockup (logo chip + "emberline" mono), title (22px/800), sub.
- **Fields** (44px, `bg`, `border`, focus = `accent` border + `0 0 0 3px accentSoft` ring): 
  - **Create:** Username (with "available ✓" in `ok`), Email, Password (dot mask + blinking accent caret + "show", plus a 4-segment strength meter), terms checkbox, **Create account** (full-width accent). *No display name, no home server — this is only the app login.*
  - **Login:** Username or email, Password (+ "Forgot?" link `accent`), "Keep me signed in" checkbox, **Log in**, then a note "Next: choose which server identity to connect with."
- **Checkbox:** 18px `accent` square with `bg` `✓`. **Inline links:** `accent`, 600. **Primary button:** 44px, `accent` fill, `bg` text, 700.

### 14. Auth — IdentityPicker (connect a server identity — the second login)
Same card style, 440px. This is where you pick which server identity to connect as (F-List "character select").
- **Account bar** (top, bottom border): app-account avatar + username + "…@… · app account" + "Sign out".
- Title "Choose an identity" + sub: identities live on the server, managed on the **website ↗** (inline link).
- **IdentityRow** (per identity): 38px avatar (per-identity color), name (14.5px/700) + optional `default` tag (`accent` on `accentSoft`), mono meta line (`server · role · presence`), trailing action.
  - **Connected:** "● Connected" (`ok` outline, nowrap). **Available:** "Connect" (accent fill). Connected row also gets `accentSoft` bg + `accentMed` border.
- **Add row:** dashed, `+` chip + "Add a server identity".

### 15. Landing page
1120px browser-framed marketing page on `bg`.
- **Nav:** brand lockup · text links (Channels/About/Status, `dim`) · "Log in" (ghost) + "Create account" (accent 36px button).
- **Hero** (2-col grid): left = eyebrow (mono `.14em` `accent`), h1 (46px/800, `#f4ecde`), lede (16px `dim`), CTAs (accent "Create account" + ghost "Log in ↗"), mono trust line. Right = a scaled-down live preview of the client (`transform: scale(.4)` inside a cropped, bordered frame).
- **Feature cards** (3-col): 34px `accentSoft` glyph tile (`accent`), title (15px/700), body (13px `dim`). Content = the three pillars: *Pin & auto-rejoin*, *Friends & bookmarks*, *Highlights & away*.

### 16. BrowserFrame (presentational only)
The traffic-lights + URL bar chrome around mocks is **presentation for the reference files only**. Don't build it into the real app.

---

## State model (per connected identity)
Each identity keeps an independent session object; switching the rail swaps the *active* one:
```
identity = {
  id, name, initial, color, presence,          // rail + self
  channels: [{ name, topic, descShort, descFull, pinned, muted, unread, mention }],
  dms:      [{ nick, presence, pinned, unread }],
  friends:  [{ nick, presence }],               // tier 1
  bookmarks:[{ nick, presence }],               // tier 2
  activeChannel,                                // drives ChannelHeader + MessageLog + MemberList
  members:  [{ nick, role, presence, status }],
  log:      [ ...rows ],
  ignored:  [nick]                              // hides their messages
}
```
- **Pin** = persisted membership; on connect, auto-rejoin pinned channels / reopen pinned DMs.
- **Friend vs Bookmark** = two independent lists; a person can be neither, one, or both.
- **Highlight rules** are per app-account (global), applied to every identity's log.
- **Ignore** is per identity.

## Interactions summary
- Rail click → switch identity (whole context swaps). Rail right-click → status/disconnect/reorder.
- NavItem click → open channel/DM. Right-click → pin/unpin, mute, leave, move to Friends/Bookmarks.
- Description **Show more/less** → expand inline.
- Member left-click → profile on website (new tab). Right-click → MemberContextMenu.
- Composer: type → live MD preview; Enter send / Shift+Enter newline; Markdown toggle.
- Channel browser: tab switch, Join, and join-hidden-by-name.
- Preferences: accent swatch changes theme live; toggles/segments persist to app-account settings.

## Animation
Keep it restrained: 0.15s ease on identity avatar radius (circle↔square) and toggles; blinking caret 1.1s step-end in inputs. No page transitions.
