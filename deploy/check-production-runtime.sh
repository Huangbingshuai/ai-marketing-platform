#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec sh "$root/workers/shared/customized-production-runtime/scripts/check-production-runtime.sh" "$@"
