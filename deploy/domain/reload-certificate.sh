#!/bin/sh
set -eu
test "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/marketing.richbest.cn || exit 0
docker exec avatar-proxy-api-gateway-1 nginx -t
docker exec avatar-proxy-api-gateway-1 nginx -s reload
