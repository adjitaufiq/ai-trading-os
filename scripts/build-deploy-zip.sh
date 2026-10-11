#!/usr/bin/env bash
# Builds artifacts/arena-engine-host-deploy.zip with engine-host, src, vps + root config (no data/node_modules).
# Output lives in artifacts/ (git-ignored, never served by the web app) — never public/, so the deploy
# package is not downloadable from the app URL. Hand it to the VPS out-of-band (Files download / scp).
# Writes engine-host/BUILD_INFO.json (commit + UTC build time) so GET /v1/engine/version shows what is running.
set -e
cd "$(dirname "$0")/.."
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo "")"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"commit":"%s","build_time":"%s"}\n' "$COMMIT" "$BUILD_TIME" > engine-host/BUILD_INFO.json
mkdir -p artifacts
rm -f artifacts/arena-engine-host-deploy.zip
zip -qr artifacts/arena-engine-host-deploy.zip engine-host src vps package.json bun.lock* bunfig.toml tsconfig.json \
  -x "engine-host/data/*" "*/__pycache__/*" "*.pyc" "engine-host/run-engine-host.cmd" "src/test/*"
