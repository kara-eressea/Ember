# Self-hosting EmberChat

EmberChat is **self-hostable software, not a hosted service**: one instance
serves one person (or one real household). That's deliberate — F-List's
abuse management leans on IP/household correlation, and unrelated users
sharing one server's IP would look like one household to their moderation
tooling. Run your own; it's designed to be painless.

What you get: a bouncer that keeps your F-Chat characters online while your
browser is closed, catch-up on missed history, Markdown composing, delayed
send, multi-device login, and granular highlights — reachable from anywhere
you can open a browser.

## Prerequisites

- A Linux host (a small VPS is plenty — 1 vCPU / 1 GB RAM runs it comfortably)
  with Docker and the compose plugin installed.
- A domain (or subdomain) pointing at the host, if you want TLS — strongly
  recommended for anything internet-reachable. Your F-List password transits
  this server.

## Quick start

```sh
# 1. Fetch the deployment files (or clone the repo).
mkdir emberchat && cd emberchat
curl -fsSLO https://raw.githubusercontent.com/kara-eressea/Ember/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/kara-eressea/Ember/main/.env.example

# 2. Set the two required secrets in .env:
#    POSTGRES_PASSWORD — anything strong
#    AUTH_SECRET       — node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
$EDITOR .env

# 3. Start.
docker compose up -d

# 4. Create your account (registration is disabled by design — the admin
#    CLI is how accounts are born; the password arrives on stdin so it
#    never appears in the process list).
docker compose exec -T server node apps/server/dist/cli/admin.js \
  create-user --email you@example.com --username you --password-stdin <<< 'your app password'
```

Open `http://localhost:3000`, log in, add your F-List account, connect a
character. (Use `localhost`, not `127.0.0.1` — the gateway's WebSocket
origin check is keyed to `APP_BASE_URL`, whose default is `localhost:3000`;
both loopback spellings are accepted, but a mismatched host closes the
gateway with code 4403. On a remote VPS you'll reach it through the reverse
proxy below, not loopback at all.) The email is only your login name — the
server sends no email, ever. Forgot the password? `reset-password --email
you@example.com --password-stdin`, same shape.

> The `<<<` herestring above writes the password into your shell history.
> For a one-off it's usually fine on a machine only you use; to avoid it,
> pipe from a file you delete after (`--password-stdin < pw.txt`), or run
> the command with `--password-stdin` and no redirection at all — type the
> password and press Ctrl-D. (There is no interactive prompt; without one
> of the password flags the CLI exits with an error.)

By default the server binds loopback only (`BIND_ADDRESS=127.0.0.1`), so
nothing is internet-reachable until you put a reverse proxy in front.

## Reverse proxy (TLS)

Set in `.env`:

```
APP_BASE_URL=https://chat.example.com
TRUST_PROXY=1
```

`TRUST_PROXY` matters: without it, every visitor appears to come from the
proxy's address and the per-IP rate limits share one bucket. `APP_BASE_URL`
feeds the gateway's WebSocket origin allow-list — set it to exactly the
origin you serve.

**Caddy** (the two-line option — automatic TLS):

```
chat.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**nginx** (remember the WebSocket upgrade for `/gateway`):

```nginx
server {
    listen 443 ssl;
    server_name chat.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # WebSocket upgrade (the /gateway endpoint)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 120s;
    }
}
```

## Configuration reference

Everything lives in `.env` (see `.env.example` for the commented copy).

| Key | Default | What it does |
|---|---|---|
| `POSTGRES_PASSWORD` | — (required) | Password for the bundled Postgres |
| `AUTH_SECRET` | — (required) | Access-token signing secret, ≥ 32 chars |
| `IMAGE_TAG` | `latest` | ghcr tag to run: `vX.Y.Z` \| `vX.Y` \| `vX` \| `latest` \| `edge` |
| `UPDATE_CHECK_REPO` | `kara-eressea/Ember` | GitHub repo the update check reads releases from |
| `BIND_ADDRESS` / `PORT` | `127.0.0.1` / `3000` | Host listen address |
| `TRUST_PROXY` | unset | **Required behind a proxy** — hop count or CIDRs |
| `APP_BASE_URL` | `http://localhost:3000` | Public origin; feeds the WS origin allow-list |
| `APP_NAME` / `CLIENT_NAME` | `EmberChat` | Branding / IDN `cname` (keep it honest) |
| `CREDENTIALS_KEY` | unset | Enables "Remember on this server" (see below); 32 bytes base64url, generated like `AUTH_SECRET` |
| `RETENTION_POLICY` | `forever` | `forever` \| `30d` \| `90d` \| `1y` message retention |
| `DETACHED_DISCONNECT_HOURS` | `72` | Log a character out of F-Chat after this long with no device attached (`0` = never); reopening the app reconnects automatically |
| `UPDATE_CHECK_ENABLED` | `true` | Daily GitHub Releases check; `false` = no phone-home |
| `CONFIRM_BREAKING_UPGRADE` | `false` | One-boot acknowledgment for breaking migrations |
| `BACKUP_DIR` / `BACKUP_INTERVAL_SECONDS` / `BACKUP_KEEP_DAYS` | `./backups` / `86400` / `14` | Backup service knobs |
| `FCHAT_URL` / `FLIST_API_URL` | real F-List | Point at fchat-sim for smoke tests |
| `CHARACTER_DATA_BUDGET_PER_HOUR` | `170` | Profile/guestbook fetches allowed per sliding hour — **do not raise above F-List's published 200/hr**; when exhausted, cached profiles are served stale |
| `PROFILE_CACHE_TTL_MS` | `86400000` (24 h) | How long a cached profile stays fresh before a view refetches it |
| `FLIST_MAPPINGS_TTL_MS` | `604800000` (7 d) | Refresh window for F-List's bulk infotag/kink mapping lists |
| `EICON_INDEX_BASE_URL` | `https://xariah.net` | Eicon search index host (see the privacy note below) |
| `EICON_INDEX_REFRESH_MS` | `86400000` (24 h) | Delta-refresh cadence for the eicon index |

**Remembered credentials & restarts**: by default F-List passwords live
only in server memory — every restart (including upgrades) logs your
characters out until you re-enter them. Setting `CREDENTIALS_KEY` enables
a per-account **"Remember on this server"** opt-in: the password is stored
AES-256-GCM-encrypted in the database, and on boot the server unlocks
those accounts and reconnects your auto-connect characters with their
exact channels (characters already past the `DETACHED_DISCONNECT_HOURS`
window stay logged out). Be clear-eyed about the guarantee: the key sits
in your `.env` next to the server, so someone with full access to the box
gets both — what this protects is **database dumps and backups on their
own** (they carry only ciphertext), the same promise desktop chat clients
make when they remember your login. Backups: `flist_credentials` rides
the automatic pg dumps by design — restoring a dump onto a box with the
same `.env` restores the no-relogin property; restoring it anywhere else
leaves the rows undecryptable (each account then just needs one manual
unlock). Rotating or losing the key has the same effect. Never commit or
copy the `.env` off the box with the dumps.

**Profile viewer & the request budget**: the in-app profile viewer (M8)
fetches character data from F-List's JSON API through one global
per-instance counter, capped at `CHARACTER_DATA_BUDGET_PER_HOUR`. The
170 default leaves headroom under F-List's 200/hour line — the policy risk
attaches to your server's IP and F-List account, which is why this is an
operator knob and not a user preference. When the budget runs out, the
viewer serves cached profiles (marked stale) until the window frees up.
One transparency note: all identities on an instance share a single
profile cache, so a profile one identity fetched — including one visible
only to it (e.g. friends-only) — may be served from that cache to another
identity on the same instance until it expires. On an admin-only instance
that is one household's own traffic; if you share your instance more
widely than that, know the boundary.

**Eicon search & xariah.net**: eicon search is **off by default** and
enforced server-side per user. The first time a user who enabled it
searches, the server downloads a bulk name index from
`EICON_INDEX_BASE_URL` (xariah.net, a community-run third-party service)
and refreshes it with small daily deltas; searches then run against that
local copy — **user search text never leaves your server**, and users' IPs
never reach xariah. The only xariah-bound traffic is your server's
periodic bulk fetch. Point the knob at fchat-sim (or leave search
disabled) if you'd rather have no third-party egress at all.

**Your logs**: message/command history lives in the `messages` table inside
the Postgres volume (and in the dumps under `BACKUP_DIR`) — known and
accessible, as the F-List developer policy requires. Conversation exports
(txt/html/json) are available in-app under Preferences → Away & logs.

## Upgrades

Compatibility promise: upgrades within a major version are always
compatible — pull, restart, done. Breaking releases are always a **major
version bump**, and the server enforces this at boot:

- Pulling an **older** image against an already-migrated database refuses
  to start (downgrade protection) with instructions.
- A release whose migrations are flagged breaking refuses to start until
  you back up and acknowledge with `CONFIRM_BREAKING_UPGRADE=true` (one
  boot; remove it after).

```sh
docker compose pull server && docker compose up -d server
```

Pin `IMAGE_TAG=vX.Y` if you want bugfixes without feature jumps, or an
exact `vX.Y.Z` if you want nothing to change without your say-so. The app
shows its version (and a quiet update hint) under Preferences → General.
Heads-up: unless you've set `CREDENTIALS_KEY` and opted in to "Remember on
this server", **every server restart logs your characters out of F-Chat**
until you re-enter your F-List password — credentials live only in memory
by default — so upgrade at a quiet moment.

## Backups & the restore drill

The bundled `backup` service writes a `pg_dump` custom-format dump to
`BACKUP_DIR` every `BACKUP_INTERVAL_SECONDS` (default daily, counted from
container start — not cron-aligned) and prunes dumps older than
`BACKUP_KEEP_DAYS`. A failed dump never deletes existing backups and never
leaves a truncated file (it writes to a `.tmp` name and renames on
success). Copy that directory somewhere off-host (object storage, another
machine) — a backup on the same disk as the database only protects against
your own mistakes.

Do this drill **once now**, not during a disaster:

```sh
# 1. Force a fresh dump (don't wait for the schedule):
docker compose exec backup sh -c \
  'pg_dump -h postgres -U emberchat -d emberchat -Fc -f /backups/drill.dump'

# 2. Simulate the disaster on a COPY of the stack (or accept the wipe):
docker compose down
docker volume rm emberchat_pgdata   # ← the actual data loss
docker compose up -d postgres

# 3. Restore:
docker compose exec -T postgres pg_restore \
  -U emberchat -d emberchat --clean --if-exists < backups/drill.dump
docker compose up -d

# 4. Verify: log in — identities, history, and read positions are back.
#    (Without CREDENTIALS_KEY, F-List passwords were never stored —
#    re-enter them to reconnect. With it, and the same .env as the dump's
#    box, remembered accounts reconnect on their own.)
```

## Smoke test without touching F-List

The `sim` profile runs fchat-sim, a fake F-Chat with fixture accounts
(`amber@example.test` / password `hunter2`, character "Amber Vale"):

```sh
FCHAT_URL=ws://sim:9090/chat2 FLIST_API_URL=http://sim:9090 \
  docker compose --profile sim up -d
```

Never run the sim profile in a real deployment.

## Building from source

Replace `image:` with `build: { context: ., target: runtime }` in
`docker-compose.yml` inside a clone of the repo, then
`docker compose build server`. Everything else is identical.

## Troubleshooting

- **"REFUSING TO START"** on boot — read the message; it's the upgrade gate
  doing its job (see Upgrades above).
- **429s from your own IP** behind a proxy — `TRUST_PROXY` is unset.
- **Gateway closes with code 4403** — the browser's origin isn't
  `APP_BASE_URL`; fix the URL scheme/host in `.env`.
- **Locked out of the app** — `reset-password` via the admin CLI (Quick
  start step 4).
- **Everything logged out after a restart** — expected with the default
  memory-only credential model; re-enter your F-List password. If you want
  restarts to reconnect on their own, set `CREDENTIALS_KEY` and opt in to
  "Remember on this server" (see Configuration reference).
