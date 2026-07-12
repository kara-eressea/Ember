# Milestones — Status Tracker

Single source of truth for milestone progress. Update the status here when work starts/finishes; details live in the individual `milestone-*.md` files.

Statuses: `not started` · `in progress` · `done` · `blocked`

| # | Milestone | Status | Depends on | Details |
|---|---|---|---|---|
| 1 | Thin vertical slice | in progress | — | [milestone-1-thin-vertical-slice.md](milestone-1-thin-vertical-slice.md) |
| 2 | Always-online bouncer + catch-up | not started | M1 | [milestone-2-always-online-bouncer.md](milestone-2-always-online-bouncer.md) |
| 3 | Multi-identity | not started | M2 | [milestone-3-multi-identity.md](milestone-3-multi-identity.md) |
| 4 | Markdown layer + delayed send | not started | M1 (parallel with M3) | [milestone-4-markdown-delayed-send.md](milestone-4-markdown-delayed-send.md) |
| 5 | Highlights + preferences | not started | M3, M4 | [milestone-5-highlights-preferences.md](milestone-5-highlights-preferences.md) |
| 6 | Channel browser + channel ops | not started | M1 (benefits from M3) | [milestone-6-channel-browser-ops.md](milestone-6-channel-browser-ops.md) |
| 7 | Public-service hardening | not started | M1–M2 min., realistically M1–M6 | [milestone-7-public-service-hardening.md](milestone-7-public-service-hardening.md) |
| 8 | Service admin tooling + Electron | not started | M7 (Electron only needs M1) | [milestone-8-admin-tooling-electron.md](milestone-8-admin-tooling-electron.md) |

## Milestone 1 step checklist

Mirrors the ordered steps in [milestone-1-thin-vertical-slice.md](milestone-1-thin-vertical-slice.md); tick as each step's verification passes.

- [x] 1. Repo scaffold (`pnpm build` green)
- [x] 2. `fchat-protocol` codec + core command schemas
- [x] 3. `fchat-sim` mock server
- [x] 4. Postgres + Drizzle schema + Fastify auth
- [x] 5. flist-accounts + TicketManager + in-memory credential vault
- [x] 6. Session engine v1 against sim
- [x] 7. History sink + REST pagination
- [x] 8. Gateway (hello/sub/snapshot/event/cmd/ack)
- [ ] 9. Web auth flows + theme system
- [ ] 10. App shell + live chat (full slice E2E)
- [ ] 11. Docker + supervised test-server pass

## Standing to-dos (not milestone-gated)

- [ ] Decide final product name + register domain (working title "emberline"; gates Brevo DKIM and public launch — see `decisions.md` §5)

- [ ] File F-List helpdesk ticket for **test-server access** (lead time; needed by M1 step 11)
- [ ] **Feature-parity audit vs. the official F-Chat 1.0 client** (source: https://github.com/f-list/chat3client) before declaring v1.0 — enumerate its features and check each is covered by a milestone. Known items already spotted: friend/bookmark actions via JSON API (added to M6), FKS character search, RTB note notifications. Natural timing: during M6.
- [ ] **Before building opt-in at-rest credential storage** (eventual goal, under M7): decide on F-List outreach vs. disclosure-only (see `risks-and-open-questions.md`)
- [ ] **Server hardening backlog** (deferred from the step-6 audit; natural timing M7): periodic cleanup of expired `auth_sessions` rows + per-user session cap; `@fastify/helmet` response headers; register endpoint reveals email/username existence (fold into email-verification flow); rate-gate uses `Date.now()` (not NTP-step-proof — switch to a monotonic clock if it ever matters); session-state ICH/COL/CDS assume the JCH echo arrives first (matches sim/docs/official client — make create-on-miss if the live server ever disagrees)

- [ ] **fchat-sim fidelity backlog** (deferred from the step-3 review): NPCs are online in LIS but PRI to them returns ERR 6 (make them accept-and-drop or document); sim tickets never expire (real: 30 min — relevant to M1 step 5); add a guard test for the schema-table invariant behind the `as ServerCommand`/`as ClientCommand` casts (every schema is either always-bare or never-bare)

## Log

> PR references up to #13 predate this repository — the project history was
> rewritten and re-homed on 2026-07-12; those numbers refer to the retired
> original repo and do not correspond to PRs here.

| Date | Change |
|---|---|
| 2026-07-12 | Plan finalized; all milestones defined, none started. |
| 2026-07-12 | Credential model revised to **bouncer-lite**: session-only in-memory credentials, no at-rest storage; server restart requires password re-entry. See `decisions.md` §3. |
| 2026-07-12 | Deployment context settled: VPS + docker-compose, friends-first scale (~tens), Brevo SMTP for M7 email. See `decisions.md` §5. |
| 2026-07-12 | M1 started. Step 1 (repo scaffold) done: pnpm workspaces + Turborepo, 6 packages, ESLint flat config + Prettier, Vitest, GitHub Actions CI, `main` branch protection. TS note: packages build with native TS 7; root pins TS 6.0 for typescript-eslint until TS 7.1 ships the JS API. |
| 2026-07-12 | M1 step 2 (`fchat-protocol`) done (PR #2): frame codec, zod schemas for the 20 core server commands + client counterparts, ServerVars/applyVar, error codes. Lenient parsing — anything unknown/malformed returns `{ cmd, raw }`. `parseClientCommand` is ready for fchat-sim (step 3). |
| 2026-07-12 | M1 step 8 (gateway) done (PR #3): `packages/protocol` gateway contract (zod client frames, typed server frames, close codes); GatewayHub fan-out — durable events off the history sink's new bus (message.new carries the persisted messages.id, consistent with catchup), volatile events translated from the session bus with replace-safe detach; GatewayConnection hello handshake (JWT + live auth-session check), sub → snapshot → catchup-from-cursors → deduped live stream, cmd acks by request id, non-stalling msg.send, slow-consumer disconnect, cross-tab read-cursor convergence. 9 integration tests over real sockets incl. the two-client identical-fan-out gate; server suite at 87. |
| 2026-07-12 | M1 step 7 (history sink + pagination) done (Ember PR #1): HistorySink off the session event bus via SessionRegistry.onSessionStarted — persists channel MSG/PM/channel-SYS and our own sends (new `sent` session event, sentByUs flag) through a serial queue so message ids are the resume cursor; conversation find-or-create on the identity/kind/target unique index; joined flag follows own JCH/LCH. REST: conversation list + `messages?before=<id>&limit=` cursor pagination (ascending pages, hasMore, ownership-scoped). 6 integration tests through the production path. |
| 2026-07-12 | Repo re-homed: history rewritten to the project identity and moved to a fresh repository; PR numbering restarts at #1. |
| 2026-07-12 | Post-step-6 audit (coverage + two adversarial reviews) and fix pass: ws handshake timeout (session could hang in `connecting` forever), TRUST_PROXY config (rate limits collapsed to one bucket behind a proxy), identify-rejection cap (ERR 4 loop churned tickets account-wide), kick removes channel from rejoin set, sends reject instead of false-success on a dying socket, access tokens die with their session (sid checked on authenticate), placeholder AUTH_SECRET refused at boot, first-attempt backoff jitter, unhandled-rejection backstop on connect. SessionRegistry test suite added (was the one coverage hole). Remaining low-priority items → standing to-dos. |
| 2026-07-12 | M1 step 6 (session engine v1) done (PR #11): FchatSession state machine (IDN-first, PIN ≤1/10s, ~90s watchdog, jittered reconnect backoff floored at 10s/capped 5 min, channel rejoin, bad-ticket refresh, auth-failure stop), SessionState roster, RateGate (live msg_flood + 100ms margin — server measures the window at receive time), SessionEventBus, SessionRegistry as `app.sessions`. 25 tests incl. sim-scripted watchdog/backoff-floor/PIN-discipline scenarios. |
| 2026-07-12 | M1 step 5 (flist-accounts) done (PR #9): FlistApiClient (1 req/s throttle), per-account TicketManager (25-min cache, coalesced fetches, invalidate hook), in-memory CredentialVault with serialization redaction, add/unlock/characters/delete routes. Integration tests incl. restart→423→unlock flow and log-capture proof that passwords never hit logs. |
| 2026-07-12 | M1 step 4 (DB + auth) done (PR #7): docker-compose.dev.yml (Postgres 18), Drizzle schema (all step-4 tables + outbox_messages, uuidv7 ids, committed migration, migrate-on-boot), Fastify register/login/refresh/logout + /me (argon2id, hashed refresh tokens with single-UPDATE rotation, per-route rate limits). 11 testcontainers integration tests; CI runs them via docker on the runner. |
| 2026-07-12 | M1 step 3 (`fchat-sim`) done (PR #4): ws + fake getApiTicket.php on one server; scripted handshake, fake world with NPCs, MSG/PRI relay (no sender echo), PIN discipline, account-wide ticket invalidation, misbehavior controls for step 6. Manual wscat-style walkthrough verified. Protocol gained CON, serializeServerCommand, flist-api ticket types. |
