#!/usr/bin/env bash
# Builds the production image, boots the full compose stack with the sim
# profile (fake F-Chat), creates the app account the way a self-hoster does,
# runs scripts/smoke.mjs against it, and tears everything down. Isolated
# project name + throwaway env, so it never touches a real deployment's
# containers or volumes.
#
#   ./scripts/smoke.sh            # default port 3900
#   SMOKE_PORT=4000 ./scripts/smoke.sh
#
# Also runs in CI — see .github/workflows/compose-smoke.yml, which is what
# keeps docker-compose.yml, the sim profile and the image's own layout from
# rotting between the times somebody deploys.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${SMOKE_PORT:-3900}"
PROJECT=emberchat-smoke
# The compose file names `ghcr.io/kara-eressea/ember:${IMAGE_TAG:-latest}`, and
# what this script is here to test is the image built from THIS checkout — so
# the build below carries that name with a tag no registry has. Compose only
# pulls an image it cannot find locally, so it finds this one and the compose
# file needs no smoke-only knob of its own. (Building it here is also the only
# way this works on an arm64 machine: the published image is amd64.)
IMAGE_TAG="smoke-local"
IMAGE="ghcr.io/kara-eressea/ember:${IMAGE_TAG}"
ENVFILE="$(mktemp)"

# The account the walk uses. Created through the admin CLI, in the container,
# because that is the only way accounts are made since M7 (registration is off
# by default and no self-host turns it on) — which makes the CLI, and the
# server's presence in the image at the path docker-compose.yml documents,
# part of what this smoke test proves.
SMOKE_EMAIL="smoke-$(date +%s)@example.test"
SMOKE_USERNAME="smoke$(date +%s)"
SMOKE_PASSWORD="correct-horse-battery-staple"

compose() {
  docker compose -p "$PROJECT" --env-file "$ENVFILE" --profile sim "$@"
}

cleanup() {
  status=$?
  # Before the teardown, or the evidence goes with the containers — which on a
  # CI runner means a red job with nothing in it but "exit 1".
  if [ "$status" -ne 0 ]; then
    echo "smoke: FAILED (exit $status) — container logs follow" >&2
    compose logs --no-color --tail 200 >&2 || true
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENVFILE"
}
trap cleanup EXIT

cat >"$ENVFILE" <<EOF
POSTGRES_PASSWORD=smoke-only-password
AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
PORT=$PORT
IMAGE_TAG=$IMAGE_TAG
FCHAT_URL=ws://sim:9090/chat2
FLIST_API_URL=http://sim:9090
EOF

echo "smoke: building the production image ($IMAGE)…"
docker build --target runtime -t "$IMAGE" .

echo "smoke: starting the stack (project $PROJECT, port $PORT)…"
compose up -d --build --wait

echo "smoke: creating the app account with the admin CLI…"
printf '%s' "$SMOKE_PASSWORD" | compose exec -T server \
  node apps/server/dist/cli/admin.js create-user \
  --email "$SMOKE_EMAIL" --username "$SMOKE_USERNAME" --password-stdin

node scripts/smoke.mjs "http://127.0.0.1:$PORT" "$SMOKE_EMAIL" "$SMOKE_PASSWORD"
