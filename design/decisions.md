# Architectural Decisions

Locked decisions from the planning session (2026-07-12). Revisit only with explicit agreement.

## 1. Tech stack — TypeScript monorepo

Node server + React/Vite client + shared packages, managed with **pnpm workspaces + Turborepo**. One language everywhere, protocol types shared between client and server, easiest path to an Electron wrapper later.

- Server framework: **Fastify** + `ws` (typed routes via zod type provider; the heart of the server is a hand-rolled session engine, so NestJS ceremony buys little and plain `ws` alone leaves us rebuilding an HTTP framework).
- Client: Vite + React + react-router, **Zustand** for state (WS event firehose mutating per-identity session slices outside React; selector subscriptions keep the message log cheap).
- Database: **Postgres** with **Drizzle ORM** (SQL-first typed schema, easy raw DDL for partitioning/retention, no codegen daemon).
- Virtualized message log: **@tanstack/react-virtual** (headless, dynamic row heights, reverse infinite scroll).

## 2. Tenancy — public hosted service

Open registration, not just a self-hosted friend group. Consequences: email verification, password reset, CAPTCHA/abuse controls, per-user rate limiting, audit logging, ToS/privacy pages are all v1.0 scope — scheduled as Milestone 7 (hardening), not Milestone 1.

## 3. Credentials — session-only, in memory ("bouncer-lite")

*Revised 2026-07-12; supersedes the original envelope-encryption-at-rest decision.*

F-List passwords are **never persisted**. On connect, the user supplies their F-List password; the server verifies it via one ticket fetch and keeps it in an **in-memory credential vault** for the lifetime of that account's sessions.

- In-memory credentials are required (not just tickets): tickets expire every 30 minutes and F-Chat connections drop on their own, so the vault is what lets the server re-ticket and auto-reconnect through blips while the browser is closed.
- **If the server process dies or restarts, sessions and credentials die with it.** App accounts, identities, conversations, history, and read cursors all persist — the user just re-enters the F-List password to reconnect.
- Consequences: no MASTER_KEY/KMS in v1, no ciphertext columns, no startup session resume (Milestone 2 loses that item), and every server deploy logs all characters out of F-Chat until passwords are re-entered. Accepted at current scale.
- Vault hygiene: passwords never logged or serialized, redacted from error paths, cleared when the last session for an account stops or the user explicitly disconnects.
- This reduces the credential-custody exposure to "passwords transit our server and live in RAM while a session runs" — the same trust level as any hosted web client, and comfortably within the developer policy's storage clause.
- **The full bouncer model (restart-surviving sessions) is a stated eventual goal**, deliberately deferred. When it comes, encrypted at-rest storage returns as an explicit per-user opt-in, and the custody question — including whether to consult F-List staff first — gets decided before building; see `risks-and-open-questions.md`.
- Clarification on tickets: an *established* F-Chat connection never needs re-ticketing — the ticket is checked only at IDN. The vault exists for the two cases that need a fresh ticket: reconnecting after a drop, and authenticated JSON API calls. This mirrors what local clients already do with saved credentials.

## 4. First milestone — thin vertical slice

App login → connect one F-List character identity → join channels, send/receive channel messages and PMs, live member list — with history persisted from day one. Always-online bouncer, multi-identity, Markdown layer, highlights, and preferences follow in later milestones, but the architecture accommodates them from the start (see `architecture.md`).

## 5. Deployment context (settled 2026-07-12)

- **Hosting: VPS with docker-compose** (Hetzner/DigitalOcean-style). Master secrets via env on the host; automated `pg_dump` backups to object storage.
- **Expected scale: realistically one or two users** (the author + a friend) — but **designed scalable from the start**, because others might adopt it as a cool toy. The operating principle: *scalability lives in the architecture, cost lives in the ops.* Architectural choices that scale come free and are kept (stateless REST, cursor-based catch-up, partition-ready message schema with the right indexes, session engine behind interfaces with a documented sharding path, per-account ticket coalescing). Operational spend that only matters at scale is deferred until real users show up (KMS, managed infra, partitioning, load testing, sharding). Milestone 7 trims to launch essentials (email verification, rate limits, ToS/privacy); deploy-logouts are handled by telling your friend beforehand.
- **Transactional email: Brevo via SMTP** (existing account). Mailer is still abstracted behind an SMTP interface with Mailpit in dev — Brevo is just the production config.
- **Open source: public repo, MIT licensed** (LICENSE already in repo). Consequences from day one: strict secrets hygiene (env files gitignored, no real credentials in test fixtures or sim scenarios, `.env.example` instead of `.env`), and nothing sensitive ever in git history.
- **"EmberChat" is a working title.** The final name/domain is undecided (the `emberchat.chat` domains in the design files are placeholders). Branding is **runtime deployment config, not build-time constants**: `APP_NAME` / `APP_BASE_URL` env vars in the container's `.env`, consumed by the server (page titles, email templates, the IDN `cname`) and surfaced to the static web build via runtime config (`/config.json` or `window.__CONFIG__` injected into `index.html` by the server that serves it — no rebuild to rename). Policy caveat: the `cname` default must stay an honest, unique client identifier; configurable ≠ free to impersonate other clients. Final name decision still gates the Brevo sender domain/DKIM and public launch.

## 6. Avatars — real character images, not initials (2026-07-12)

Deviation from the HTML mockups (which use mono-initial-on-color avatars everywhere): every avatar surface uses the character's **real F-List profile image** — identity rail, me-bar, identity picker, member list, context menu, DM rows. Source: `https://static.f-list.net/images/avatar/<lowercased character name>.png` (verify the exact pattern against the chat3client source during M1).

- **Fallback = the designed initial-on-color avatar** while loading or on error, so the mockup design remains the skeleton state.
- Hotlink directly from `static.f-list.net` with native lazy loading (`loading="lazy"`) — same as the official web client; static images are not the rate-limited JSON API. An optional caching proxy through our server is a later nicety (single-origin CSP), not v1.
- Keep the size/radius/presence-dot specs from `ui/COMPONENTS.md` — only the fill changes from initial to image.

## 7. Development workflow (2026-07-12)

Conventions apply from the first commit; enforcement (CI, branch protection) lands with Milestone 1 step 1.

- **`main` is always shippable.** Branch protection: required CI check, no force-push. Enable as soon as the Actions workflow exists.
- **Short-lived branches** named `feat/…`, `fix/…`, `chore/…`, `docs/…`; commit messages follow **Conventional Commits** with the same prefixes.
- **Everything lands via PR, squash-merged** — even solo: PRs are where CI gates, and the PR log doubles as the changelog. One milestone step ≈ one branch ≈ one PR.
- **No standing integration/develop branches.** Milestone steps are sequenced to land green on `main` individually; if a change seems too big for one PR, slice it smaller rather than letting a long-lived branch rot. A temporary integration branch is a rare, explicit exception.
- **CI (GitHub Actions):** `pnpm build && pnpm test && pnpm lint` on push/PR (M1 step 1); Playwright E2E job joins when the web app exists (M1 step 9+); Docker image build + push to ghcr joins at M1 step 11.
- **Versioning:** git tags (`v0.1.0` at end of M1) + GitHub Releases; internal packages are never published to npm, so no changesets machinery.

## 8. Inline eicons/icons in chat (2026-07-12)

The mockups show a text-only message log, but F-Chat messages routinely contain `[eicon]` emotes (small, often animated GIFs from the global gallery: `https://static.f-list.net/images/eicon/<name>.gif`) and `[icon]` avatar embeds. Both are in our allowed BBCode subset and must render inline.

- **Fixed render size** (~60px box, official-client-like) with explicit width/height so virtualized rows measure correctly before the image loads — no scroll jank. Hotlinked with lazy loading, like avatars (§6).
- **Display mode is a user preference** (M5, Appearance): **Inline** (default — image in the message row) or **Name only** (renders the eicon's name as a small chip; hovering shows the image in a popover). Name-only keeps busy channels calm and rows uniform. Orthogonal **animation toggle**: "Animate eicons" off = frozen first frame (canvas), applies to inline rendering and hover popovers alike.
- **`icon_blacklist` VAR**: some channels disallow (e)icons (server-enforced). Render whatever the server sends; the composer warns when inserting an eicon into a blacklisted channel.
- **Input syntax**: `[eicon]name[/eicon]` typed literally always works and passes through the Markdown layer untouched (developer policy: smiley syntax must be consistent with official clients). The composer's ☺ button is an insert-by-name helper (M4); per-user favorites list joins in M5. No eicon search — F-List has no public search API for the gallery.

## Other settled points

- The server is a **bouncer**: it owns one F-Chat WebSocket per connected identity; browsers attach via our own gateway protocol and receive synchronized events. This is what makes "stay online when the app is closed", catch-up, and multi-device login possible.
- Messages are stored **per identity** (F-Chat provides no message IDs or server timestamps, so cross-identity dedupe is fragile; per-identity logs also match the UI state model and the developer policy's "your logs" framing).
- v1 session engine is **single-process** (one Node process owns all F-Chat sockets); sharding by account is a documented later path, kept behind interfaces so it's a deployment concern, not a rewrite.
- Client identification: `cname = "EmberChat"`, `cversion = <semver>` from day one.
- **Idiomatic code, recent stack**: follow each tool's own conventions (idiomatic TS/React/SQL, no bespoke house patterns), and build on current stable versions at scaffold time — e.g. TypeScript 7, Postgres 18, current Node LTS — pinning majors and preferring upgrades over staying behind.
