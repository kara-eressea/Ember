# Milestone 5 — Highlights + Preferences

**Goal:** granular highlight rules and the full Preferences window from the design files.

**Depends on:** Milestone 3 (highlight rules are per app-account and apply across every identity's log) and Milestone 4 (rendering pipeline).

## Scope

- **Highlight rules:** CRUD for word / nick / `/regex/` rules (`highlight_rules` table, `GET/PUT /api/highlight-rules`). Matching happens **server-side at persist time** — the stored mention flag feeds unread/mention badges everywhere (rail, sidebar, snapshots) without re-scanning history. Highlight-on-own-nick toggle. "When highlighted" actions: play sound, flash tray/title, bump conversation to top, highlight tint.
- **Preferences window** per `ui/COMPONENTS.md` §12 (748×560, rail + pane), persisted in `user_preferences.prefs` jsonb:
  - **Appearance:** accent switcher (all 5 accents stay available; live `applyTheme()`), base theme, message density, timestamp format, 24-hour toggle, group-consecutive, show join/part/quit, font size, **eicon display mode** (Inline / Name only with hover-preview) and **animate eicons toggle** (off = frozen first frame) — decisions.md §8.
  - **Highlights:** the rules UI above.
  - **Away & logs:** auto-away toggle + idle threshold + away message + clear-on-return (drives `STA` idle/away from client idle detection); chat-log visibility and **export** (.txt/.html/.json) — this satisfies the developer-policy requirement that log location is known and accessible to the user.
  - **Notifications:** desktop notifications on mention/PM (per-identity and per-conversation mute overrides).
- Sidebar/nav polish that depends on prefs: hide join/part/quit SystemLines, compact/cozy density.
- **Eicon favorites**: per-user favorites list (in `user_preferences`) surfaced in the composer ☺ picker for quick insert (decisions.md §8).

## Verification

- Unit: rule matching (word boundaries, nick exact, regex with catastrophic-backtracking guard/timeout); prefs schema migration path.
- Integration: message matching a rule persists with mention flag → snapshot badge counts reflect it for a detached identity.
- E2E: add a regex rule, receive a matching message → row highlighted, badge bumps, notification fires; accent switch persists across reload and devices.
