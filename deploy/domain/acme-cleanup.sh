#!/bin/sh
set -eu
test "${CERTBOT_DOMAIN:-}" = marketing.richbest.cn
case "${CERTBOT_TOKEN:-}" in ''|*[!A-Za-z0-9_-]*) exit 1 ;; esac
docker exec lens-rhyme-nginx-1 rm -f "/var/www/marketing-acme/.well-known/acme-challenge/$CERTBOT_TOKEN"
