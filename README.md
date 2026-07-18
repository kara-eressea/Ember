# EmberChat

A third-party web client + server ("bouncer") for [F-Chat](https://www.f-list.net/), F-List's WebSocket chat system. The server holds F-Chat sessions open even when no browser is attached; browsers are synchronized views onto those server-held sessions.

Headline features over the official client: staying online when the app closes, catch-up on missed history, Markdown composing, delayed-send "editing", multi-device login, granular highlight rules, searchable server-side history, an in-app profile viewer with a kink-compatibility matcher, eicon search, and opt-in encrypted at-rest credentials so restarts reconnect on their own.

> "EmberChat" is a working title. Status: **alpha** — the core feature set (milestones 1–9) is implemented and released (v0.8.0); pre-1.0, expect rough edges. See [`design/milestones.md`](design/milestones.md).

EmberChat is **self-hostable software, not a hosted service** — each instance serves one person (or one real household), because F-List's abuse management correlates households by IP and a shared multi-user bouncer would misrepresent everyone behind it. Running your own is designed to be painless: see [`docs/self-hosting.md`](docs/self-hosting.md).

## Self-hosting

Docker + compose, one `.env` with two secrets, `docker compose up -d`, create your account with the bundled admin CLI. The full walkthrough — reverse proxy/TLS, upgrades (with a boot-time gate so a `docker pull` can never ruin your database), backups and the restore drill — is in [`docs/self-hosting.md`](docs/self-hosting.md).

## Repository layout

- `apps/server` — Fastify + ws bouncer server
- `apps/web` — Vite + React client
- `packages/fchat-protocol` — F-Chat wire types + codec
- `packages/protocol` — EmberChat client↔server protocol
- `packages/markdown-bbcode` — Markdown → BBCode translation + BBCode AST
- `packages/fchat-sim` — local F-Chat mock server for dev/test
- `design/` — architecture, decisions, milestone plan, protocol reference

## Development

Requires Node ≥ 24, pnpm 11 (via `corepack enable`), and Docker (dev Postgres, testcontainers-based tests).

```sh
pnpm install
pnpm build   # turbo build across all packages
pnpm test    # vitest per package
pnpm lint    # eslint + prettier check
```

Running the stack locally — everything talks to `fchat-sim`, the bundled fake F-Chat, so development never touches the live service:

```sh
docker compose -f docker-compose.dev.yml up -d            # Postgres on :5432
cp apps/server/.env.example apps/server/.env              # sim endpoints are the active defaults
pnpm --filter @emberchat/fchat-sim start                  # fake F-Chat on :9090 (build first)
node --env-file=apps/server/.env apps/server/dist/main.js # API + gateway on :3000
pnpm --filter @emberchat/web dev                          # web on :5173, proxies /api to :3000
```

Create an app account with the admin CLI (`node --env-file=apps/server/.env apps/server/dist/cli/admin.js create-user …`, see `--help`) or set `REGISTRATION_ENABLED=true` in dev. Inside the app, add the sim's fixture F-List account: `amber@example.test` / `hunter2` (characters "Amber Vale", "Cindral").

E2E tests (`pnpm --filter @emberchat/web e2e`) boot their own Postgres + sim + server; nothing above needs to be running.

Note on TypeScript versions: packages compile with the native TypeScript 7 compiler (per-package devDependency), while the repo root pins TypeScript 6.0 for typescript-eslint, which needs the JS compiler API that TS 7.0 does not ship. Collapse to a single version once TS 7.1's API lands and typescript-eslint supports it.

## License

[MIT](LICENSE)
