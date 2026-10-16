#!/bin/sh
set -eu
test "${CERTBOT_DOMAIN:-}" = marketing.richbest.cn
case "${CERTBOT_TOKEN:-}" in ''|*[!A-Za-z0-9_-]*) exit 1 ;; esac
test -n "${CERTBOT_VALIDATION:-}"
container=lens-rhyme-nginx-1
root=/var/www/marketing-acme/.well-known/acme-challenge
temporary=$(mktemp)
trap 'rm -f "$temporary"' EXIT
printf '%s' "$CERTBOT_VALIDATION" > "$temporary"
chmod 644 "$temporary"
docker exec "$container" mkdir -p "$root"
docker cp "$temporary" "$container:$root/$CERTBOT_TOKEN"
