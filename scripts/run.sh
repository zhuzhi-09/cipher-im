#!/usr/bin/env bash
# 启动服务（默认 0.0.0.0:8099）
set -euo pipefail
cd "$(dirname "$0")/.."
export PORT="${PORT:-8099}"
export DATA_DIR="${DATA_DIR:-$PWD/data}"
export REGISTER_PER_HOUR="${REGISTER_PER_HOUR:-200}"
export LOGIN_PER_MIN="${LOGIN_PER_MIN:-200}"
export INVITE_CODE="${INVITE_CODE:-dev-code}"  # 开发默认给一个，生产必须换成自己的
[ -f dist/server.mjs ] || bash scripts/build.sh
if [ ! -d node_modules ]; then bash scripts/setup.sh; fi
exec node dist/server.mjs
