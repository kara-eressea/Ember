# Milestone 2 — Always-Online Bouncer + Catch-up

**Goal:** the headline feature — sessions keep running when no browser is attached, and reconnecting clients catch up on everything they missed.

**Depends on:** Milestone 1 (session engine, history sink, gateway).

## Scope

- Sessions persist across browser detach; `session.disconnect` becomes an explicit user action rather than an implicit consequence of closing the tab. Auto-reconnect through F-Chat drops (re-ticket from the in-memory vault, rejoin pinned channels) works for as long as the server process lives.
- **No startup resume** (bouncer-lite — decisions.md §3): a server restart empties the credential vault, so sessions cannot resume on boot. Instead: clean shutdown persists enough state that, after restart, the client shows exactly which identities need their password re-entered ("re-enter password to reconnect"), and `unlock` + `auto_connect` brings all of an account's identities back in one step.
- **Resume cursors + catch-up:** gateway `hello.resume` conveys per-conversation `messages.id` cursors; server replays `catchup` batches past each cursor, then switches to live events.
- **Unread/mention counters** computed server-side per conversation (snapshot-time count queries against `last_read_message_id`), surfaced in `snapshot` and updated by `ack`.
- **"New since last visit" divider** in the message log, driven by the read cursor at attach time.
- **Retention job hook** (`history/retention.ts`) — default policy "Forever", but the job scaffold and config exist now so M7 policies plug in.

## Verification

- Integration: kill the browser connection, keep sim traffic flowing, reattach → catchup replays exactly the missed persisted messages, then live events; no gaps, no duplicates (cursor semantics).
- Integration: sim drops the F-Chat connection → session re-tickets from the vault, reconnects after backoff, rejoins pinned channels — no user interaction.
- Integration: restart the server process → vault empty, affected identities reported as needing re-auth; one `unlock` reconnects all `auto_connect` identities on the account.
- E2E: two devices, one reads (acks) — unread badges converge on both.
