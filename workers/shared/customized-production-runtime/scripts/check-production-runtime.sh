#!/bin/sh
# Read-only executable smoke test; no media, database, provider or queue access.
set -eu
role=${1:-all}
case "$role" in
  api) tools='ffprobe' ;;
  customized-production|all) tools='ffmpeg ffprobe' ;;
  *) echo 'runtime-check: expected api, customized-production or all' >&2; exit 2 ;;
esac
failed=0
for tool in $tools; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "runtime-check: $role $tool MISSING" >&2
    failed=1
  elif ! "$tool" -version >/dev/null 2>&1; then
    echo "runtime-check: $role $tool UNUSABLE" >&2
    failed=1
  else
    echo "runtime-check: $role $tool OK"
  fi
done
exit "$failed"
