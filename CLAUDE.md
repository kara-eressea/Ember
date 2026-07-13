# EmberChat

A third-party web client + server ("bouncer") for **F-Chat**, the WebSocket chat system of F-List.net. The server holds one F-Chat connection per character identity — even when no browser is attached — and browsers are synchronized views onto those server-held sessions. Headline features over the official client: staying online when the app closes, catch-up on missed history, Markdown composing (translated to F-Chat's BBCode subset on the wire), delayed-send "editing", multi-device login, granular highlight rules.

## Current state

**Design phase complete — no application code exists yet.** The repo contains design documentation and throwaway HTML UI mockups. Implementation follows the milestone plan in `design/`: check `design/milestones.md` for current status, then work the next unchecked step (entry point: Milestone 1, step 1 — repo scaffold with CI). Update the tracker as steps complete.

## Dev environment

- Docker (and docker-compose) is available locally — used for Postgres, fchat-sim, and the prod image.
- Playwright is available for E2E tests.
- WSL2 (Linux) host.

## Document map

| Path | Contents |
|---|---|
| `design/project-description.md` | Original project brief and motivation |
| `design/decisions.md` | Locked architectural decisions (stack, tenancy, credentials, MVP scope) |
| `design/architecture.md` | Monorepo layout, server/bouncer design, DB schema, client architecture, gateway protocol |
| `design/milestones.md` | **Status tracker** — open/closed milestones, M1 step checklist, standing to-dos. Keep this updated as work progresses |
| `design/milestone-*.md` | One file per milestone (1–8), dependency-ordered |
| `design/testing-strategy.md` | fchat-sim, unit/integration/E2E strategy, responsible live testing |
| `design/risks-and-open-questions.md` | ToS exposure, protocol gaps, scaling ceiling |
| `design/chat-protocol.md` | F-Chat wire protocol (copied from F-List wiki) |
| `design/client-commands.md`, `design/server-commands.md` | Full F-Chat command reference |
| `design/chat-error-codes.md`, `design/chat-bbcode-tags.md`, `design/chat-json-endpoints.md` | Error codes, supported BBCode subset, F-List JSON API |
| `design/ui/README.md`, `design/ui/COMPONENTS.md` | Final UI design system — exact tokens, component specs |
| `prototype/*.dc.html` | HTML mockups (custom `<x-dc>` runtime) — **visual reference only, never reuse the code** |

## Key decisions (do not relitigate without the user)

- **TypeScript monorepo** (pnpm workspaces + Turborepo): `apps/server` (Fastify + ws), `apps/web` (Vite + React + Zustand), `packages/fchat-protocol`, `packages/protocol`, `packages/markdown-bbcode`, `packages/fchat-sim`.
- **Public hosted service** — registration hardening (email verification, rate limits, abuse controls) is v1.0 scope (Milestone 7).
- **F-List credentials are session-only, in memory ("bouncer-lite")** — never persisted. The in-memory vault lets sessions re-ticket and auto-reconnect while the server process lives; a server restart logs everyone out of F-Chat until passwords are re-entered. At-rest storage is a possible future opt-in (see `design/decisions.md` §3).
- **Postgres + Drizzle ORM**, Docker deployment on a VPS (docker-compose).
- **Public open-source repo (MIT)** — strict secrets hygiene: env files gitignored, `.env.example` only, no real credentials in fixtures.
- **"EmberChat" is a working title** — keep product name and domains as config/tokens (including the IDN `cname`), never scattered string literals.
- **Workflow:** `main` always shippable; short-lived `feat/`/`fix/`/`chore/`/`docs/` branches; Conventional Commits; everything via squash-merged PRs gated by CI; no develop/integration branches (see `design/decisions.md` §7).
- **Code style: idiomatic, current-generation stack.** Write idiomatic TypeScript/React/SQL — follow each tool's own conventions rather than inventing house patterns. Adopt recent stable versions at scaffold time (e.g. TypeScript 7, Postgres 18, current Node LTS) and pin majors; prefer upgrading dependencies over pinning old ones.
- UI follows `design/ui/COMPONENTS.md` exactly — style against CSS custom-property tokens, never hard-coded hex; accents are user-swappable.

## Non-negotiable protocol constraints (F-List developer policy)

- Identify with a unique `cname`/`cversion` (`EmberChat/<semver>`) in `IDN` before anything else.
- Reply to `PIN` (never send more than one per 10s); reconnect backoff **≥ 10 seconds**; respect `VAR` flood/length limits at runtime (never hardcode them).
- Send only well-structured BBCode from the supported chat subset (`b i u s sup sub color url user icon eicon noparse`).
- Never crash on unknown commands — log and swallow.
- Ticket API: ≤ 1 request/sec; **each new ticket invalidates all previous tickets account-wide** → all ticket acquisition goes through the per-account TicketManager.
- Message/command logs are allowed, but their location must be known and accessible to the user.
- Heavy testing against the live server is discouraged — develop against `packages/fchat-sim`. The F-List test server is bot-development only (helpdesk, 2026-07-13), so manual verification passes run against the production server: short, supervised, single account, minimal traffic (see `design/testing-strategy.md`).
