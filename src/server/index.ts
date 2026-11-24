/**
 * 服务端：HTTP（账号 / 文件密文 / 静态页）+ WebSocket（实时路由）
 *
 * 它知道的：谁注册了、谁有几台设备、谁给谁发了多少字节、文件有多大。
 * 它不知道的：任何消息内容、文件名、群名以外的任何明文（消息与文件都由客户端加密）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { DB, BundleIn } from './db';
import { loadVapid, sendPush, validEndpoint } from './push';
import type { C2S, S2C, ConvSummary, WireMessage, WireBody } from '../shared/protocol';

const PORT = Number(process.env.PORT || 8099);
const HOST = process.env.HOST || '127.0.0.1'; // 默认只听本机，公网入口交给反代
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const WEB_DIR = process.env.WEB_DIR || new URL('./web', import.meta.url).pathname;
const BLOB_DIR = path.join(DATA_DIR, 'blobs');
const MAX_BLOB = 30 * 1024 * 1024; // 单文件上限 30MB，超了直接拒收
const MAX_JSON = 1024 * 1024;

/* ---------------- 准入控制：邀请码 / 限流 / 存储配额 ---------------- */

// 邀请码只以 sha256 形式留在内存里（配置用 INVITE_CODE，多个用逗号分隔）
const INVITE_HASHES = new Set(
  (process.env.INVITE_CODE || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => createHash('sha256').update(c).digest('hex')),
);
// 没配邀请码 = 不开放注册（fail closed，避免忘了配就把站点裸奔出去）
const REGISTER_OPEN = INVITE_HASHES.size > 0;

const REGISTER_PER_HOUR = Math.max(1, Number(process.env.REGISTER_PER_HOUR || 3)); // 每 IP 每小时注册上限
const LOGIN_PER_MIN = Math.max(1, Number(process.env.LOGIN_PER_MIN || 10)); // 每 IP 每分钟登录尝试上限
const QUOTA_ACCOUNT = Number(process.env.BLOB_QUOTA_MB || 200) * 1024 * 1024; // 每账号文件密文总量
const QUOTA_TOTAL = Number(process.env.BLOB_TOTAL_MB || 2000) * 1024 * 1024; // 全站文件密文总量

/** 单进程内存令牌桶：cap 次 / windowMs，够用且不依赖外部存储 */
const buckets = new Map<string, { tokens: number; at: number }>();
function takeToken(key: string, cap: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key) || { tokens: cap, at: now };
  b.tokens = Math.min(cap, b.tokens + ((now - b.at) / windowMs) * cap);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}
// 定期清掉闲置桶，防止被大量 IP 撑爆内存
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.at > 3600_000) buckets.delete(k);
}, 600_000).unref();

/** 反代后面的真实 IP：优先 X-Forwarded-For 第一段 */
function clientIp(req: http.IncomingMessage): string {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || 'unknown';
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
/** 服务端对话留存期（天）：默认 14 天，可用 RETENTION_DAYS 覆盖 */
const RETENTION_DAYS = Math.max(1, Number(process.env.RETENTION_DAYS || 14));

fs.mkdirSync(BLOB_DIR, { recursive: true });
const db = new DB(path.join(DATA_DIR, 'cipher-im.db'));

/* ---------------- 保留期清理 ---------------- */

function runRetention(why: string) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    const r = db.prune(cutoff);
    for (const id of r.blobs) {
      const f = path.join(BLOB_DIR, id);
      try {
        fs.unlinkSync(f);
      } catch {
        /* 文件可能已不存在 */
      }
    }
    if (r.messages || r.blobs.length) {
      console.log(`[保留期] ${why}：清理消息 ${r.messages} 条、投递 ${r.deliveries} 条、文件 ${r.blobs.length} 个（早于 ${new Date(cutoff).toISOString()}）`);
    }
  } catch (e) {
    console.error('[保留期] 清理失败：', (e as Error).message);
  }
}

/* ---------------- Web Push ---------------- */

const vapid = loadVapid(DATA_DIR);
/** VAPID 的 sub 声明：Apple 要求是 mailto: 或 https: 地址。没配就用第一次订阅时的站点地址 */
function vapidSubject(): string {
  return process.env.VAPID_SUBJECT || db.kvGet('vapid_subject') || 'mailto:admin@example.com';
}

/** 同一台设备、同一会话 5 秒内只推一次，连发十条也只响一声 */
const PUSH_GAP_MS = 5000;
const lastPush = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of lastPush) if (now - t > PUSH_GAP_MS) lastPush.delete(k);
}, 60_000).unref();

function notifyDevice(user: string, device: string, conv: number) {
  if (deviceVisible(user, device)) return; // 正在看着页面，不用推
  const subs = db.pushSubsOf(user, device);
  if (!subs.length) return;
  const k = `${user}/${device}/${conv}`;
  const now = Date.now();
  if (now - (lastPush.get(k) || 0) < PUSH_GAP_MS) return;
  lastPush.set(k, now);
  for (const s of subs) {
    void sendPush(vapid, vapidSubject(), s, { t: 'msg', conv }).then((r) => {
      if (r === 'gone') db.dropPushEndpoint(s.endpoint);
    });
  }
}

runRetention('启动时');
const retentionTimer = setInterval(() => runRetention('每小时巡检'), 60 * 60 * 1000);
retentionTimer.unref?.();

/* ---------------- HTTP ---------------- */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res: http.ServerResponse, code: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_JSON) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function validName(s: unknown): s is string {
  return typeof s === 'string' && /^[a-zA-Z0-9_-]{3,24}$/.test(s);
}

function sanitizeBundle(b: any): BundleIn | null {
  if (!b || typeof b !== 'object') return null;
  if (!validName(b.device)) return null;
  for (const k of ['ikSigPub', 'ikDhPub', 'spkId', 'spkPub', 'spkSig']) {
    if (typeof b[k] !== 'string' || b[k].length > 200) return null;
  }
  if (!Array.isArray(b.opks)) return null;
  const opks = b.opks
    .filter((o: any) => o && typeof o.id === 'string' && typeof o.pub === 'string' && o.id.length < 100 && o.pub.length < 200)
    .slice(0, 100)
    .map((o: any) => ({ id: o.id, pub: o.pub }));
  return { device: b.device, ikSigPub: b.ikSigPub, ikDhPub: b.ikDhPub, spkId: b.spkId, spkPub: b.spkPub, spkSig: b.spkSig, opks };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/api/health') {
      // service / protocol 给原生客户端识别「这是不是 Cipher IM 服务器、协议版本对不对得上」
      json(res, 200, {
        ok: true,
        service: 'cipher-im',
        protocol: 1,
        ...db.stats(),
        retentionDays: RETENTION_DAYS,
        uptime: Math.round(process.uptime()),
      });
      return;
    }

    if (p === '/api/register' && req.method === 'POST') {
      const body = await readJson(req);
      const username = String(body.username || '').trim();
      const displayName = String(body.displayName || username).trim().slice(0, 32);
      const password = String(body.password || '');
      const bundle = sanitizeBundle(body.bundle);
      if (!validName(username)) return json(res, 400, { error: '用户名需 3-24 位字母数字下划线' });
      if (password.length < 6) return json(res, 400, { error: '密码至少 6 位' });
      if (!bundle) return json(res, 400, { error: '设备密钥包格式错误' });
      if (!REGISTER_OPEN) return json(res, 403, { error: '本实例未开放注册（未配置邀请码）' });
      if (!takeToken(`reg:${clientIp(req)}`, REGISTER_PER_HOUR, 3600_000)) {
        return json(res, 429, { error: '注册太频繁，请稍后再试' });
      }
      const code = String(body.invite || '').trim();
      if (!INVITE_HASHES.has(sha256Hex(code))) return json(res, 403, { error: '邀请码不正确' });
      if (db.userExists(username)) return json(res, 409, { error: '用户名已被占用' });

      db.createUser(username, displayName || username, password);
      db.addDevice(username, bundle);
      db.addRoamDevice(username, bundle.device); // 首次注册的设备默认拥有漫游权限
      const token = db.issueToken(username, bundle.device);
      json(res, 200, { token, user: { username, displayName: displayName || username }, device: bundle.device });
      return;
    }

    if (p === '/api/login' && req.method === 'POST') {
      const body = await readJson(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!takeToken(`login:${clientIp(req)}`, LOGIN_PER_MIN, 60_000)) {
        return json(res, 429, { error: '尝试过于频繁，请一分钟后再试' });
      }
      const user = db.getUser(username);
      if (!user || !db.verifyPassword(password, user.pass_hash)) return json(res, 401, { error: '用户名或密码错误' });
      const device = validName(body.device) ? body.device : null;
      const token = db.issueToken(username, device || "");
      json(res, 200, {
        token,
        user: { username, displayName: user.display_name },
        devices: db.devicesOf(username).map((d) => d.device),
      });
      return;
    }

    if (p === '/api/device' && req.method === 'POST') {
      const token = bearer(req);
      const info = token ? db.tokenInfo(token) : null;
      if (!info) return json(res, 401, { error: '未登录' });
      const body = await readJson(req);
      const bundle = sanitizeBundle(body.bundle);
      if (!bundle) return json(res, 400, { error: '设备密钥包格式错误' });
      db.addDevice(info.user, bundle);
      db.addRoamDevice(info.user, bundle.device);
      const newToken = db.issueToken(info.user, bundle.device);
      json(res, 200, { token: newToken, device: bundle.device, opkStock: db.opkStock(info.user, bundle.device) });
      return;
    }

    /* ---- 跨设备漫游 ---- */

    if (p === '/api/roam/init' && req.method === 'POST') {
      const token = bearer(req);
      const info = token ? db.tokenInfo(token) : null;
      if (!info) return json(res, 401, { error: '未登录' });
      const body = await readJson(req);
      const pub = String(body.pub || '');
      const salt = String(body.salt || '');
      const sealed = String(body.sealed || '');
      if (!pub || !salt || !sealed || sealed.length > 8192) return json(res, 400, { error: '漫游密钥格式错误' });
      db.setRoamKeyIfAbsent(info.user, pub, salt, sealed);
      db.addRoamDevice(info.user, info.device);
      json(res, 200, { ok: true, created: true });
      return;
    }

    if (p === '/api/roam/key' && req.method === 'GET') {
      const token = bearer(req);
      const info = token ? db.tokenInfo(token) : null;
      if (!info) return json(res, 401, { error: '未登录' });
      if (!db.isRoamDevice(info.user, info.device)) return json(res, 403, { error: '本机没有漫游权限' });
      const k = db.roamKey(info.user);
      if (!k) return json(res, 404, { error: '账号还没有漫游密钥' });
      json(res, 200, k);
      return;
    }

    if (p === '/api/roam/devices' && req.method === 'GET') {
      const token = bearer(req);
      const info = token ? db.tokenInfo(token) : null;
      if (!info) return json(res, 401, { error: '未登录' });
      json(res, 200, { self: info.device, devices: db.roamDevices(info.user) });
      return;
    }

    if (p === '/api/roam/revoke' && req.method === 'POST') {
      const token = bearer(req);
      const info = token ? db.tokenInfo(token) : null;
      if (!info) return json(res, 401, { error: '未登录' });
      const body = await readJson(req);
      const device = String(body.device || '');
      if (!device) return json(res, 400, { error: '缺少设备号' });
      if (device === info.device) return json(res, 400, { error: '不能撤销当前设备' });
      const had = db.revokeRoamDevice(info.user, device);
      json(res, 200, { ok: true, revoked: had });
      return;
    }

    if (p === '/api/roam/pub' && req.method === 'GET') {
      const token = bearer(req);
      const info = token ? db.tokenInfo(token) : null;
      if (!info) return json(res, 401, { error: '未登录' });
      const user = String(url.searchParams.get('user') || '');
      if (!db.userExists(user)) return json(res, 404, { error: '用户不存在' });
      const k = db.roamKey(user);
      if (!k) return json(res, 404, { error: '该账号未启用漫游' });
      json(res, 200, { user, pub: k.pub }); // 只给公钥
      return;
    }

    if (p === '/api/opk' && req.method === 'POST') {
      const token = bearer(req);
      const info = token ? db.tokenInfo(token) : null;
      if (!info) return json(res, 401, { error: '未登录' });
      const body = await readJson(req);
      const bundle = sanitizeBundle(body.bundle);
      if (!bundle) return json(res, 400, { error: '格式错误' });
      db.addDevice(info.user, bundle);
      json(res, 200, { opkStock: db.opkStock(info.user, bundle.device) });
      return;
    }

    /* ---- Web Push 订阅 ---- */

    if (p === '/api/push/key' && req.method === 'GET') {
      json(res, 200, { publicKey: vapid.publicKey });
      return;
    }

    if (p === '/api/push/subscribe' && req.method === 'POST') {
      const token = bearer(req);
      const info = token ? db.tokenInfo(token) : null;
      if (!info || !info.device) return json(res, 401, { error: '未登录' });
      const body = await readJson(req);
      const endpoint = body.endpoint;
      const p256dh = String(body.keys?.p256dh || '');
      const auth = String(body.keys?.auth || '');
      if (!validEndpoint(endpoint)) return json(res, 400, { error: '不支持的推送地址' });
      if (!/^[A-Za-z0-9_=-]{20,200}$/.test(p256dh) || !/^[A-Za-z0-9_=-]{8,100}$/.test(auth)) {
        return json(res, 400, { error: '推送密钥格式错误' });
      }
      if (db.pushSubsOf(info.user, info.device).length >= 5) {
        // 同一台设备只该有一个有效订阅；超过说明在反复换，留最新的
        for (const s of db.pushSubsOf(info.user, info.device)) db.dropPushEndpoint(s.endpoint);
      }
      db.addPushSub(info.user, info.device, endpoint, p256dh, auth);
      if (!process.env.VAPID_SUBJECT && !db.kvGet('vapid_subject')) {
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
        if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) db.kvSet('vapid_subject', `https://${host}`);
      }
      json(res, 200, { ok: true });
      return;
    }

    if (p === '/api/push/unsubscribe' && req.method === 'POST') {
      const token = bearer(req);
      const info = token ? db.tokenInfo(token) : null;
      if (!info) return json(res, 401, { error: '未登录' });
      const body = await readJson(req);
      json(res, 200, { ok: true, removed: db.removePushSub(info.user, String(body.endpoint || '')) });
      return;
    }

    if (p === '/api/blob' && req.method === 'PUT') {
      const token = bearer(req);
      const info = token ? db.tokenInfo(token) : null;
      if (!info) return json(res, 401, { error: '未登录' });
      if (!takeToken(`up:${info.user}`, 20, 3600_000)) {
        return json(res, 429, { error: '上传太频繁，请稍后再试' });
      }
      const used = db.blobBytesOf(info.user);
      if (used + MAX_BLOB > QUOTA_ACCOUNT) {
        return json(res, 413, {
          error: `账号附件空间已用 ${(used / 1024 / 1024).toFixed(0)}MB / ${Math.round(QUOTA_ACCOUNT / 1024 / 1024)}MB，请等旧文件过期（14 天）`,
        });
      }
      const totalBytes = (db.stats().bytes as number) || 0;
      if (totalBytes > QUOTA_TOTAL) {
        return json(res, 503, { error: '服务端附件空间已满，暂时无法上传' });
      }
      const id = randomBytes(16).toString('hex');
      const tmp = path.join(BLOB_DIR, `${id}.part`);
      const final = path.join(BLOB_DIR, id);
      let size = 0;
      let tooLarge = false;
      const out = fs.createWriteStream(tmp);
      await new Promise<void>((resolve, reject) => {
        req.on('data', (c: Buffer) => {
          size += c.length;
          if (tooLarge) return;
          if (size > MAX_BLOB) {
            tooLarge = true;
            req.unpipe(out);
            out.destroy();
            // 先把 413 写出去，再把请求体丢掉（直接 destroy 会让客户端只看到连接被重置）
            json(res, 413, { error: '单个文件上限 30MB，超过直接拒收' });
            res.on('finish', () => req.destroy());
            resolve();
          }
        });
        req.pipe(out);
        out.on('finish', () => resolve());
        out.on('error', reject);
        req.on('error', reject);
      });
      if (tooLarge) {
        fs.rmSync(tmp, { force: true });
        return;
      }
      fs.renameSync(tmp, final);
      db.addBlob(id, info.user, size, String(req.headers['x-file-mime'] || 'application/octet-stream').slice(0, 100));
      json(res, 200, { id, size });
      return;
    }

    if (p.startsWith('/api/blob/') && req.method === 'GET') {
      const token = bearer(req) || url.searchParams.get('token') || '';
      const info = token ? db.tokenInfo(token) : null;
      if (!info) return json(res, 401, { error: '未登录' });
      const id = p.slice('/api/blob/'.length);
      if (!/^[a-f0-9]{32}$/.test(id)) return json(res, 400, { error: 'id 非法' });
      const meta = db.blob(id);
      if (!meta) return json(res, 404, { error: '文件不存在' });
      const file = path.join(BLOB_DIR, id);
      if (!fs.existsSync(file)) return json(res, 404, { error: '文件已丢失' });
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(meta.size),
        'cache-control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    // 静态资源
    if (req.method === 'GET' || req.method === 'HEAD') {
      const rel = p === '/' ? '/index.html' : p;
      const safe = path.normalize(rel).replace(/^([.][.][/\\])+/, '');
      const file = path.join(WEB_DIR, safe);
      if (file.startsWith(WEB_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
        return;
      }
      // PWA / 前端路由回落
      const index = path.join(WEB_DIR, 'index.html');
      if (fs.existsSync(index)) {
        res.writeHead(200, { 'content-type': MIME['.html'] });
        fs.createReadStream(index).pipe(res);
        return;
      }
      json(res, 404, { error: '前端尚未构建，先跑 scripts/build.sh' });
      return;
    }

    json(res, 404, { error: '未找到' });
  } catch (e) {
    json(res, 400, { error: (e as Error).message });
  }
});

/* ---------------- WebSocket ---------------- */

interface Client {
  user: string;
  device: string;
  ws: WebSocket;
  /** 页面是否在前台且有焦点（客户端用 presence 上报）；不在前台时新消息走 Web Push */
  visible: boolean;
}
const online = new Map<string, Set<Client>>();

function key(user: string, device: string) {
  return `${user}/${device}`;
}

function deviceVisible(user: string, device: string): boolean {
  const set = online.get(key(user, device));
  if (!set) return false;
  for (const c of set) if (c.visible && c.ws.readyState === WebSocket.OPEN) return true;
  return false;
}

function send(ws: WebSocket, msg: S2C) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function pushToDevice(user: string, device: string, msg: S2C): boolean {
  const set = online.get(key(user, device));
  if (!set || set.size === 0) return false;
  for (const c of set) send(c.ws, msg);
  return true;
}

function convSummaries(user: string, device: string): ConvSummary[] {
  return db.convsOf(user).map((c) => {
    const members = db.membersOf(c.id).map((m) => {
      const u = db.getUser(m.user);
      return {
        user: m.user,
        displayName: u ? u.display_name : m.user,
        devices: db.devicesOf(m.user).map((d) => d.device),
      };
    });
    const other = members.find((m) => m.user !== user);
    const last = db.lastMessage(c.id);
    return {
      id: c.id,
      kind: c.kind as 'direct' | 'group',
      name: c.kind === 'direct' ? other?.displayName || other?.user || '对话' : c.name,
      members,
      lastMsgId: last ? last.id : null,
      lastAt: last ? last.created_at : null,
      unread: db.unread(c.id, user, device),
    };
  });
}

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

async function startSession(ws: WebSocket, info: { user: string; device: string }) {
  const client: Client = { user: info.user, device: info.device, ws, visible: false };

  // 令牌必须绑定设备：否则他人拿到令牌就能冒充某台设备收取密文
  if (!info.device) {
    send(ws, { t: 'error', message: '该令牌未绑定设备，请先注册设备密钥' });
    ws.close();
    return;
  }

  const register = (dev: string) => {
    client.device = dev;
    if (!online.has(key(client.user, dev))) online.set(key(client.user, dev), new Set());
    online.get(key(client.user, dev))!.add(client);
    db.touchDevice(client.user, dev);
  };

  register(info.device);

  /* 离线队列 */
  const flushPending = () => {
    if (!client.device) return;
    const pending = db.pendingFor(client.user, client.device);
    for (const row of pending) {
      // 补齐发送者信息
      const meta = (db as any).db.prepare('SELECT sender_user, sender_device, created_at FROM messages WHERE id = ?').get(row.msg_id) as any;
      send(ws, {
        t: 'msg',
        msg: {
          id: row.msg_id,
          conv: row.conv,
          from: { user: meta ? meta.sender_user : '', device: meta ? meta.sender_device : '' },
          createdAt: meta ? meta.created_at : Date.now(),
          body: JSON.parse(row.body) as WireBody,
        },
      });
    }
    db.markDelivered(pending.map((r) => r.id));
  };

  ws.on('message', async (raw) => {
    let m: C2S & { device?: string };
    try {
      m = JSON.parse(raw.toString());
    } catch {
      send(ws, { t: 'error', message: '报文格式错误' });
      return;
    }

    try {
      if ((m as any).t === 'hello') {
        const dev = (m as any).device;
        if (dev !== info.device) {
          send(ws, { t: 'error', message: '设备与令牌不匹配' });
          ws.close();
          return;
        }
        send(ws, { t: 'ready', self: { user: client.user, device: dev }, convs: convSummaries(client.user, dev) });
        flushPending();
        return;
      }

      if (!client.device) {
        send(ws, { t: 'error', message: '请先 hello 声明设备' });
        return;
      }

      switch (m.t) {
        case 'presence': {
          client.visible = !!m.visible;
          break;
        }

        case 'convs': {
          send(ws, { t: 'convs', convs: convSummaries(client.user, client.device) });
          break;
        }

        case 'send': {
          const conv = Number(m.conv);
          if (!db.isMember(conv, client.user)) throw new Error('不是该会话成员');
          const members = db.membersOf(conv);
          const allowedUser = new Set(members.map((x) => x.user));
          const bodies = (m.bodies || []).filter(
            (b) => allowedUser.has(b.user) && db.devicesOf(b.user).some((d) => d.device === b.device),
          );
          if (!bodies.length) throw new Error('没有可投递的目标设备');

          // 群会话里的单播消息是控制消息（例如群密钥分发），不当作普通聊天气泡展示
          const kind = db.convKind(conv) === 'group' ? 'control' : 'direct';
          const msgId = db.insertMessage(conv, client.user, client.device, kind);
          const created = Date.now();

          // 每账号一份历史副本：只接受本会话成员的副本，且密文长度做上限保护
          for (const h of m.hist || []) {
            if (!allowedUser.has(h.user)) continue;
            if (!h.eph || !h.ct || h.ct.length > 200_000) continue;
            db.addHist(msgId, h.user, String(h.eph).slice(0, 200), String(h.ct));
          }
          const pushedIds: number[] = [];
          for (const b of bodies) {
            if (b.user === client.user && b.device === client.device) continue; // 不发给自己
            const rowId = Number(
              (db as any).db
                .prepare('INSERT INTO deliveries (msg_id, conv, user, device, body) VALUES (?,?,?,?,?)')
                .run(msgId, conv, b.user, b.device, JSON.stringify(b.body)).lastInsertRowid,
            );
            if (
              pushToDevice(b.user, b.device, {
                t: 'msg',
                msg: { id: msgId, conv, from: { user: client.user, device: client.device }, createdAt: created, body: b.body },
              })
            ) {
              pushedIds.push(rowId);
            }
            // 控制消息（群密钥分发）不提醒；自己其他设备上发出的消息也不提醒
            if (kind === 'direct' && b.user !== client.user) notifyDevice(b.user, b.device, conv);
          }
          db.markDelivered(pushedIds); // 只标记真正推送成功的，离线设备留着排队
          send(ws, { t: 'sent', conv, id: msgId, createdAt: created, clientId: (m as any).clientId });
          break;
        }

        case 'sendGroup': {
          const conv = Number(m.conv);
          if (!db.isMember(conv, client.user)) throw new Error('不是该会话成员');
          if (db.convKind(conv) !== 'group') throw new Error('该会话不是群聊');
          const body = m.body;
          if (!body || body.kind !== 'group') throw new Error('群消息格式错误');
          const msgId = db.insertMessage(conv, client.user, client.device, 'group');
          const created = Date.now();
          {
            const members = new Set(db.membersOf(conv).map((x) => x.user));
            for (const h of m.hist || []) {
              if (!members.has(h.user)) continue;
              if (!h.eph || !h.ct || h.ct.length > 200_000) continue;
              db.addHist(msgId, h.user, String(h.eph).slice(0, 200), String(h.ct));
            }
          }
          const pushedIds: number[] = [];
          for (const mem of db.membersOf(conv)) {
            for (const d of db.devicesOf(mem.user)) {
              if (mem.user === client.user && d.device === client.device) continue; // 自己的其他设备也收
              const payload = JSON.stringify(body);
              const rowId = Number(
                (db as any).db
                  .prepare('INSERT INTO deliveries (msg_id, conv, user, device, body) VALUES (?,?,?,?,?)')
                  .run(msgId, conv, mem.user, d.device, payload).lastInsertRowid,
              );
              if (
                pushToDevice(mem.user, d.device, {
                  t: 'msg',
                  msg: { id: msgId, conv, from: { user: client.user, device: client.device }, createdAt: created, body },
                })
              ) {
                pushedIds.push(rowId);
              }
              if (mem.user !== client.user) notifyDevice(mem.user, d.device, conv);
            }
          }
          db.markDelivered(pushedIds);
          send(ws, { t: 'sent', conv, id: msgId, createdAt: created, clientId: (m as any).clientId });
          break;
        }

        case 'history': {
          const conv = Number(m.conv);
          if (!db.isMember(conv, client.user)) throw new Error('不是该会话成员');
          const rows = db.history(
            client.user,
            client.device,
            conv,
            m.beforeId ?? null,
            Math.min(m.limit ?? 50, 200),
            Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
          );
          const msgs: WireMessage[] = rows.map((r: any) => ({
            id: r.msg_id,
            conv: r.conv,
            from: { user: r.sender_user, device: r.sender_device },
            createdAt: r.created_at,
            body: JSON.parse(r.body) as WireBody,
          }));
          send(ws, { t: 'history', conv, msgs });
          break;
        }

        case 'roamHistory': {
          const conv = Number(m.conv);
          if (!db.isMember(conv, client.user)) throw new Error('不是该会话成员');
          if (!db.isRoamDevice(client.user, client.device)) throw new Error('本机没有漫游权限');
          const rows = db.histFor(
            client.user,
            conv,
            m.beforeId ?? null,
            Math.min(m.limit ?? 60, 200),
            Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
          );
          send(ws, {
            t: 'roamHistory',
            conv,
            msgs: rows.map((r: any) => ({
              id: r.msg_id,
              conv: r.conv,
              from: { user: r.sender_user, device: r.sender_device },
              createdAt: r.created_at,
              eph: r.eph,
              ct: r.ct,
            })),
          });
          break;
        }

        case 'createDirect': {
          const peer = String(m.peer || '');
          if (!db.userExists(peer)) throw new Error('对方不存在');
          if (peer === client.user) throw new Error('不能和自己开会话');
          let conv = db.findDirect(client.user, peer);
          if (!conv) conv = db.createConv('direct', '', client.user, [client.user, peer]);
          // 通知双方刷新会话列表
          for (const u of [client.user, peer]) {
            for (const d of db.devicesOf(u)) pushToDevice(u, d.device, { t: 'convs', convs: convSummaries(u, d.device) });
          }
          send(ws, { t: 'convs', convs: convSummaries(client.user, client.device) });
          break;
        }

        case 'createGroup': {
          const name = String(m.name || '').trim().slice(0, 40) || '未命名群聊';
          const members = (m.members || []).filter((u: string) => db.userExists(u) && u !== client.user);
          const conv = db.createConv('group', name, client.user, [client.user, ...members]);
          for (const u of [client.user, ...members]) {
            for (const d of db.devicesOf(u)) pushToDevice(u, d.device, { t: 'memberChange', conv });
          }
          send(ws, { t: 'convs', convs: convSummaries(client.user, client.device) });
          break;
        }

        case 'addMembers': {
          const conv = Number(m.conv);
          if (!db.isMember(conv, client.user)) throw new Error('不是该会话成员');
          const members = (m.members || []).filter((u: string) => db.userExists(u));
          db.addMembers(conv, members);
          for (const mem of db.membersOf(conv)) {
            for (const d of db.devicesOf(mem.user)) pushToDevice(mem.user, d.device, { t: 'memberChange', conv });
          }
          break;
        }

        case 'bundle': {
          const user = String(m.user || '');
          if (!db.userExists(user)) throw new Error('用户不存在');
          const bundles = db
            .devicesOf(user)
            .map((d) => ({ device: d.device, bundle: db.takeBundle(user, d.device) }))
            .filter((x: any) => x.bundle);
          send(ws, { t: 'bundles', user, bundles: bundles as any });
          break;
        }

        case 'searchUsers': {
          const users = db.listUsers(String(m.q || '')).map((u) => ({ username: u.username, displayName: u.display_name }));
          send(ws, { t: 'users', users });
          break;
        }

        case 'receipt': {
          const conv = Number(m.conv);
          if (!db.isMember(conv, client.user)) throw new Error('不是该会话成员');
          db.setReceipt(conv, client.user, client.device, Number(m.upto) || 0);
          for (const mem of db.membersOf(conv)) {
            if (mem.user === client.user) continue;
            for (const d of db.devicesOf(mem.user)) {
              pushToDevice(mem.user, d.device, { t: 'receipt', conv, user: client.user, upto: Number(m.upto) || 0 });
            }
          }
          break;
        }

        case 'typing': {
          const conv = Number(m.conv);
          if (!db.isMember(conv, client.user)) break;
          for (const mem of db.membersOf(conv)) {
            if (mem.user === client.user) continue;
            for (const d of db.devicesOf(mem.user)) pushToDevice(mem.user, d.device, { t: 'typing', conv, user: client.user });
          }
          break;
        }

        default:
          send(ws, { t: 'error', message: '未知指令' });
      }
    } catch (e) {
      send(ws, { t: 'error', message: (e as Error).message });
    }
  });

  ws.on('close', () => {
    if (client.device) {
      const set = online.get(key(client.user, client.device));
      set?.delete(client);
      if (set && set.size === 0) online.delete(key(client.user, client.device));
    }
  });
}

/* 连接入口：令牌走首帧 auth（放 URL 会被反代的 access log 原样记下来） */
wss.on('connection', (ws: WebSocket) => {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    send(ws, { t: 'error', message: '认证超时（首帧必须是 auth）' });
    ws.close();
  }, 8000);

  const onAuth = (raw: Buffer | string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    ws.off('message', onAuth as any);

    let m: { t?: string; token?: string };
    try {
      m = JSON.parse(raw.toString());
    } catch {
      send(ws, { t: 'error', message: '报文格式错误' });
      ws.close();
      return;
    }
    if (!m || m.t !== 'auth' || typeof m.token !== 'string') {
      send(ws, { t: 'error', message: '首帧必须是 auth' });
      ws.close();
      return;
    }
    const info = db.tokenInfo(m.token);
    if (!info) {
      send(ws, { t: 'error', message: '登录令牌无效，请重新登录' });
      ws.close();
      return;
    }
    send(ws, { t: 'authOk' });
    void startSession(ws, info);
  };
  ws.on('message', onAuth as any);
});

server.listen(PORT, HOST, () => {
  console.log(`Cipher IM 服务已启动: http://${HOST}:${PORT}  数据目录: ${DATA_DIR}`);
  console.log(
    REGISTER_OPEN
      ? `注册：需邀请码（每 IP ${REGISTER_PER_HOUR} 次/小时）`
      : '注册：已关闭（未配置 INVITE_CODE）',
  );
  console.log(`统计: ${JSON.stringify(db.stats())}`);
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
