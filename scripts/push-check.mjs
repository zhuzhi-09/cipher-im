/**
 * Web Push 实测：订阅接口的校验，以及「什么时候该推、推给谁」
 * 自带一个临时服务端（PUSH_DRY_RUN=1：只打日志不真发），先跑 scripts/build.sh
 * 用法：node scripts/push-check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = 8102;
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const DATA = path.join(os.tmpdir(), `cim-push-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

const bundle = (device) => ({ device, ikSigPub: 'a'.repeat(43), ikDhPub: 'b'.repeat(43), spkId: 's1', spkPub: 'c'.repeat(43), spkSig: 'd'.repeat(80), opks: [{ id: 'o1', pub: 'e'.repeat(43) }] });
const KEYS = { p256dh: 'B' + 'x'.repeat(86), auth: 'y'.repeat(22) };
const ep = (name) => `https://fcm.googleapis.com/fcm/send/test-${name}`;

async function call(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = {};
  try { j = await res.json(); } catch {}
  return { status: res.status, body: j };
}

/** 服务端日志里收集 dry-run 推送 */
let logs = [];
function startServer() {
  const proc = spawn(process.execPath, ['--experimental-sqlite', 'dist/server.mjs'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, INVITE_CODE: 'push-code', PUSH_DRY_RUN: '1', REGISTER_PER_HOUR: '50' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => { for (const l of String(d).split('\n')) if (l.includes('dry-run')) logs.push(l); });
  proc.stderr.on('data', () => {});
  return proc;
}
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) return; } catch {}
    await sleep(150);
  }
  throw new Error('服务端没起来');
}
const pushesTo = (name) => logs.filter((l) => l.includes(`test-${name} `));

/** 连上 WS 并完成 auth/hello，visible 为 null 表示不发 presence */
function connect(token, device, visible) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    const inbox = [];
    ws.on('open', () => ws.send(JSON.stringify({ t: 'auth', token })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      inbox.push(m);
      if (m.t === 'authOk') ws.send(JSON.stringify({ t: 'hello', device }));
      if (m.t === 'ready') {
        if (visible !== null) ws.send(JSON.stringify({ t: 'presence', visible }));
        resolve({ ws, inbox, send: (x) => ws.send(JSON.stringify(x)) });
      }
      if (m.t === 'error') reject(new Error(m.message));
    });
    ws.on('error', reject);
  });
}
const close = (c) => new Promise((r) => { c.ws.once('close', r); c.ws.close(); });
const waitFor = async (inbox, pred, ms = 3000) => {
  for (let i = 0; i < ms / 50; i++) { const hit = inbox.find(pred); if (hit) return hit; await sleep(50); }
  return null;
};
const body = { kind: 'msg', header: { dh: 'x', pn: 0, n: 0 }, ct: 'zz' };

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  let proc = startServer();
  try {
    await waitUp();

    console.log('\n[1] VAPID 公钥');
    const k1 = await call('GET', '/api/push/key');
    ok('能取到公钥（P-256 未压缩点，87 字符 base64url）', k1.status === 200 && /^[A-Za-z0-9_-]{87}$/.test(k1.body.publicKey || ''), JSON.stringify(k1));
    const vapidFile = path.join(DATA, 'vapid.json');
    ok('密钥落在数据目录 vapid.json', fs.existsSync(vapidFile));
    proc.kill('SIGKILL');
    await sleep(300);
    proc = startServer();
    await waitUp();
    const k2 = await call('GET', '/api/push/key');
    ok('重启后公钥不变（否则已有订阅全部作废）', k2.body.publicKey === k1.body.publicKey);

    const regA = await call('POST', '/api/register', { username: 'alice', password: 'pw123456', bundle: bundle('dev-a1'), invite: 'push-code' });
    const regB = await call('POST', '/api/register', { username: 'bob', password: 'pw123456', bundle: bundle('dev-b1'), invite: 'push-code' });
    const A = regA.body.token;
    const B = regB.body.token;
    ok('注册两个账号', !!A && !!B);

    console.log('\n[2] 订阅接口校验');
    const sub = (token, endpoint, keys = KEYS) => call('POST', '/api/push/subscribe', { endpoint, keys }, token);
    ok('没登录 → 401', (await sub(null, ep('x'))).status === 401);
    ok('非推送服务的地址 → 400（防 SSRF）', (await sub(A, 'https://evil.example.com/hook')).status === 400);
    ok('仿冒域名 fcm.googleapis.com.evil.com → 400', (await sub(A, 'https://fcm.googleapis.com.evil.com/x')).status === 400);
    ok('http 地址 → 400', (await sub(A, 'http://fcm.googleapis.com/fcm/send/x')).status === 400);
    ok('带端口 → 400', (await sub(A, 'https://fcm.googleapis.com:8443/fcm/send/x')).status === 400);
    ok('内网地址 → 400', (await sub(A, 'https://127.0.0.1/x')).status === 400);
    ok('密钥格式不对 → 400', (await sub(A, ep('x'), { p256dh: '<script>', auth: '1' })).status === 400);
    ok('Apple 推送地址 → 200', (await sub(A, 'https://web.push.apple.com/QaBc-test-a1apple')).status === 200);
    ok('FCM 地址 → 200', (await sub(A, ep('a1'))).status === 200);
    ok('Edge(WNS) 地址 → 200', (await sub(B, 'https://wns2-par02p.notify.windows.com/w/?token=test-b1wns')).status === 200);
    ok('Firefox 地址 → 200', (await sub(B, 'https://updates.push.services.mozilla.com/wpush/v2/test-b1ff')).status === 200);
    await call('POST', '/api/push/unsubscribe', { endpoint: 'https://web.push.apple.com/QaBc-test-a1apple' }, A);
    await call('POST', '/api/push/unsubscribe', { endpoint: 'https://wns2-par02p.notify.windows.com/w/?token=test-b1wns' }, B);
    await call('POST', '/api/push/unsubscribe', { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/test-b1ff' }, B);
    ok('B 的 FCM 订阅 → 200', (await sub(B, ep('b1'))).status === 200);

    console.log('\n[3] 直聊：对方离线 / 前台 / 后台');
    const a = await connect(A, 'dev-a1', true);
    a.send({ t: 'createDirect', peer: 'bob' });
    const convMsg = await waitFor(a.inbox, (m) => m.t === 'convs' && m.convs.length);
    const conv = convMsg?.convs[0].id;
    ok('建立直聊会话', !!conv);

    logs = [];
    a.send({ t: 'send', conv, bodies: [{ user: 'bob', device: 'dev-b1', body }], clientId: 'c1' });
    await waitFor(a.inbox, (m) => m.t === 'sent' && m.clientId === 'c1');
    await sleep(300);
    ok('B 离线 → 推给 B', pushesTo('b1').length === 1, JSON.stringify(logs));
    ok('推送内容只有会话 id，没有发送者和密文', pushesTo('b1')[0]?.endsWith(`{"t":"msg","conv":${conv}}`), pushesTo('b1')[0]);
    ok('发送者自己不收推送', pushesTo('a1').length === 0);

    logs = [];
    a.send({ t: 'send', conv, bodies: [{ user: 'bob', device: 'dev-b1', body }], clientId: 'c2' });
    await waitFor(a.inbox, (m) => m.t === 'sent' && m.clientId === 'c2');
    await sleep(300);
    ok('5 秒内同一会话连发 → 不重复推', pushesTo('b1').length === 0, JSON.stringify(logs));

    const b = await connect(B, 'dev-b1', true);
    await sleep(200);
    logs = [];
    a.send({ t: 'send', conv, bodies: [{ user: 'bob', device: 'dev-b1', body }], clientId: 'c3' });
    await waitFor(b.inbox, (m) => m.t === 'msg');
    await sleep(300);
    ok('B 在线且页面在前台 → 不推（直接走 WebSocket）', pushesTo('b1').length === 0, JSON.stringify(logs));

    b.send({ t: 'presence', visible: false });
    await sleep(5200); // 等过节流窗口
    logs = [];
    a.send({ t: 'send', conv, bodies: [{ user: 'bob', device: 'dev-b1', body }], clientId: 'c4' });
    await waitFor(a.inbox, (m) => m.t === 'sent' && m.clientId === 'c4');
    await sleep(300);
    ok('B 在线但页面在后台 → 推', pushesTo('b1').length === 1, JSON.stringify(logs));

    const b2nd = await connect(B, 'dev-b1', null);
    await sleep(5200);
    logs = [];
    a.send({ t: 'send', conv, bodies: [{ user: 'bob', device: 'dev-b1', body }], clientId: 'c5' });
    await waitFor(a.inbox, (m) => m.t === 'sent' && m.clientId === 'c5');
    await sleep(300);
    ok('新连接还没报 presence 时按「后台」处理 → 推', pushesTo('b1').length === 1, JSON.stringify(logs));
    await close(b2nd);

    logs = [];
    b.send({ t: 'send', conv, bodies: [{ user: 'alice', device: 'dev-a1', body }], clientId: 'r1' });
    await waitFor(b.inbox, (m) => m.t === 'sent' && m.clientId === 'r1');
    await sleep(300);
    ok('A 在前台时 B 回复 → 不推给 A', pushesTo('a1').length === 0, JSON.stringify(logs));

    console.log('\n[4] 群聊');
    a.send({ t: 'createGroup', name: '测试群', members: ['bob'] });
    const gMsg = await waitFor(a.inbox, (m) => m.t === 'convs' && m.convs.some((c) => c.kind === 'group'));
    const group = gMsg?.convs.find((c) => c.kind === 'group').id;
    ok('建群', !!group);

    logs = [];
    a.send({ t: 'send', conv: group, bodies: [{ user: 'bob', device: 'dev-b1', body }], clientId: 'k1' });
    await waitFor(a.inbox, (m) => m.t === 'sent' && m.clientId === 'k1');
    await sleep(300);
    ok('群里的单播控制消息（群密钥分发）→ 不推', pushesTo('b1').length === 0, JSON.stringify(logs));

    logs = [];
    const gbody = { kind: 'group', groupId: String(group), ownerUser: 'alice', ownerDevice: 'dev-a1', keyId: 'k', iteration: 0, ct: 'zz' };
    a.send({ t: 'sendGroup', conv: group, body: gbody, clientId: 'g1' });
    await waitFor(a.inbox, (m) => m.t === 'sent' && m.clientId === 'g1');
    await sleep(300);
    ok('群消息 → 推给后台的群成员', pushesTo('b1').length === 1, JSON.stringify(logs));
    ok('群消息 → 不推给发送者', pushesTo('a1').length === 0);

    console.log('\n[5] 取消订阅 / 撤销设备');
    await close(b);
    const off = await call('POST', '/api/push/unsubscribe', { endpoint: ep('b1') }, B);
    ok('取消订阅 → removed', off.status === 200 && off.body.removed === true, JSON.stringify(off));
    const steal = await call('POST', '/api/push/unsubscribe', { endpoint: ep('a1') }, B);
    ok('不能取消别人的订阅', steal.body.removed === false, JSON.stringify(steal));
    await sleep(5200);
    logs = [];
    a.send({ t: 'send', conv, bodies: [{ user: 'bob', device: 'dev-b1', body }], clientId: 'c6' });
    await waitFor(a.inbox, (m) => m.t === 'sent' && m.clientId === 'c6');
    await sleep(300);
    ok('取消后 B 离线也不再推', logs.length === 0, JSON.stringify(logs));

    const dev2 = await call('POST', '/api/device', { bundle: bundle('dev-b2') }, B);
    const B2 = dev2.body.token;
    ok('B 加第二台设备 b2 并订阅', (await sub(B2, ep('b2'))).status === 200);
    const rev = await call('POST', '/api/roam/revoke', { device: 'dev-b2' }, B);
    ok('撤销 b2', rev.status === 200);
    await sleep(5200);
    logs = [];
    a.send({ t: 'send', conv, bodies: [{ user: 'bob', device: 'dev-b2', body }], clientId: 'c7' });
    await waitFor(a.inbox, (m) => m.t === 'sent' && m.clientId === 'c7');
    await sleep(300);
    ok('被撤销的设备收不到推送', pushesTo('b2').length === 0, JSON.stringify(logs));
    await close(a);
  } finally {
    proc.kill('SIGKILL');
    await sleep(200);
    fs.rmSync(DATA, { recursive: true, force: true });
  }

  console.log(`\nWeb Push ${pass}/${pass + fails.length}`);
  if (fails.length) {
    console.log('失败：' + fails.join('；'));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
