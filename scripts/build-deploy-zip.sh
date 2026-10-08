#!/usr/bin/env bash
# Builds public/arena-engine-host-deploy.zip with engine-host, src, vps + root config (no data/node_modules).
set -e
cd "$(dirname "$0")/.."
rm -f public/arena-engine-host-deploy.zip
zip -qr public/arena-engine-host-deploy.zip engine-host src vps package.json bun.lock* bunfig.toml tsconfig.json \
  -x "engine-host/data/*" "*/__pycache__/*" "*.pyc" "engine-host/run-engine-host.cmd" "src/test/*"
