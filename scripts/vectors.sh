#!/usr/bin/env bash
# 加密兼容测试数据：export 重新导出 spec/vectors/crypto-v1.json；verify 用 TS 实现回放校验
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-verify}"
case "$MODE" in export|verify) ;; *) echo "用法：bash scripts/vectors.sh export|verify" >&2; exit 2;; esac
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
npx esbuild "src/tests/vectors/$MODE.ts" --bundle --platform=node --format=esm --target=node22 \
  --outfile="$TMP/$MODE.mjs" --log-level=warning
node "$TMP/$MODE.mjs"
