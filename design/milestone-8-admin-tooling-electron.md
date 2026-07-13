# Milestone 8 — Service Admin Tooling + Electron

**Goal:** Emberline-side administration (our service, not F-Chat moderation — that's M6) and the desktop wrapper.

**Depends on:** Milestone 7 (admin tooling assumes the hardened public service); Electron only needs Milestone 1's client.

## Scope

### Service admin/moderation

- Admin role on `app_users`; admin-only REST surface + minimal UI: user search, account disable/delete, F-List-account unlink, session inspection (which identities are connected, since when), abuse-report queue (from the M7 contact route).
- `SFC` reporting passthrough so users can report to F-List's own moderators from the client (client sends `action:"report"`; note third-party clients likely cannot upload logs — link the text report only).
- Audit log review UI for admin actions.

### Electron wrapper

- Thin shell around `apps/web` — the web architecture requires no changes (this was a day-one constraint of the stack decision).
- Adds: system tray with mention flash (wired to the M5 "flash tray" preference), native notifications, deep links (`emberline://`), auto-update (electron-updater), single-instance lock.
- Distribution: electron-builder targets for Windows/macOS/Linux; CI job producing artifacts.
- Keep the renderer pointing at the hosted service by default with a configurable server URL (self-hosters).

#### Considered, not scheduled: fully local bundle

A variant worth keeping in mind but deliberately out of scope: bundle `apps/server` *inside* the Electron app (child process or in-process, SQLite or embedded Postgres for storage) and point the renderer at `localhost`. That yields a self-contained desktop client with **none of the bouncer-architecture risks** — credentials never leave the user's machine, no shared egress IP (risk 7 in `risks-and-open-questions.md`), no trust in a third-party operator — at the cost of the headline feature: sessions live only while the app runs (tray-lingering softens this, but a closed laptop is a closed session). It is *not* a client that speaks F-Chat directly — the client stays gateway-only; the bouncer just moves onto the user's machine. The current architecture supports this without forking anything (it is essentially the docker-compose deployment folded into an app bundle), so the option stays open at zero ongoing cost. Revisit if there's demand for "the app without the hosted service"; the main new work would be storage (Postgres → SQLite via Drizzle, or pglite) and lifecycle/packaging.

## Verification

- Admin: E2E covering disable-user → their sessions stop and tokens invalidate.
- Electron: smoke on all three OS targets — login, receive mention while minimized → tray flash + notification; deep link opens the right conversation.
