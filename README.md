# Emberline

A third-party web client + server ("bouncer") for [F-Chat](https://www.f-list.net/), F-List's WebSocket chat system. The server holds F-Chat sessions open even when no browser is attached; browsers are synchronized views onto those server-held sessions.

Headline features over the official client: staying online when the app closes, catch-up on missed history, Markdown composing, delayed-send "editing", multi-device login, and granular highlight rules.

> "Emberline" is a working title. Status: **pre-alpha, under construction** — see [`design/milestones.md`](design/milestones.md).

## Repository layout

- `apps/server` — Fastify + ws bouncer server
- `apps/web` — Vite + React client
- `packages/fchat-protocol` — F-Chat wire types + codec
- `packages/protocol` — Emberline client↔server protocol
- `packages/markdown-bbcode` — Markdown → BBCode translation + BBCode AST
- `packages/fchat-sim` — local F-Chat mock server for dev/test
- `design/` — architecture, decisions, milestone plan, protocol reference

## Development

Requires Node ≥ 24 and pnpm 11 (via `corepack enable`).

```sh
pnpm install
pnpm build   # turbo build across all packages
pnpm test    # vitest per package
pnpm lint    # eslint + prettier check
```

Note on TypeScript versions: packages compile with the native TypeScript 7 compiler (per-package devDependency), while the repo root pins TypeScript 6.0 for typescript-eslint, which needs the JS compiler API that TS 7.0 does not ship. Collapse to a single version once TS 7.1's API lands and typescript-eslint supports it.

## License

[MIT](LICENSE)
