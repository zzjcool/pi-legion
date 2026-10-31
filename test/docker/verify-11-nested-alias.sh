#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
chmod +x "$ROOT/test/docker/"*.sh "$ROOT/test/docker/"*.mjs
bash "$ROOT/test/docker/prepare-home.sh"
STAGING="${DOCKER_PI_HOME:-/tmp/pi-herdr-docker-home}"
IMAGE="${PI_DOCKER_IMAGE:-pi-herdr-sandbox:latest}"
docker run --rm -u 0 -e HOME=/root -e PI_OFFLINE=1 \
  -v "$ROOT:/plugin:ro" -v "$STAGING:/root" -v "$ROOT/test/docker:/opt/test:ro" \
  -w /plugin "$IMAGE" bash /opt/test/inside-11-nested-alias.sh
