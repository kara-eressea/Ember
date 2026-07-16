# Milestone 7 — Self-Host Hardening

**Goal:** everything required to responsibly run a personal EmberChat instance on the public internet, and to make self-hosting by others excellent — plus the design pass for the standalone desktop client. Rescoped 2026-07-16 from "public-service hardening" when the tenancy decision changed (decisions.md §2): EmberChat is self-hostable software with admin-only instances, not a managed service.

**Depends on:** Milestones 1–2 minimum; realistically follows 1–6.

## Scope

- **Admin-only accounts:** registration endpoint disabled (config-gated off by default); an admin CLI (or bootstrap env mechanism) creates accounts and resets passwords. No email flows in v1.0 — the Brevo/mailer plan is mooted (decisions.md §5). Removing the open-registration path also closes the register-endpoint enumeration item from the server hardening backlog.
- **Exposure hardening** (the instance is internet-reachable even with one user): account lockout/backoff on failed logins, per-route rate limits kept honest, `@fastify/helmet`-style headers, WS origin checks, CSRF posture review, secure cookie flags, dependency audit, secrets-handling review. Fold in the standing **server hardening backlog** (expired `auth_sessions` cleanup + session cap, gateway connect/hello rate-gate, monotonic-clock note).
- **Self-host story:** production docker-compose (server + web + Postgres, TLS via reverse proxy), a written deploy guide (`docs/self-hosting.md`: prerequisites, env reference, reverse-proxy examples, upgrade path), automated Postgres backups + documented restore drill, `.env.example` kept exhaustive.
- **Staff reporting (SFC):** the "Alert Staff" flow from the official client — report a user/channel to F-List staff with recent log context attached (M6 parity-audit decision; tenancy-independent).
- **Retention & logs:** extend the `RETENTION_POLICY` enum beyond `forever` (30d/90d/1yr/Forever) enforced by the M2 retention job; streaming log export (M5 backlog item); failed/pending outbox TTL sweep (M4 backlog item); cursor-path per-sub replay budget (M2 backlog item).
- **Ops:** structured logging (pino) + health endpoints; alerting on session-engine error rates and reconnect storms is best-effort at single-user scale; deploy runbook acknowledging that restarts log the user out of F-Chat. (OpenTelemetry and messages-table partitioning are dropped to a wishlist note — no scale to justify them.)
- **Credential custody:** session-only in-memory credentials remain the default (decisions.md §3). The **full bouncer model (restart-surviving sessions) is an eventual goal**: when it's time, encrypted at-rest storage lands as an explicit per-user **opt-in**, preceded by the F-List outreach decision. Single-tenancy softens the custody question (the operator is the user) but doesn't dissolve it — the desktop client dissolves it.
- **Standalone-split design pass (design only, no implementation):** a written design (`design/standalone-client.md`) for the eventual desktop app (Tauri/Electron — decided 2026-07-16). Decide: what extracts into a shared session library (`fchat-session`, rate gate, ticket manager vs. their Drizzle/gateway couplings); embedded-bouncer vs. direct-connect architecture (M8's bundled-server variant is the starting sketch); storage story (SQLite/pglite vs. embedded Postgres); what the gateway protocol looks like in-process; Tauri vs. Electron evaluation. Goal: v1.0 code stops accruing coupling that makes the split harder — the design names the boundaries even though the extraction waits.

## Verification

- Integration: lockout/backoff behavior; rate-limit headers; registration path confirmed unreachable when disabled; admin CLI account-create/reset round-trip.
- Restore drill: backup → wipe → restore → data intact; user can unlock and reconnect.
- Deploy guide walked end-to-end on a clean VM/container host (the guide is the test script).
- SFC report round-trip against fchat-sim.
- External review pass (even informal) of the credential-vault handling (no persistence, no logging, cleared on disconnect) before calling v1.0.
