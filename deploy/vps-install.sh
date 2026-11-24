#!/usr/bin/env bash
# 在服务器上一键部署 Cipher IM（需 root）
# 用法：INVITE_CODE=你的邀请码 DOMAIN=im.example.com bash install.sh
# 幂等：重复执行只更新代码并重启服务，不动已有数据
set -euo pipefail

DOMAIN="${DOMAIN:?请用 DOMAIN=你的域名 运行（没有默认值）}"
PORT="${PORT:-8100}"
APP_DIR="${APP_DIR:-/opt/cipher-im}"
DATA_DIR="${DATA_DIR:-/var/lib/cipher-im}"
NODE_DIR="${NODE_DIR:-/opt/node22}"
NODE_VER="${NODE_VER:-v22.19.0}"
RUN_USER="${RUN_USER:-cipherim}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
INVITE_CODE="${INVITE_CODE:?请用 INVITE_CODE=你的邀请码 运行（不设就不开放注册）}"
REGISTER_PER_HOUR="${REGISTER_PER_HOUR:-3}"
LOGIN_PER_MIN="${LOGIN_PER_MIN:-10}"
BLOB_QUOTA_MB="${BLOB_QUOTA_MB:-200}"
BLOB_TOTAL_MB="${BLOB_TOTAL_MB:-2000}"
PKG_DIR="$(cd "$(dirname "$0")" && pwd)"

log() { printf '\n\033[36m== %s ==\033[0m\n' "$*"; }
die() { printf '\033[31m错误：%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 执行"

log "0/7 环境检查"
command -v curl >/dev/null || die "缺少 curl"
command -v tar >/dev/null || die "缺少 tar"
if ! getent hosts "$DOMAIN" >/dev/null; then
  echo "警告：$DOMAIN 当前无法解析。Caddy 申请证书会失败，请先给域名加解析记录。" >&2
fi

log "1/7 安装 Node 22（$NODE_DIR）"
if [ -x "$NODE_DIR/bin/node" ] && "$NODE_DIR/bin/node" -v | grep -q '^v22'; then
  echo "已安装：$("$NODE_DIR/bin/node" -v)"
else
  cd /tmp
  ARCH="$(uname -m)"; case "$ARCH" in x86_64) NARCH=x64;; aarch64|arm64) NARCH=arm64;; *) die "不支持的架构 $ARCH";; esac
  curl -fsSL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-${NARCH}.tar.xz" -o node.tar.xz
  rm -rf "$NODE_DIR"; mkdir -p "$NODE_DIR"
  tar -xJf node.tar.xz -C "$NODE_DIR" --strip-components=1
  rm -f node.tar.xz
  "$NODE_DIR/bin/node" -v
fi

log "2/7 创建运行用户 $RUN_USER"
if ! id "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$RUN_USER"
fi

log "3/7 部署代码到 $APP_DIR"
mkdir -p "$APP_DIR"
cp -f "$PKG_DIR/dist/server.mjs" "$APP_DIR/"
rm -rf "$APP_DIR/web"
cp -r "$PKG_DIR/dist/web" "$APP_DIR/web"
cp -f "$PKG_DIR/package.json" "$APP_DIR/"
[ -f "$PKG_DIR/package-lock.json" ] && cp -f "$PKG_DIR/package-lock.json" "$APP_DIR/"
cd "$APP_DIR"
export PATH="$NODE_DIR/bin:$PATH"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi

log "4/7 准备数据目录 $DATA_DIR"
mkdir -p "$DATA_DIR/blobs"
chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"

log "5/7 写入 systemd 服务"
cat > /etc/systemd/system/cipher-im.service <<EOF
[Unit]
Description=Cipher IM (端到端加密即时通信)
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=DATA_DIR=$DATA_DIR
Environment=WEB_DIR=$APP_DIR/web
Environment=RETENTION_DAYS=$RETENTION_DAYS
Environment=INVITE_CODE=$INVITE_CODE
Environment=REGISTER_PER_HOUR=$REGISTER_PER_HOUR
Environment=LOGIN_PER_MIN=$LOGIN_PER_MIN
Environment=BLOB_QUOTA_MB=$BLOB_QUOTA_MB
Environment=BLOB_TOTAL_MB=$BLOB_TOTAL_MB
Environment=NODE_ENV=production
ExecStart=$NODE_DIR/bin/node --experimental-sqlite $APP_DIR/server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=$DATA_DIR
ProtectHome=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable cipher-im >/dev/null 2>&1 || true
systemctl restart cipher-im
sleep 2
systemctl --no-pager --full status cipher-im | head -12 || true

log "6/7 配置 Caddy 反代（$DOMAIN → 127.0.0.1:$PORT）"
CADDYFILE=/etc/caddy/Caddyfile
if [ ! -f "$CADDYFILE" ]; then
  echo "未找到 $CADDYFILE，跳过 Caddy 配置（若你用 nginx，请自行加一条反代）" >&2
else
  cp -a "$CADDYFILE" "$CADDYFILE.bak.$(date +%s)"
  if grep -qE "^[[:space:]]*${DOMAIN//./\\.}[[:space:]]*\{" "$CADDYFILE"; then
    echo "已存在 $DOMAIN 的站点块，保持不动"
  else
    cat >> "$CADDYFILE" <<EOF

# Cipher IM（由部署脚本追加）
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
  fi
  if command -v caddy >/dev/null && caddy validate --config "$CADDYFILE" --adapter caddyfile >/tmp/caddy-validate.log 2>&1; then
    echo "Caddy 配置校验通过"
    systemctl reload caddy 2>/dev/null || caddy reload --config "$CADDYFILE"
  else
    echo "Caddy 配置校验失败，已保留备份 $CADDYFILE.bak.*，请检查 /tmp/caddy-validate.log" >&2
    tail -5 /tmp/caddy-validate.log >&2 || true
    exit 1
  fi
fi

log "7/7 健康检查"
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/tmp/im-health.json; then
  echo "本机接口正常：$(cat /tmp/im-health.json)"
else
  die "本机接口无响应，看日志：journalctl -u cipher-im -n 50 --no-pager"
fi
sleep 2
if curl -fsS "https://$DOMAIN/api/health" >/tmp/im-health-https.json 2>/dev/null; then
  echo "公网 HTTPS 正常：$(cat /tmp/im-health-https.json)"
else
  echo "公网 HTTPS 还不可用（多半是 DNS 未解析或证书还在申请），稍等再试：curl -fsS https://$DOMAIN/api/health"
fi

cat <<EOF

部署完成。
  服务：systemctl status cipher-im
  日志：journalctl -u cipher-im -f
  数据：$DATA_DIR（SQLite + 文件密文）
  保留期：${RETENTION_DAYS} 天（改 systemd 环境变量后 systemctl restart cipher-im）
  准入：需邀请码注册；每 IP 每小时 ${REGISTER_PER_HOUR} 次注册、每分钟 ${LOGIN_PER_MIN} 次登录
  配额：单文件 30MB / 每账号 ${BLOB_QUOTA_MB}MB / 全站 ${BLOB_TOTAL_MB}MB
  访问：https://$DOMAIN
EOF
