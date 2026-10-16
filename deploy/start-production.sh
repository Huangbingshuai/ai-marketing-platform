#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
dc() { docker compose --env-file .env.production -f compose.production.yaml "$@"; }
dc config --quiet
dc up -d postgres redis rabbitmq
for attempt in $(seq 1 60); do
  if dc exec -T postgres pg_isready -U postgres -d ai_marketing >/dev/null 2>&1 \
    && dc exec -T redis redis-cli ping >/dev/null 2>&1 \
    && dc exec -T rabbitmq rabbitmq-diagnostics -q ping >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" = 60 ]; then echo 'Infrastructure health timeout'; exit 1; fi
  sleep 5
done
dc run --rm --no-deps api node node_modules/prisma/build/index.js migrate deploy
dc up -d api web
echo 'Web and API started. Verify public access before starting generation workers.'
