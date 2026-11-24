#!/usr/bin/env bash
# 全部无服务端依赖的测试：加密内核 / 漫游 / 信任状态机 / 本地密钥库 / 保留期
set -uo pipefail
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
fail=0
run() { # name file [node flags]
  local name=$1 file=$2 nflags=${3:-}
  echo "== $name =="
  npx esbuild "$file" --bundle --platform=node --format=esm --target=node22 --external:node:sqlite \
    --outfile="$TMP/$name.mjs" --log-level=warning || exit 1
  node $nflags "$TMP/$name.mjs" || fail=1
}
run crypto src/tests/crypto.test.ts
run roam src/tests/roam.test.ts
run trust src/tests/trust.test.ts
run vault src/tests/vault.test.ts
run retention src/tests/retention.test.ts "--experimental-sqlite"
rm -rf "$TMP"
exit $fail
