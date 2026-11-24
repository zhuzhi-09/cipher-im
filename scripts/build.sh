#!/usr/bin/env bash
# 构建：服务端 dist/server.mjs，前端 dist/web/
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist/web

echo "[1/3] 服务端"
npx esbuild src/server/index.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --external:ws --external:web-push --external:node:sqlite \
  --outfile=dist/server.mjs --log-level=warning

echo "[2/3] 前端"
npx esbuild src/web/main.tsx \
  --bundle --platform=browser --format=esm --target=es2022 \
  --outfile=dist/web/app.js --log-level=warning

echo "[3/3] 静态资源"
cp src/web/index.html src/web/styles.css src/web/manifest.webmanifest src/web/sw.js dist/web/
cp -r src/web/icons dist/web/ 2>/dev/null || true
# Service Worker 缓存名跟着前端内容走：内容不变缓存名不变，内容一变老设备就会换新版
BUILD_ID="$(cat dist/web/app.js dist/web/styles.css dist/web/index.html src/web/sw.js | sha1sum | cut -c1-10)"
sed -i "s/__BUILD__/${BUILD_ID}/" dist/web/sw.js
echo "构建完成 -> dist/（前端版本 ${BUILD_ID}）"
