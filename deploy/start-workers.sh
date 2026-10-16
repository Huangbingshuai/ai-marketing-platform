#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
dc() { docker compose --env-file .env.production -f compose.production.yaml "$@"; }
dc config --quiet
dc up -d --no-build docling-model-init customized-extraction-worker effect-extraction-worker \
  effect-prompt-generation-worker customized-storyboard-worker customized-assets-worker \
  customized-production-worker effect-segment-render-worker effect-template-mix-worker
dc ps
