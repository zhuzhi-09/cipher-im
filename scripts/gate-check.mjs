/**
 * 准入控制实测（自带一个临时服务端，端口 8100，配额/限流都调小以便测边界）
 * 用法：node scripts/gate-check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import WebSocket from 'ws';

const PORT = 8100;
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const DATA = '/tmp/cim-gate-data';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

function bundle(i) {
  return { device: `dg-${i}`, ikSigPub: 'a'.repeat(43), ikDhPub: 'b'.repeat(43), spkId: 's1', spkPub: 'c'.repeat(43), spkSig: 'd'.repeat(80), opks: [{ id: 'o1', pub: 'e'.repeat(43) }] };
}

async function post(path, body) {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let j = {};
  try { j = await res.json(); } catch {}
  return { status: res.status, body: j };
}

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const proc = spawn('node', ['dist/server.mjs'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, INVITE_CODE: 'gate-code', REGISTER_PER_HOUR: '4', LOGIN_PER_MIN: '3', BLOB_QUOTA_MB: '40', BLOB_TOTAL_MB: '80' },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {}
      await sleep(150);
    }

    console.log('\n[1] 邀请码闸门');
    const noCode = await post('/api/register', { username: 'gate1', password: 'pw123456', bundle: bundle(1) });
    ok('不带邀请码 → 403', noCode.status === 403, JSON.stringify(noCode));
    const badCode = await post('/api/register', { username: 'gate1', password: 'pw123456', bundle: bundle(1), invite: 'wrong' });
    ok('邀请码不对 → 403', badCode.status === 403, JSON.stringify(badCode));
    ok('错误文案不泄露正确码', !JSON.stringify(badCode.body).includes('gate-code'));
    const good = await post('/api/register', { username: 'gate1', password: 'pw123456', bundle: bundle(1), invite: 'gate-code' });
    ok('邀请码正确 → 200 并拿到 token', good.status === 200 && typeof good.body.token === 'string', JSON.stringify(good.status));

    console.log('\n[2] 注册限流（每小时 4 次/IP，前两次已被无效邀请码消耗）');
    const fourth = await post('/api/register', { username: 'gate2', password: 'pw123456', bundle: bundle(2), invite: 'gate-code' });
    ok('额度内的注册仍然成功', fourth.status === 200, JSON.stringify(fourth.status));
    const fifth = await post('/api/register', { username: 'gate3', password: 'pw123456', bundle: bundle(3), invite: 'gate-code' });
    ok('额度用完 → 429（正确的邀请码也进不来）', fifth.status === 429, JSON.stringify(fifth));

    console.log('\n[3] 登录限流（每分钟 3 次/IP）');
    let last = 0;
    for (let i = 0; i < 4; i++) {
      const r = await post('/api/login', { username: 'gate1', password: 'bad-password' });
      last = r.status;
    }
    ok('连续错误口令第 4 次 → 429', last === 429, String(last));
    const correctAfterLimit = await post('/api/login', { username: 'gate1', password: 'pw123456' });
    ok('限流期间正确口令也被挡（这就是限流的目的）', correctAfterLimit.status === 429, String(correctAfterLimit.status));

    console.log('\n[4] WebSocket 首帧认证');
    const tok = good.body.token;
    const wrongOrder = await new Promise((resolve) => {
      const ws = new WebSocket(WS);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', device: 'dg-1' })));
      ws.on('message', (raw) => { resolve(JSON.parse(raw.toString())); ws.close(); });
      ws.on('error', () => resolve({ t: 'socketerr' }));
      setTimeout(() => resolve({ t: 'timeout' }), 3000);
    });
    ok('不带 token 且首帧不是 auth → 被拒', wrongOrder.t === 'error', JSON.stringify(wrongOrder));
    ok('URL 里不再需要 token（连接可以裸连成功）', wrongOrder.t !== 'socketerr');

    const authed = await new Promise((resolve) => {
      const ws = new WebSocket(WS);
      const got = [];
      ws.on('open', () => ws.send(JSON.stringify({ t: 'auth', token: tok })));
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        got.push(m.t);
        if (m.t === 'authOk') ws.send(JSON.stringify({ t: 'hello', device: 'dg-1' }));
        if (m.t === 'ready' || m.t === 'error') { ws.close(); resolve(got); }
      });
      ws.on('error', () => resolve(['socketerr']));
      setTimeout(() => resolve(got), 4000);
    });
    ok('首帧 auth 通过，收到 authOk，再 hello 拿到 ready', authed.includes('authOk') && authed.includes('ready'), JSON.stringify(authed));

    console.log('\n[5] 单文件与账号配额');
    const put = async (bytes) => {
      const body = Buffer.alloc(bytes, 7);
      const res = await fetch(BASE + '/api/blob', { method: 'PUT', headers: { authorization: `Bearer ${tok}` }, body });
      let j = {};
      try { j = await res.json(); } catch {}
      return { status: res.status, body: j };
    };
    const one = await put(30 * 1024 * 1024);
    ok('30MB 单文件本身能传（边界内）', one.status === 200, JSON.stringify(one.status));
    const two = await put(30 * 1024 * 1024);
    ok('再传 30MB 超出账号 40MB 配额 → 413', two.status === 413, JSON.stringify(two));
    ok('配额文案给出已用/上限', String(two.body.error || '').includes('MB'), String(two.body.error));
    const tooBig = await put(31 * 1024 * 1024);
    ok('31MB 单文件 → 413', tooBig.status === 413, JSON.stringify(tooBig));
  } finally {
    proc.kill('SIGKILL');
  }

  console.log(`\n准入控制 ${pass}/${pass + fails.length}`);
  if (fails.length) {
    console.log('失败：' + fails.join('；'));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
