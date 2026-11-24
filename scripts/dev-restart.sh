#!/usr/bin/env bash
# 重启开发服务端（只杀 node 起的服务端进程，避免 pkill 自匹配把自己的 shell 杀掉）
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
import subprocess, os, signal
for line in subprocess.run(['ps','-eo','pid,args'], capture_output=True, text=True).stdout.splitlines():
    parts = line.split()
    if len(parts) < 3: continue
    exe, script = parts[1], parts[2]
    if exe.endswith('node') and script.endswith('dist/server.mjs'):
        print('stop', parts[0])
        try: os.kill(int(parts[0]), signal.SIGTERM)
        except ProcessLookupError: pass
PY
sleep 1
PORT="${PORT:-8099}" DATA_DIR="${DATA_DIR:-$PWD/data-test}" INVITE_CODE="${INVITE_CODE:-dev-code}" REGISTER_PER_HOUR="${REGISTER_PER_HOUR:-200}" LOGIN_PER_MIN="${LOGIN_PER_MIN:-200}" nohup node dist/server.mjs > /tmp/cim-srv.log 2>&1 &
sleep 2
curl -s "localhost:${PORT:-8099}/api/health"; echo
