# Architecture

See `decisions.md` for the rationale behind the stack choices. This document is the build reference.

## Monorepo layout

pnpm workspaces + Turborepo; root `tsconfig.base.json`, ESLint flat config, Prettier, Vitest everywhere.

```
emberline/
├── package.json                 # pnpm workspace root, turbo pipeline
├── turbo.json
├── docker-compose.yml           # prod-ish: server + postgres
├── docker-compose.dev.yml       # dev: postgres + fchat-sim; apps run on host with HMR
├── apps/
│   ├── server/                  # @emberline/server — Fastify + ws, the bouncer
│   └── web/                     # @emberline/web — Vite + React client
├── packages/
│   ├── fchat-protocol/          # F-Chat wire types + codec
│   ├── protocol/                # Emberline client↔server types (WS + REST DTOs)
│   ├── markdown-bbcode/         # MD→BBCode + BBCode AST/sanitizer
│   └── fchat-sim/               # local F-Chat mock server for dev/test
└── design/, prototype/          # docs (unchanged)
```

### packages/fchat-protocol

Zero-dependency (except zod), isomorphic.

- `src/codec.ts` — frame parse/serialize: `XXX {json}` (3-char command, optional payload, no trailing space when bare).
- `src/server-commands.ts` / `src/client-commands.ts` — one zod schema + TS type per command from `server-commands.md` / `client-commands.md`. Parsing an unknown command returns `{ cmd, raw }` — never throws (developer policy: never crash on unknown commands).
- `src/vars.ts` — typed `ServerVars` (chat_max, priv_max, lfrp_max, lfrp_flood, msg_flood, permissions, icon_blacklist) with defaults; runtime VAR values are always authoritative.
- `src/error-codes.ts` — from `chat-error-codes.md`.
- `src/flist-api.ts` — types for `getApiTicket.php` and the JSON endpoints (character-list, friend-list, bookmark-*, ignore-list, …).

### packages/protocol

The Emberline gateway envelope, event/command unions, REST DTOs, shared enums (presence, roles, conversation kinds). Versioned: `PROTOCOL_VERSION = 1` exchanged in the hello handshake.

### packages/markdown-bbcode

- `mdToBBCode()` targeting exactly the chat subset: `b i u s sup sub color(12 fixed colors) url user icon eicon noparse`. Nothing else is ever emitted.
- `parseBBCode()` → typed AST for safe React rendering (no innerHTML).
- `sanitize()` strips unsupported tags.
- Isomorphic: server translates on send; client uses both for composer preview and message render.

## Server (`apps/server`)

**Stateful, single-process in v1** — one Node process owns all F-Chat sockets. Everything behind interfaces so sharding sessions by account later is a deployment concern.

```
apps/server/src/
├── main.ts                      # bootstrap: config, db, fastify, registry, gateway
├── config.ts                    # env parsing (zod): DATABASE_URL, FCHAT_URL, APP_NAME, APP_BASE_URL,
│                                #   CLIENT_NAME/VERSION (IDN cname/cversion; default honest + unique)
├── db/                          # drizzle schema + migrations
├── modules/
│   ├── auth/                    # register/login/refresh, argon2id, refresh-token rotation; M7: email verify/reset
│   ├── flist-accounts/          # account rows (name only, no secrets) + in-memory credential vault (decisions.md §3)
│   ├── identities/              # identity CRUD, character-list fetch via flist-api
│   ├── flist-api/
│   │   ├── ticket-manager.ts    # per-account ticket manager (below)
│   │   └── api-client.ts        # JSON endpoints; global ≤1 req/s limiter; character-data <200/h budget
│   ├── session-engine/
│   │   ├── registry.ts          # Map<identityId, FchatSession>; start/stop; survives browser detach (M2)
│   │   ├── fchat-session.ts     # state machine per identity (below)
│   │   ├── session-state.ts     # in-memory roster: channels, members, presence, vars, self status
│   │   ├── event-bus.ts         # per-session emitter → gateway fan-out + history sink
│   │   └── rate-gate.ts         # outbound throttle honoring msg_flood / lfrp_flood VARs + length caps
│   ├── gateway/
│   │   ├── gateway.ts           # browser WS endpoint /gateway
│   │   ├── connection.ts        # per-browser-socket: auth, subscriptions, bounded send buffer
│   │   └── snapshot.ts          # sync snapshots from session-state + db cursors
│   ├── history/                 # message persistence, cursor pagination, unread computation, retention hook
│   ├── outbox/                  # delayed-send queue (M4; table exists from day one)
│   └── preferences/             # highlight rules, prefs (M5)
└── plugins/                     # fastify: auth guard, @fastify/rate-limit, cors
```

### FchatSession state machine

States: `idle → acquiring_ticket → connecting → identifying → online → backoff → (acquiring_ticket…) | stopped`.

- Get ticket from TicketManager → open wss → send `IDN {method:"ticket", account, ticket, character, cname, cversion}` immediately (identify first or be disconnected).
- `PIN` → reply `PIN` (never more than one per 10s outbound); watchdog: ~90s of silence → treat connection as dead.
- Consume HLO/VAR/CON/LIS/NLN/FLN/STA into session-state; ICH/JCH/LCH/COL/CDS into per-channel member/mode state; MSG/PRI/LRP/RLL/SYS → event bus (history sink + gateway fan-out).
- Reconnect: jittered exponential backoff **floored at 10s** (developer policy), capped ~5 min; rejoin pinned channels on reconnect.
- All outbound commands pass through rate-gate (token bucket seeded from VARs) and length checks (chat_max/priv_max).
- Unknown inbound commands: structured-log and swallow.

### TicketManager

One instance per **F-List account** (not per identity): in-memory `{ ticket, issuedAt, inflight }` + mutex. `getTicket()` returns the cached ticket if < ~25 min old; otherwise coalesces all concurrent callers into ONE `getApiTicket.php` POST (passing `no_friends/no_bookmarks/no_characters=true` where character data isn't needed). This prevents two identities on one account from invalidating each other's tickets. Tickets are never persisted — re-acquired from the in-memory credential vault.

### Credential vault (bouncer-lite — decisions.md §3)

In-memory `Map<flistAccountId, password>` inside `flist-accounts/`. Seeded when the user adds an account or re-enters the password after a server restart (`POST /api/flist-accounts/:id/unlock`); read only by the TicketManager; cleared when the last session for the account stops or the user disconnects. Never logged, serialized, or persisted — a server restart empties it, and affected identities show "re-enter password to reconnect" in the UI.

## Database schema (Postgres + Drizzle)

```
app_users            id, email uniq, username uniq, password_hash, email_verified_at, created_at
auth_sessions        id, user_id, refresh_token_hash, device_label, expires_at, created_at, last_seen_at
email_tokens         id, user_id, kind ('verify'|'reset'), token_hash, expires_at            -- M7
flist_accounts       id, user_id, account_name, created_at        -- no secrets; creds live in the in-memory vault
identities           id, flist_account_id, character_name uniq(account,name),
                     auto_connect bool, sort_order, created_at   -- auto_connect = connect when the account's vault is unlocked
conversations        id, identity_id, kind ('channel'|'pm'), channel_key nullable,  -- F-Chat name or ADH-id
                     partner_character nullable, title, pinned bool, joined bool,
                     last_read_message_id bigint, uniq(identity_id, kind, coalesce(channel_key,partner_character))
messages             id bigserial PK, conversation_id FK, sender_character,
                     kind ('msg'|'lrp'|'rll'|'sys'|'pm'), bbcode text, source_markdown text null,
                     sent_by_us bool, created_at timestamptz
outbox_messages      id, identity_id, conversation_id, markdown, bbcode, release_at, state    -- M4
highlight_rules      id, user_id, kind ('word'|'nick'|'regex'), pattern, created_at            -- M5
user_preferences     user_id PK, prefs jsonb                                                   -- M5
ignores              identity_id, character, PK(identity_id, character)
channel_directory    channel_key PK, kind ('official'|'open'), title, last_seen_count, refreshed_at  -- M6 cache
```

- Messages stored **per identity** via `conversations.identity_id` (see decisions.md). `messages.id` doubles as the gateway resume cursor.
- Key index: `messages (conversation_id, id DESC)` — pagination, unread counts (`WHERE id > last_read_message_id`), catch-up replay.
- Growth: monthly range partitioning on `created_at` reserved for M7; retention job hook from M2.
- Unread/mention counters computed server-side at snapshot time (capped display at 99), not maintained incrementally.

## Client (`apps/web`)

```
apps/web/src/
├── main.tsx, router.tsx         # routes: / (landing), /login, /register, /identities, /app/:identityId?/:conversationId?
├── theme/
│   ├── tokens.ts                # neutrals + 5 accents from ui/COMPONENTS.md; exact mix() port
│   └── theme.ts                 # applyTheme(accent): derives accentSoft/accentMed/codebg/hover* and writes
│                                #   CSS custom properties on :root; Moss Green warn-dot override
├── gateway/
│   ├── socket.ts                # WS lifecycle, hello/resume, heartbeat, reconnect
│   └── dispatch.ts              # protocol events → store mutations
├── stores/                      # Zustand
│   ├── auth.ts                  # app-account session
│   ├── sessions.ts              # Map<identityId, IdentitySession> mirroring COMPONENTS.md state model
│   ├── messages.ts              # per-conversation windowed buffers (≤ ~1,500 rows) + pagination cursors
│   └── ui.ts                    # active identity, panels, dialogs; local prefs until M5
├── components/
│   ├── shell/                   # AppShell grid (60/244/1fr/232), IdentityRail, Sidebar, MeBar
│   ├── chat/                    # ChannelHeader, MessageLog (virtualized), MessageLine, SystemLine,
│   │                            #   DateDivider, CodeBlock, Composer (+ MD preview), MemberList, MemberContextMenu
│   ├── dialogs/                 # ChannelBrowser (M6), Preferences (M5)
│   └── auth/                    # Landing, Login, Register, IdentityPicker
└── lib/                         # REST api client, nick-color hash, time formatting
```

- Every component styles against `var(--eb-*)` tokens — never hex (COMPONENTS.md mandate). Accent switch = re-run `applyTheme()`.
- **Branding is runtime config** (decisions.md §5): the web build contains no hardcoded product name/domain — it reads `window.__CONFIG__` (injected into `index.html` by the serving Fastify) or falls back to fetching `/config.json`, populated from the container's `APP_NAME`/`APP_BASE_URL` env. Renaming the product is a `.env` change + restart, no rebuild.
- Fonts: IBM Plex Sans/Mono self-hosted via `@fontsource`.
- Message log virtualized with @tanstack/react-virtual; reverse infinite scroll prepends older REST pages with scroll anchoring; store buffers are windowed so neither store nor DOM grows unbounded.
- Inbound BBCode → `parseBBCode()` AST → React elements. `[url]` gets rel=noopener + shown-host safety; `[user]` links to the character's profile; `[icon]/[eicon]` render as inline images from f-list URLs at a **fixed ~60px box with explicit width/height** (keeps virtualized row measurement stable before the GIF loads), lazy-loaded. User preferences (M5): display mode inline vs. name-only chip with hover-preview popover, and animate on/off (frozen first frame via canvas when off) — decisions.md §8.

## Client↔server protocol (`packages/protocol`)

### REST (bearer access token, refresh rotation)

```
POST /api/auth/register | login | refresh | logout
GET/POST/DELETE /api/flist-accounts             # add account (password verified via one ticket fetch, then vaulted in memory)
POST /api/flist-accounts/:id/unlock             # re-enter password after server restart to re-seed the vault
GET  /api/flist-accounts/:id/characters         # proxied character-list for IdentityPicker
POST /api/identities  /  DELETE /api/identities/:id
GET  /api/identities/:id/conversations/:convId/messages?before=<msgId>&limit=50
GET/PUT /api/preferences, /api/highlight-rules  # M5
```

### WebSocket `/gateway`

Envelope both directions: `{ t: string, id?: number, d?: object }` (`id` = client request id, echoed in acks).

Client→server:

```
hello    { token, protocolVersion, resume?: { [identityId]: { convCursors: {convId: lastMessageId} } } }
sub      { identityId }                      # attach to a session's event stream
unsub    { identityId }
cmd      { identityId, action, d }           # action ∈ 'msg.send' {convId, markdown|bbcode}, 'pm.open',
                                             #   'channel.join' {key}, 'channel.leave', 'status.set',
                                             #   'typing.set', 'ignore.add/remove',
                                             #   'session.connect'/'session.disconnect'
ack      { identityId, convId, messageId }   # advance read cursor (drives unread counters everywhere)
ping     {}
```

Server→client:

```
ready    { userId, identities: [{id, name, sessionStatus}] }
snapshot { identityId, self, channels: [{convId, key, title, topic, desc, pinned, members, mode, unread, mention}],
           dms, friends, bookmarks, ignored, presenceVersion }
event    { identityId, kind, d, msgId? }     # 'message.new' (persisted, carries messages.id), 'member.join/leave',
                                             #   'presence', 'status', 'typing', 'channel.topic/desc/mode',
                                             #   'session.status', 'error', 'sys'
catchup  { identityId, convId, messages: [...], done }
ack      { id, ok, error? }
```

**Resume semantics — snapshot + durable replay.** Volatile state (member lists, presence, session status) is never replayed; the client gets a fresh `snapshot` on every `sub`. Durable state (messages) resumes via per-conversation `messages.id` cursors: the server sends `catchup` batches for everything after the cursor, then live `event`s. The messages table *is* the resume log — no separate event-log bookkeeping. Multiple tabs/devices each `sub`; fan-out is per-connection with slow-consumer disconnect (bounded send buffer).
