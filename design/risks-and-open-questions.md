# Risks & Open Questions

## Risks

1. **ToS / credential custody — largely defused by bouncer-lite** (decisions.md §3). Passwords are never persisted; they transit our server and live in RAM only while sessions run — the same trust level as any hosted web client, and comfortably within the developer policy's "must not store … user's information" clause. Residual obligations: never log or serialize passwords, TLS everywhere, clear the vault on disconnect, disclose the model plainly in the UI/ToS. **This risk returns in full when at-rest credential storage is added** (the full bouncer model is an eventual goal, not a hypothetical) — decide then whether to consult F-List staff first (options: ask first / launch with disclosure and strong crypto / keep the feature invite-only).

2. **Ticket invalidation collisions.** Issuing a ticket invalidates all prior tickets account-wide. If a user simultaneously runs the official client (or any other tool), the two will fight over tickets. Handle IDN failures gracefully, back off, and surface "another client may be logged in with this account" to the user rather than hammering the ticket endpoint.

3. **No message IDs or server timestamps on MSG/PRI.** Ordering and dedupe are per-connection; timestamps are assigned by our server on receipt. Accepted via per-identity message storage — two identities' logs of the same channel may differ slightly. Document this.

4. **Under-documented protocol corners.** RTB payload variants, LIS batching shape, `icon_blacklist` semantics, exact flood thresholds. Defenses: zod `.passthrough()` on all inbound schemas, unknown-command swallow, treat runtime VAR values as authoritative (never hardcode), probe behaviors on the test server.

5. **Single-process session engine + restart cost.** v1 has one Node process owning all F-Chat sockets, and bouncer-lite makes restarts more expensive: every deploy/crash empties the credential vault and logs all characters out of F-Chat until users re-enter passwords. Mitigations: make re-auth painless (clear "re-enter password" UX, one unlock reconnects all of an account's identities — M2), deploy infrequently/off-peak, alert on crash loops. If restart churn becomes a real pain point, that's the trigger to revisit opt-in at-rest credentials (risk 1). Sharding path (sessions partitioned by F-List account across workers) stays documented behind interfaces.

6. **Message table growth.** Per-identity duplication multiplies volume. Pressure valves: `messages (conversation_id, id DESC)` index from day one, monthly range partitioning + user-configurable retention in M7; schema designed for both now.

7. **Shared egress IP.** All F-Chat connections and ticket requests originate from the VPS — the protocol has no WEBIRC-style mechanism to declare the end-user's real IP, so forwarding it is impossible, not just unimplemented. Consequences: (a) **shared fate** — an F-List IP ban or IP-level rate limit triggered by one user hits every user on the instance, which raises the stakes on the M7 abuse controls (our own moderation is what protects the shared IP); (b) **visibility** — many accounts logging in from one datacenter IP is a conspicuous pattern F-List staff may notice and investigate on their own, which strengthens the case for proactive disclosure (see the outreach open question). Same trade-off as every IRC bouncer; accepted, not fixable.

## Open questions (resolve early)

- Does F-List offer any OAuth-like alternative to password custody? (Almost certainly not — ask when requesting test-server access. Less pressing under bouncer-lite, but it would remove the residual transit/RAM exposure too.)
- When opt-in at-rest credentials are built (eventual goal, scheduled under M7): consult F-List staff first, or launch on disclosure + strong crypto? Decide before building.
- Exact expected rendering/etiquette for LRP ads and RLL results in third-party clients.
- How fresh are ORS room counts, and how long is it acceptable to cache the channel directory?
- Test-server access turnaround time — file the helpdesk ticket at project start.
- **Final product name + domain** — "emberline" is a working title (decisions.md §5). Needed before public launch: domain registration, Brevo sender domain/DKIM, and the `cname` client identification.

## Resolved

- ~~Email provider for M7~~ → **Brevo transactional SMTP** (existing account); mailer abstracted behind SMTP config, Mailpit in dev. (2026-07-12)
- ~~Hosting target~~ → **VPS with docker-compose**; ~~expected scale~~ → **realistically 1–2 users, but architecture designed scalable from day one** ("scalability lives in the architecture, cost lives in the ops") — see `decisions.md` §5. (2026-07-12)
- ~~Launch-blocking credential custody / F-List outreach~~ → defused by **bouncer-lite** (`decisions.md` §3); returns only with opt-in at-rest storage. (2026-07-12)
