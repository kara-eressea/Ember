#!/usr/bin/env bash
# Builds the production image, boots the full compose stack with the sim
# profile (fake F-Chat), runs scripts/smoke.mjs against it, and tears
# everything down. Isolated project name + throwaway env, so it never touches
# a real deployment's containers or volumes.
#
#   ./scripts/smoke.sh            # default port 3900
#   SMOKE_PORT=4000 ./scripts/smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${SMOKE_PORT:-3900}"
PROJECT=emberchat-smoke
ENVFILE="$(mktemp)"

cleanup() {
  docker compose -p "$PROJECT" --env-file "$ENVFILE" --profile sim \
    down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENVFILE"
}
trap cleanup EXIT

cat >"$ENVFILE" <<EOF
POSTGRES_PASSWORD=smoke-only-password
AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
PORT=$PORT
FCHAT_URL=ws://sim:9090/chat2
FLIST_API_URL=http://sim:9090
EOF

echo "smoke: building and starting the stack (project $PROJECT, port $PORT)…"
docker compose -p "$PROJECT" --env-file "$ENVFILE" --profile sim \
  up -d --build --wait

node scripts/smoke.mjs "http://127.0.0.1:$PORT"
