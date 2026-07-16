# Milestone 8 — Client Polish (rewritten by the M7 standalone design pass)

*Rewritten 2026-07-16 per `standalone-client.md` (M7 step 8). The original
scope assumed the managed service: a multi-user admin surface and a thin
Electron wrapper pointing at the hosted instance. Both died with the
tenancy pivot — the operator is the user (the M7 admin CLI is the whole
admin story), and the desktop app is now the embedded-bouncer plan in
`standalone-client.md`, scheduled post-v1.0 as its own effort.*

**Goal:** the client-polish backlog that makes daily use pleasant — the
remaining base-client parity gaps from the M6 audit.

**Depends on:** M7. Plan in detail when v1.0 ships; candidate scope:

## Candidate scope

- **In-log search** (feature-parity audit): search within a conversation's
  history, server-side over the messages table, surfaced in the log view.
- **Composer affordances** (parity audit): BBCode/Markdown toolbar, `/help`
  slash reference, warn-code (`/warn`) support.
- **Light theme**: the full token-set design pass deferred from M5
  (decisions.md §10).
- Assorted deferred LOWs from the M2–M7 audit backlogs that have graduated
  from "parked" to "annoying".

## Explicitly elsewhere

- **Desktop client (Electron, embedded bouncer)** — post-v1.0, phased plan
  in `standalone-client.md` (library extraction → pglite seam → shell →
  polish).
- **Admin tooling** — none needed at current tenancy; the admin CLI covers
  account create/reset. Revisit only if multi-user instances ever return.
