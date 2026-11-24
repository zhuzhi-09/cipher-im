#!/usr/bin/env bash
# 安装依赖（幂等）
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund
else
  echo "node_modules 已存在，跳过"
fi
node -e "require('node:sqlite')" 2>/dev/null && echo "node:sqlite 可用"
