# 部署到自己的服务器

> 目标形态：systemd 常驻 + Caddy 自动 HTTPS。服务端只监听 `127.0.0.1:8100`，公网只经 Caddy 暴露 443。
> 下文用 `im.example.com` 代表你的域名、`203.0.113.10` 代表你的服务器 IP，照着换成自己的。

## 0. 前置条件

| 条件 | 说明 |
|---|---|
| Linux 服务器 | 有公网 IP，能出站访问 nodejs.org、npm 源和各家推送服务 |
| 域名解析 | 一个子域的 A 记录指向服务器，例如 `im.example.com → 203.0.113.10`。Caddy 会自动申请 Let's Encrypt 证书 |
| Caddy | 已安装并以 systemd 运行（没有的话自己用 nginx 反代也行，见第 6 节） |
| root 权限 | 安装 Node、写 systemd、改 Caddyfile |
| Node 22 | 脚本自动装到 `/opt/node22`，不动系统自带的 Node |

**为什么必须 HTTPS**：前端加密用 WebCrypto，浏览器只在「安全上下文」（https 或 localhost）里提供 `crypto.subtle`。用 http 访问公网 IP 时加密层直接不可用。

## 1. 打发布包并传到服务器

在开发机上：

```bash
bash scripts/setup.sh
bash scripts/package-release.sh          # 产出 out/release/cipher-im-<时间>.tar.gz
scp out/release/cipher-im-*.tar.gz root@203.0.113.10:/root/
```

在服务器上：

```bash
cd /root && tar xzf cipher-im-*.tar.gz && cd cipher-im
```

## 2. 前置：域名先解析

域名要先有 A 记录指到服务器，否则 Caddy 申请证书失败（脚本会警告但继续跑，健康检查会挂在 HTTPS 那步）。

```bash
dig +short im.example.com        # 应该看到你的服务器 IP
```

## 3. 一键部署（域名和邀请码都必须给）

```bash
INVITE_CODE='你自己定一个长一点的码' DOMAIN=im.example.com bash install.sh
```

不设 `INVITE_CODE` 或 `DOMAIN` 脚本会直接退出——这是故意的：没邀请码的实例等于公开注册，域名也没有默认值。
可选参数：

```bash
INVITE_CODE='xxx' DOMAIN=im.example.com \
  REGISTER_PER_HOUR=2 LOGIN_PER_MIN=8 BLOB_QUOTA_MB=150 BLOB_TOTAL_MB=1200 \
  bash install.sh
```

重复执行安全：只更新代码、重启服务，不动数据；Caddyfile 会先备份再校验。

脚本会依次做（全部幂等，可重复执行）：

1. 检查域名解析、依赖
2. 安装 Node 22 到 `/opt/node22`
3. 建系统用户 `cipherim`
4. 部署代码到 `/opt/cipher-im`，`npm ci --omit=dev`
5. 数据目录 `/var/lib/cipher-im`（SQLite + 文件密文）
6. 写 `cipher-im.service`（含 `--experimental-sqlite`、`RETENTION_DAYS=14`、邀请码与限流/配额参数、若干 systemd 加固项）
7. 在 `/etc/caddy/Caddyfile` 追加 `im.example.com` 反代块（**先备份、`caddy validate` 通过才 reload**）
8. 本机 `curl /api/health` + 公网 `https://<域名>/api/health` 自检

## 4. 验收

```bash
systemctl status cipher-im
journalctl -u cipher-im -n 50 --no-pager
curl -fsS https://im.example.com/api/health
```

期望返回类似：

```json
{"ok":true,"users":1,"devices":1,"convs":0,"messages":0,"retentionDays":14,"uptime":12}
```

浏览器打开 `https://im.example.com`，注册两个账号互发一条即可完成验收。

## 5. 日常运维

| 事项 | 命令 |
|---|---|
| 看日志 | `journalctl -u cipher-im -f` |
| 重启 | `systemctl restart cipher-im` |
| 改保留期 | `systemctl edit cipher-im` 加 `Environment=RETENTION_DAYS=7`，再 restart |
| 改邀请码 | 同上，`Environment=INVITE_CODE=新码`；删掉这一行 = 关闭注册 |
| 调限流 | `Environment=REGISTER_PER_HOUR=1` / `Environment=LOGIN_PER_MIN=5` |
| 调配额 | `Environment=BLOB_QUOTA_MB=100` / `Environment=BLOB_TOTAL_MB=1500` |
| 备份 | `systemctl stop cipher-im && tar czf /root/im-backup-$(date +%F).tgz /var/lib/cipher-im && systemctl start cipher-im`（SQLite 用 WAL，稳妥起见先停服务） |
| 版本升级 | 解新包 → `INVITE_CODE=原来的码 DOMAIN=... bash install.sh`（只覆盖代码，数据不动；邀请码和限流参数要和原来一致，脚本会重写 systemd 单元） |
| 只更新前端 | 把新包的 `dist/web/` 覆盖到 `/opt/cipher-im/web/` 再 `chown -R cipherim:cipherim`，不用重启 |
| 推送密钥 | `/var/lib/cipher-im/vapid.json`，随数据目录一起备份；删了所有设备都要重新开启通知 |
| 卸载 | `systemctl disable --now cipher-im && rm -rf /opt/cipher-im /var/lib/cipher-im`，再从 Caddyfile 删掉站点块 |

## 6. 与现有服务共存

- 本服务只用 **8100**（仅本机），不碰 80/443；端口可用 `PORT=...` 改。
- Caddyfile 修改前脚本会备份为 `Caddyfile.bak.<时间戳>`；校验失败不会 reload；同名站点块已存在时保持不动。
- 如果不想动 Caddy，可自行用 nginx 加一条反代，保持 `X-Forwarded-*` 与 WebSocket 升级头即可。

## 7. 故障排查

| 现象 | 排查 |
|---|---|
| 页面报 `crypto.subtle is undefined` | 你在用 http 访问非 localhost 地址，换 https |
| 打开是 502 | `systemctl status cipher-im`；多半是端口/进程问题 |
| 证书申请失败 | `getent hosts im.example.com` 是否解析到你的服务器；再看 `journalctl -u caddy -n 100` |
| 消息发不出、日志报 `未登录` | 浏览器里的令牌过期（数据库被清过），清站点数据后重新注册/登录 |
| WebSocket 反复重连 | 反代未透传升级头；Caddy 的 `reverse_proxy` 默认支持，nginx 需手工加 |
| 收不到新消息通知 | `journalctl -u cipher-im | grep 推送` 看有没有发送失败；服务器要能出站访问 fcm.googleapis.com / web.push.apple.com / *.notify.windows.com；iPhone 必须从主屏图标打开才算开启 |
