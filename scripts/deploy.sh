#!/usr/bin/env bash
#
# Put games-backend live on the mini, from what is committed.
#
#   npm run deploy
#
# Until this existed the mini's copy was updated by hand, and the Dockerfile the
# image is built from lived only there: nothing in this repo could have rebuilt
# the running service. `git archive` ships exactly HEAD, so what runs is what is
# committed, with LF endings however this checkout is configured.
#
# Secrets (.env) and data stay on the mini and are never overwritten. A file
# deleted from the repo is not deleted there.
#
set -euo pipefail

HOST="${GB_HOST:-dmini}"
DIR="${GB_DIR:-/home/devon/apps/games-backend}"
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "Uncommitted changes; commit them first so what runs is what is in the repo:" >&2
  git status --short >&2
  exit 1
fi
rev=$(git rev-parse --short HEAD)

echo "==> checks"
npx tsc --noEmit
npx tsx scripts/check-learn-token.ts > /dev/null

echo "==> ship $rev"
git archive --format=tar HEAD | ssh "$HOST" "tar -x -C '$DIR' && echo '$rev' > '$DIR/.deployed-rev'"

echo "==> build and recreate"
ssh "$HOST" "cd '$DIR' && sudo docker compose up -d --build 2>&1 | tail -3"

echo "==> verify through the gateway's network"
ssh "$HOST" '
  for i in $(seq 1 30); do
    code=$(sudo docker exec gateway curl -s -o /dev/null -w "%{http_code}" http://games-backend:8787/health)
    [ "$code" = 200 ] && break
    sleep 2
  done
  printf "    %-36s %s\n" "/health from the gateway" "$code"
  [ "$code" = 200 ]
'
