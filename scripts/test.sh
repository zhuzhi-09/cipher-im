#!/usr/bin/env bash
# 端到端加密层自测（不需要服务器）
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
npx esbuild src/tests/crypto.test.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --external:node:sqlite \
  --outfile=dist/tests.mjs --log-level=warning
exec node dist/tests.mjs
