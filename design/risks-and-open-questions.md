# Risks & Open Questions

## Risks

1. **ToS / credential custody — largely defused by bouncer-lite** (decisions.md §3). Passwords are never persisted; they transit our server and live in RAM only while sessions run — the same trust level as any hosted web client, and comfortably within the developer policy's "must not store … user's information" clause. Residual obligations: never log or serialize passwords, TLS everywhere, clear the vault on disconnect, disclose the model plainly in the UI/ToS. **This risk returns in full when at-rest credential storage is added** (the full bouncer model is an eventual goal, not a hypothetical) — decide then whether to consult F-List staff first (options: ask first / launch with disclosure and strong crypto / keep the feature invite-only).

2. **Ticket invalidation collisions.** Issuing a ticket invalidates all prior tickets account-wide. If a user simultaneously runs the official client (or any other tool), the two will fight over tickets. Handle IDN failures gracefully, back off, and surface "another client may be logged in with this account" to the user rather than hammering the ticket endpoint.

3. **No message IDs or server timestamps on MSG/PRI.** Ordering and dedupe are per-connection; timestamps are assigned by our server on receipt. Accepted via per-identity message storage — two identities' logs of the same channel may differ slightly. Document this.

4. **Under-documented protocol corners.** RTB payload variants, LIS batching shape, `icon_blacklist` semantics, exact flood thresholds. Defenses: zod `.passthrough()` on all inbound schemas, unknown-command swallow, treat runtime VAR values as authoritative (never hardcode), probe behaviors on the test server.

5. **Single-process session engine + restart cost.** v1 has one Node process owning all F-Chat sockets, and bouncer-lite makes restarts more expensive: every deploy/crash empties the credential vault and logs all characters out of F-Chat until users re-enter passwords. Mitigations: make re-auth painless (clear "re-enter password" UX, one unlock reconnects all of an account's identities — M2), deploy infrequently/off-peak, alert on crash loops. If restart churn becomes a real pain point, that's the trigger to revisit opt-in at-rest credentials (risk 1). Sharding path (sessions partitioned by F-List account across workers) stays documented behind interfaces.

6. **Message table growth.** Per-identity duplication multiplies volume. Pressure valves: `messages (conversation_id, id DESC)` index from day one, monthly range partitioning + user-configurable retention in M7; schema designed for both now.

7. **Shared egress IP — defused by the single-tenant pivot** (2026-07-16, decisions.md §2). All F-Chat connections originate from the VPS and the protocol has no WEBIRC-style mechanism to declare the end-user's real IP — with *multiple users* that meant shared ban fate and false household-linking under F-List's IP-based abuse management, which no code could fix and which is why EmberChat is now self-hostable software with admin-only instances rather than a managed service. Single-tenant, the picture F-List sees is truthful: one person's accounts from one stable IP (arguably cleaner than a residential connection). Residual: the instance IP is a datacenter IP, which some services treat with suspicion — no evidence F-List does; note it in the self-host docs.

## Open questions (resolve early)

- Does F-List offer any OAuth-like alternative to password custody? (Almost certainly not — ask when requesting test-server access. Less pressing under bouncer-lite, but it would remove the residual transit/RAM exposure too.)
- When opt-in at-rest credentials are built (eventual goal, scheduled under M7): consult F-List staff first, or launch on disclosure + strong crypto? Decide before building.
- Exact expected rendering/etiquette for LRP ads and RLL results in third-party clients.
- How fresh are ORS room counts, and how long is it acceptable to cache the channel directory?
- Test-server access turnaround time — file the helpdesk ticket at project start.
- **Final product name + domain** — "emberchat" is a working title (decisions.md §5). Needed before public launch: domain registration, Brevo sender domain/DKIM, and the `cname` client identification.

## Resolved

- ~~Email provider for M7~~ → **Brevo transactional SMTP** (2026-07-12) → **mooted 2026-07-16**: the tenancy pivot (decisions.md §2) disabled registration, so v1.0 has no email flows; Brevo remains the answer if email ever returns.
- ~~Tenancy: managed service vs. self-hosted~~ → **self-hostable software, admin-only instances** — F-List's IP/household-based abuse management is structurally incompatible with a multi-tenant bouncer (risk 7). Eventual mainstream path: standalone desktop client (Tauri/Electron) with the session engine as a shared library; design pass in M7. (2026-07-16)
- ~~Hosting target~~ → **VPS with docker-compose**; ~~expected scale~~ → **realistically 1–2 users, but architecture designed scalable from day one** ("scalability lives in the architecture, cost lives in the ops") — see `decisions.md` §5. (2026-07-12)
- ~~Launch-blocking credential custody / F-List outreach~~ → defused by **bouncer-lite** (`decisions.md` §3); returns only with opt-in at-rest storage. (2026-07-12)
