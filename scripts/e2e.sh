#!/usr/bin/env bash
# 端到端联测（需要服务已在运行）
set -euo pipefail
cd "$(dirname "$0")/.."
npx esbuild src/tests/e2e.test.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --external:ws --external:node:sqlite \
  --outfile=dist/e2e.mjs --log-level=warning
exec node dist/e2e.mjs
