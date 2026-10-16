#!/bin/sh
set -eu
umask 077
cd "$(dirname "$0")/.."
mkdir -p backups
chmod 700 backups
target="backups/ai-marketing-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
temporary="$target.partial"
# Dump first so a failed pg_dump cannot be hidden by a successful gzip process.
docker compose --env-file .env.production -f compose.production.yaml exec -T postgres \
  pg_dump -U postgres -d ai_marketing --no-owner > "$temporary.sql"
gzip -c "$temporary.sql" > "$temporary"
gzip -t "$temporary"
mv "$temporary" "$target"
rm -f "$temporary.sql"
echo "Database backup completed: $target"
