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
- [x] 9. Web auth flows + theme system
- [x] 10. App shell + live chat (full slice E2E)
- [ ] 11. Docker + supervised test-server pass — **Docker/compose/smoke done**; remaining: one supervised manual pass against the real F-Chat test server (blocked on the helpdesk-ticket standing to-do)

## Standing to-dos (not milestone-gated)

- [ ] Decide final product name + register domain (working title "emberchat"; gates Brevo DKIM and public launch — see `decisions.md` §5)

- [ ] File F-List helpdesk ticket for **test-server access** (lead time; needed by M1 step 11)
- [ ] **Feature-parity audit vs. the official F-Chat 1.0 client** (source: https://github.com/f-list/chat3client) before declaring v1.0 — enumerate its features and check each is covered by a milestone. Known items already spotted: friend/bookmark actions via JSON API (added to M6), FKS character search, RTB note notifications. Natural timing: during M6.
- [ ] **Before building opt-in at-rest credential storage** (eventual goal, under M7): decide on F-List outreach vs. disclosure-only (see `risks-and-open-questions.md`)
- [ ] **Server hardening backlog** (deferred from the step-6 audit; natural timing M7): periodic cleanup of expired `auth_sessions` rows + per-user session cap; `@fastify/helmet` response headers; register endpoint reveals email/username existence (fold into email-verification flow); rate-gate uses `Date.now()` (not NTP-step-proof — switch to a monotonic clock if it ever matters); session-state ICH/COL/CDS assume the JCH echo arrives first (matches sim/docs/official client — make create-on-miss if the live server ever disagrees)

- [ ] **Post-step-9 audit backlog** (deferred from the 2026-07-13 audit; HIGHs/most MEDIUMs were fixed immediately): shard the HistorySink write queue per identity before M2 always-on scale (single global chain is a throughput ceiling); push the unread-count 99-cap into SQL (LATERAL + LIMIT) instead of full COUNT per conversation at snapshot; cross-tab refresh coordination is best-effort (localStorage re-read + storage event) — consider a BroadcastChannel leader or server-side reuse grace window (M7); IdentityPicker add-flow dead-ends with multiple F-List accounts (needs an account chooser — natural timing M3); `register()` persists the refresh token without a "keep me signed in" choice; gateway catchup only replays cursor'd conversations — new conversations rely on REST backfill (decide in M2); hello-timeout and slow-consumer closes untested (need injectable timeouts); E2E ports are fixed (concurrent local runs collide).

- [ ] **fchat-sim fidelity backlog** (deferred from the step-3 review): NPCs are online in LIS but PRI to them returns ERR 6 (make them accept-and-drop or document); sim tickets never expire (real: 30 min — relevant to M1 step 5); add a guard test for the schema-table invariant behind the `as ServerCommand`/`as ClientCommand` casts (every schema is either always-bare or never-bare)

## Log

> PR references up to #13 predate this repository — the project history was
> rewritten and re-homed on 2026-07-12; those numbers refer to the retired
> original repo and do not correspond to PRs here.

| Date | Change |
|---|---|
| 2026-07-13 | Working title renamed **Emberline → EmberChat** (repo-wide sweep: `@emberchat/*` package scope, config defaults, env prefix `EMBERCHAT_API_PROXY`, compose/db identifiers, docs and mockups; `eb.`/`--eb-` prefixes and the local folder name unchanged). Final-name/domain standing to-do stays open — the `emberchat.chat` domains in design files remain placeholders. Full gate + docker smoke green under the new name. |
| 2026-07-13 | M1 step 11, Docker half done: multi-stage Dockerfile (build → filtered prod-deps → slim runtime as `node`; separate `sim` target), production `docker-compose.yml` (postgres + server with healthchecks; fchat-sim under an opt-in `sim` profile), root `.env.example`. Server gained `WEB_DIST` static mode: one Fastify serves API + gateway + built web app, SPA fallback, `window.__CONFIG__` injected into index.html at boot (branding stays runtime config), hashed assets cached immutable (+5 tests, server 103). `pnpm smoke` builds the image, boots the stack with the sim profile, and walks the slice end-to-end (statics/config injection, register, ticket vaulting against sim, identity, gateway session to "online") — green locally. Remaining for step 11: the supervised pass against the real F-Chat test server (helpdesk ticket still open). |
| 2026-07-13 | M1 step 10 (app shell + live chat) done: gateway browser client (hello/resume cursors, cmd acks by request id, read acks, keepalive, reconnect backoff with one-refresh-then-retry on 4401), pure dispatch layer into Zustand stores (sessions: idempotent volatile-event semantics incl. the ICH/CDS-beats-conversation-row join race; messages: windowed buffers + REST backfill/scroll-up pagination; ui), AppShell grid + Sidebar (join-by-name, new-DM, MeBar) + ChannelHeader + virtualized MessageLog (@tanstack/react-virtual, date dividers, stick-to-bottom, anchor-preserving infinite scroll up) + Composer (Enter-to-send raw text) + grouped MemberList with lazy avatars; deep links preserved through the login redirect. Full-slice Playwright E2E: connect → join → chat both ways against a raw sim client → live member updates → PMs with unread badge → 70-message seed → reload (session stays online) → scroll-up history. Web 28 unit tests, E2E 5. |
| 2026-07-12 | Plan finalized; all milestones defined, none started. |
| 2026-07-12 | Credential model revised to **bouncer-lite**: session-only in-memory credentials, no at-rest storage; server restart requires password re-entry. See `decisions.md` §3. |
| 2026-07-12 | Deployment context settled: VPS + docker-compose, friends-first scale (~tens), Brevo SMTP for M7 email. See `decisions.md` §5. |
| 2026-07-12 | M1 started. Step 1 (repo scaffold) done: pnpm workspaces + Turborepo, 6 packages, ESLint flat config + Prettier, Vitest, GitHub Actions CI, `main` branch protection. TS note: packages build with native TS 7; root pins TS 6.0 for typescript-eslint until TS 7.1 ships the JS API. |
| 2026-07-12 | M1 step 2 (`fchat-protocol`) done (PR #2): frame codec, zod schemas for the 20 core server commands + client counterparts, ServerVars/applyVar, error codes. Lenient parsing — anything unknown/malformed returns `{ cmd, raw }`. `parseClientCommand` is ready for fchat-sim (step 3). |
| 2026-07-13 | Post-step-9 audit (coverage + three adversarial reviews: gateway, web app, history/identities) and fix pass: gateway connections re-verify their auth session per frame and on a 30s idle interval (logout now cuts live sockets, not just REST); identity deletion drops gateway ownership caches and `session.connect` re-checks uncached (no zombie F-Chat sessions); ws `maxPayload` 128 KiB + 600-frames/min quota + pm.open name cap/charset + resume-map bounds; RateGate backlog capped at 32/class (rejects instead of queueing hours of sends); per-identity conversation cap; PM threads merge case-insensitively (partial unique indexes migration); read-cursor acks clamped to the conversation's real max; web refresh rotation single-flighted, network errors no longer destroy persisted sessions, cross-tab token adoption; E2E teardown on partial failure + reload-persistence test. +15 tests (server 98, web 12). Deferred LOWs → standing to-dos. |
| 2026-07-12 | M1 step 9 (web auth flows + theme) done (PR #5): identities CRUD REST (create validates the character against the account's live F-List list; delete stops the session first); web theme system with exact COMPONENTS.md tokens as `--eb-*` custom properties (mix() unit-tested against the documented Dusk derivations, Moss Green warn override), runtime branding config, typed REST client with refresh rotation, Zustand auth store ("keep me signed in" gates persistence), Landing/Register/Login/IdentityPicker screens, real F-List avatars with initial-on-color fallback (URL verified against chat3client `avatarURL()` — lowercase, safe-charset guard). Playwright E2E harness (testcontainers Postgres + sim + built server child process + vite proxy) with the register→login→characters-with-avatars gate; CI runs it after build/test/lint. Server 91 tests, web 8, E2E 3. |
| 2026-07-12 | M1 step 8 (gateway) done (PR #3): `packages/protocol` gateway contract (zod client frames, typed server frames, close codes); GatewayHub fan-out — durable events off the history sink's new bus (message.new carries the persisted messages.id, consistent with catchup), volatile events translated from the session bus with replace-safe detach; GatewayConnection hello handshake (JWT + live auth-session check), sub → snapshot → catchup-from-cursors → deduped live stream, cmd acks by request id, non-stalling msg.send, slow-consumer disconnect, cross-tab read-cursor convergence. 9 integration tests over real sockets incl. the two-client identical-fan-out gate; server suite at 87. |
| 2026-07-12 | M1 step 7 (history sink + pagination) done (Ember PR #1): HistorySink off the session event bus via SessionRegistry.onSessionStarted — persists channel MSG/PM/channel-SYS and our own sends (new `sent` session event, sentByUs flag) through a serial queue so message ids are the resume cursor; conversation find-or-create on the identity/kind/target unique index; joined flag follows own JCH/LCH. REST: conversation list + `messages?before=<id>&limit=` cursor pagination (ascending pages, hasMore, ownership-scoped). 6 integration tests through the production path. |
| 2026-07-12 | Repo re-homed: history rewritten to the project identity and moved to a fresh repository; PR numbering restarts at #1. |
| 2026-07-12 | Post-step-6 audit (coverage + two adversarial reviews) and fix pass: ws handshake timeout (session could hang in `connecting` forever), TRUST_PROXY config (rate limits collapsed to one bucket behind a proxy), identify-rejection cap (ERR 4 loop churned tickets account-wide), kick removes channel from rejoin set, sends reject instead of false-success on a dying socket, access tokens die with their session (sid checked on authenticate), placeholder AUTH_SECRET refused at boot, first-attempt backoff jitter, unhandled-rejection backstop on connect. SessionRegistry test suite added (was the one coverage hole). Remaining low-priority items → standing to-dos. |
| 2026-07-12 | M1 step 6 (session engine v1) done (PR #11): FchatSession state machine (IDN-first, PIN ≤1/10s, ~90s watchdog, jittered reconnect backoff floored at 10s/capped 5 min, channel rejoin, bad-ticket refresh, auth-failure stop), SessionState roster, RateGate (live msg_flood + 100ms margin — server measures the window at receive time), SessionEventBus, SessionRegistry as `app.sessions`. 25 tests incl. sim-scripted watchdog/backoff-floor/PIN-discipline scenarios. |
| 2026-07-12 | M1 step 5 (flist-accounts) done (PR #9): FlistApiClient (1 req/s throttle), per-account TicketManager (25-min cache, coalesced fetches, invalidate hook), in-memory CredentialVault with serialization redaction, add/unlock/characters/delete routes. Integration tests incl. restart→423→unlock flow and log-capture proof that passwords never hit logs. |
| 2026-07-12 | M1 step 4 (DB + auth) done (PR #7): docker-compose.dev.yml (Postgres 18), Drizzle schema (all step-4 tables + outbox_messages, uuidv7 ids, committed migration, migrate-on-boot), Fastify register/login/refresh/logout + /me (argon2id, hashed refresh tokens with single-UPDATE rotation, per-route rate limits). 11 testcontainers integration tests; CI runs them via docker on the runner. |
| 2026-07-12 | M1 step 3 (`fchat-sim`) done (PR #4): ws + fake getApiTicket.php on one server; scripted handshake, fake world with NPCs, MSG/PRI relay (no sender echo), PIN discipline, account-wide ticket invalidation, misbehavior controls for step 6. Manual wscat-style walkthrough verified. Protocol gained CON, serializeServerCommand, flist-api ticket types. |
