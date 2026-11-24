#!/usr/bin/env bash
# 打发布包：out/release/cipher-im-<日期>.tar.gz（含服务端、前端、装机脚本）
set -euo pipefail
cd "$(dirname "$0")/.."

bash scripts/build.sh >/dev/null
STAMP="$(date +%Y%m%d-%H%M)"
REL="out/release/cipher-im"
rm -rf "$REL"
mkdir -p "$REL/dist"

cp dist/server.mjs "$REL/dist/"
cp -r dist/web "$REL/dist/web"
cp package.json package-lock.json "$REL/"
cp deploy/vps-install.sh "$REL/install.sh"
chmod +x "$REL/install.sh"
cp docs/DEPLOY.md "$REL/README-DEPLOY.md"

tar czf "out/release/cipher-im-${STAMP}.tar.gz" -C out/release cipher-im
echo "发布包：out/release/cipher-im-${STAMP}.tar.gz"
ls -lh "out/release/cipher-im-${STAMP}.tar.gz" | awk '{print $5, $9}'
