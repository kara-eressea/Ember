# Milestone 1 — Thin Vertical Slice

**Goal:** app login → connect one F-List character identity → join channels, send/receive channel messages and PMs, live member list — with history persisted from day one. Sessions run on demand this milestone (they stop when the last browser detaches); always-online is Milestone 2.

**Depends on:** nothing (first milestone).

Steps are ordered and individually verifiable. Do not start a step before the previous one is green.

## Steps

1. **Repo scaffold** — pnpm workspaces, Turborepo, `tsconfig.base.json`, ESLint flat config, Vitest; all packages exist and build empty. CI from day one: GitHub Actions running `pnpm build && pnpm test && pnpm lint` on push/PR; then enable `main` branch protection requiring the CI check (workflow conventions: decisions.md §7).
   ✔ `pnpm build` green locally and in CI; a test PR shows the required check gating merge.

2. **`fchat-protocol` codec + core command schemas** — frame codec plus zod schemas for at least: IDN, HLO, VAR, PIN, ERR, SYS, LIS, NLN, FLN, STA, CHA, ORS, JCH, LCH, ICH, COL, CDS, MSG, PRI, TPN.
   ✔ Unit tests round-tripping sample frames from the protocol docs (including bare `PIN`, UTF-8, malformed frames, unknown commands returning `{cmd, raw}`).

3. **`fchat-sim`** — ws server speaking the subset: scripted login handshake (HLO/IDN/VAR/CON/LIS), fake channels/users, echoes MSG/PRI, emits NLN/FLN/JCH/LCH, PIN cycle, plus a fake `getApiTicket.php` endpoint and configurable misbehavior (disconnects, ERR, unknown commands).
   ✔ Connect with `wscat` and walk through the handshake by hand.

4. **DB + auth** — `docker-compose.dev.yml` (Postgres), Drizzle schema (users, auth_sessions, flist_accounts, identities, conversations, messages, ignores), Fastify register/login/refresh (argon2id, refresh-token rotation), API rate limiting.
   ✔ Integration tests against Postgres.

5. **flist-accounts + TicketManager** — in-memory credential vault (no persistence — decisions.md §3), add-account flow that verifies the password via one ticket fetch (pointed at fchat-sim's fake endpoint in dev), `unlock` endpoint for post-restart re-entry, character-list proxy.
   ✔ Unit tests: mutex coalescing, expiry refresh, vault cleared on disconnect, password never in logs/serialized state.

6. **Session engine v1** — `FchatSession` state machine against fchat-sim: connect/IDN/PIN, VAR capture, roster state from LIS/NLN/FLN/ICH/JCH/LCH/COL/CDS, MSG/PRI intake, outbound MSG/PRI/JCH/LCH through rate-gate, jittered backoff reconnect floored at 10s.
   ✔ Integration tests scripting sim scenarios (including the backoff floor).

7. **History sink** — persist MSG/PRI/SYS to `messages`/`conversations`; REST pagination endpoint (`?before=<msgId>&limit=50`).
   ✔ Cursor-pagination tests.

8. **Gateway** — `/gateway` WS with hello/sub/snapshot/event/cmd/ack.
   ✔ Integration test: two mock clients subscribed to the same identity receive identical fan-out.

9. **Web app auth flows** — theme system + tokens (exact `mix()` derivations), Landing/Login/Register/IdentityPicker screens against REST. IdentityPicker rows show real F-List avatars with initial-on-color fallback (decisions.md §6); verify the avatar URL pattern against chat3client source here.
   ✔ Playwright: register → login → see character list with avatars.

10. **App shell + live chat** — AppShell grid, Sidebar, ChannelHeader, virtualized MessageLog, MemberList (lazy-loaded real avatars + fallback, decisions.md §6), plain-text Composer (raw text/BBCode passthrough this milestone; Markdown is M4), gateway socket + stores; join channel, send & receive channel messages and PMs, live member list updates, history infinite scroll up.
    ✔ Playwright E2E: full slice against server + sim.

11. **Docker** — multi-stage server image serving the built web statics (`@fastify/static`), `docker-compose.yml` with Postgres, smoke script.
    ✔ `docker compose up` → usable app against sim; then one supervised manual pass against the real F-Chat **test server**.

> **Lead-time item:** file the F-List helpdesk ticket requesting test-server access at milestone start — it gates nothing until step 11 but has unknown turnaround.
