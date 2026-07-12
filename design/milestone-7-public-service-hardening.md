# Milestone 7 — Public-Service Hardening

**Goal:** everything required to responsibly open registration to the public. Gate the public launch on this milestone.

**Depends on:** Milestones 1–2 minimum; realistically follows 1–6.

## Scope

- **Email flows:** verification on registration and password reset (`email_tokens` table, token hashing, expiry). Provider: **Brevo transactional SMTP** (decided; existing account) behind a mailer interface, Mailpit in dev.
- **Launch-blocking at friends-first scale (decisions.md §5):** email flows, rate limits, ToS/privacy. Everything below ships as growth demands rather than gating launch.
- **Abuse controls:** CAPTCHA or proof-of-work on registration, per-route and per-user rate limits (@fastify/rate-limit with Redis store if multi-instance later), disposable-email heuristics, account lockout/backoff on failed logins.
- **Credential custody:** session-only in-memory credentials are the v1 default (decisions.md §3) — nothing to build for that. The **full bouncer model (restart-surviving sessions) is an eventual goal**: when it's time, encrypted at-rest storage lands here as an explicit per-user **opt-in** (envelope encryption, KMS, rotation), preceded by the F-List outreach decision.
- **Legal/trust surface:** ToS + privacy policy pages (explicit that passwords are held in memory only while sessions run, and about message logging), data-export endpoint, contact route for takedown/abuse reports.
- **Ops:** structured logging (pino) + OpenTelemetry metrics/traces, health endpoints, automated Postgres backups + restore drill, alerting on session-engine error rates and reconnect storms, deploy runbook acknowledging that restarts log everyone out of F-Chat (schedule deploys off-peak, announce in-app beforehand).
- **Scale pressure valves:** convert `messages` to monthly range partitions if growth warrants; retention policies (30d/90d/1yr/Forever per user pref) enforced by the M2 retention job; audit logging for admin actions.
- Security pass: dependency audit, helmet-style headers, CSRF posture for the REST API, WS origin checks, secrets handling review.

## Verification

- Integration: full email verify + reset flows against a mail sink (e.g. Mailpit in compose); lockout/backoff behavior; rate-limit headers.
- Restore drill: backup → wipe → restore → data intact; users can unlock and reconnect.
- Load test: N simulated identities × M attached clients against fchat-sim; measure fan-out latency and memory; confirm slow-consumer disconnect works.
- External review pass (even informal) of the credential-vault handling (no persistence, no logging, cleared on disconnect) before launch — and of any at-rest encryption if the opt-in gets built.
