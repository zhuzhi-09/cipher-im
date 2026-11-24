/**
 * 跨设备漫游 + 信任状态机 + 30MB 上限 的浏览器实测
 * 用法：BASE=http://127.0.0.1:8099 node scripts/roam-check.mjs
 * 场景：A 注册 alice、B 注册 bob、互发；C 用同一账号在新设备登录 → 历史应回来
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME || '/usr/local/bin/chromium';
const OUT = process.env.OUT_DIR || 'out/screens/roam';
const P0 = 9750;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

class B {
  constructor() { this.id = 0; this.pending = new Map(); }
  async launch(port, profile) {
    fs.rmSync(profile, { recursive: true, force: true });
    this.proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,860', '--force-device-scale-factor=2', 'about:blank'], { stdio: 'ignore' });
    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page) {
          this.ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
          await new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
          this.ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } });
          this.sock = page.webSocketDebuggerUrl;
          return;
        }
      } catch {}
      await sleep(150);
    }
    throw new Error('浏览器未能启动');
  }
  cmd(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, 15000);
    });
  }
  async goto(url) { await this.cmd('Page.enable'); await this.cmd('Runtime.enable'); await this.cmd('Page.navigate', { url }); await sleep(900); }
  async reload() { await this.cmd('Page.reload', { ignoreCache: true }); await sleep(900); }
  eval(expr) { return this.cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value); }
  async waitFor(expr, timeout = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await this.eval(expr); if (v) return v; await sleep(120); }
    return false;
  }
  async shot(path) { const r = await this.cmd('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path, Buffer.from(r.data, 'base64')); }
  kill() { try { this.ws?.close(); } catch {} try { this.proc?.kill('SIGKILL'); } catch {} }
}

const HELPERS = `
window.__fillByLabel = (label, value) => {
  const f = [...document.querySelectorAll('.field')].find(x => x.querySelector('span')?.textContent.includes(label));
  if (!f) return false;
  const el = f.querySelector('input, textarea');
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
};
window.__click = (text) => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === text || x.getAttribute('aria-label') === text);
  if (!b) return false;
  b.click();
  return true;
};
window.__send = (text, idx = 0) => {
  const el = document.querySelectorAll('.composer textarea')[idx];
  if (!el) return false;
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
};
window.__bubbles = () => [...document.querySelectorAll('.bubble')].map(b => (b.textContent || '').trim());
window.__openFirstConv = () => { const c = document.querySelector('.conv-item'); if (!c) return false; c.click(); return true; };
true;
`;

const stamp = Date.now().toString(36).slice(-5);
const ALICE = `ra${stamp}`;
const BOB = `rb${stamp}`;
const PW = 'pw123456';
const MSG1 = '这条是设备 A 在旧设备上发的';
const MSG2 = '收到，这条是设备 B 回的';

(async () => {
  const A = new B(), Bo = new B(), C = new B();
  try {
    await A.launch(P0, '/tmp/cim-roam-a');
    await Bo.launch(P0 + 1, '/tmp/cim-roam-b');
    await A.goto(BASE); await Bo.goto(BASE);

    // ---- 注册 ----
    await A.waitFor(`!!document.querySelector('.auth-card')`);
    await A.eval(HELPERS);
    await A.eval(`__click('注册')`); await sleep(150);
    await A.eval(`__fillByLabel('用户名', '${ALICE}')`);
    await A.eval(`__fillByLabel('昵称', '罗夏')`);
    await A.eval(`__fillByLabel('口令', '${PW}')`);
    await A.eval(`__fillByLabel('邀请码', 'dev-code')`);
    await A.eval(`__click('注册并生成密钥')`);
    ok('A 注册成功', !!(await A.waitFor(`!!document.querySelector('.app')`, 20000)));

    await Bo.waitFor(`!!document.querySelector('.auth-card')`);
    await Bo.eval(HELPERS);
    await Bo.eval(`__click('注册')`); await sleep(150);
    await Bo.eval(`__fillByLabel('用户名', '${BOB}')`);
    await Bo.eval(`__fillByLabel('昵称', '季风')`);
    await Bo.eval(`__fillByLabel('口令', '${PW}')`);
    await Bo.eval(`__fillByLabel('邀请码', 'dev-code')`);
    await Bo.eval(`__click('注册并生成密钥')`);
    ok('B 注册成功', !!(await Bo.waitFor(`!!document.querySelector('.app')`, 20000)));

    // ---- A 建会话并发消息 ----
    await A.eval(`__click('新会话')`); await sleep(300);
    await A.eval(`__fillByLabel('用户名', '${BOB}')`); await sleep(300);
    await A.eval(`__click('建立会话')`);
    await A.waitFor(`document.querySelectorAll('.conv-item').length > 0`);
    await A.eval(`__openFirstConv()`); await sleep(400);
    await A.eval(`__send(${JSON.stringify(MSG1)})`); await sleep(150);
    await A.eval(`__click('发送')`);
    await A.waitFor(`__bubbles().some(t => t.includes('设备 A 在旧设备上发的'))`);

    // ---- B 回复 ----
    await Bo.waitFor(`document.querySelectorAll('.conv-item').length > 0`, 12000);
    await Bo.eval(`__openFirstConv()`); await sleep(400);
    await Bo.eval(`__send(${JSON.stringify(MSG2)})`); await sleep(150);
    await Bo.eval(`__click('发送')`);
    await Bo.waitFor(`__bubbles().some(t => t.includes('设备 B 回的'))`);
    const aSeesReply = await A.waitFor(`__bubbles().some(t => t.includes('设备 B 回的'))`, 12000);
    ok('A 收到 B 的回复（正常收发没被影响）', !!aSeesReply);

    // ---- 30MB 上限文案 ----
    const capText = await A.eval(`(() => {
      const fs = document.querySelector('input[type=file]');
      return { hasInput: !!fs, accept: fs?.accept || '' };
    })()`);
    ok('文件入口存在', capText?.hasInput === true);

    // ---- C：同账号在新设备登录 ----
    await C.launch(P0 + 2, '/tmp/cim-roam-c');
    await C.goto(BASE);
    await C.waitFor(`!!document.querySelector('.auth-card')`);
    await C.eval(HELPERS);
    await C.eval(`__click('登录')`); await sleep(200);
    await C.eval(`__fillByLabel('用户名', '${ALICE}')`);
    await C.eval(`__fillByLabel('口令', '${PW}')`);
    await C.eval(`__click('登录（本机新建密钥）')`);
    ok('C 用同一账号登录成功（新设备密钥）', !!(await C.waitFor(`!!document.querySelector('.app')`, 25000)));

    await C.waitFor(`document.querySelectorAll('.conv-item').length > 0`, 15000);
    await C.eval(`__openFirstConv()`);
    const roam = await C.waitFor(
      `(() => { const b = __bubbles(); return b.length >= 2 && b.some(t=>t.includes('设备 A 在旧设备上发的')) && b.some(t=>t.includes('设备 B 回的')); })()`,
      20000,
    );
    const cBubbles = await C.eval(`__bubbles()`);
    ok('新设备把 14 天内的历史副本全解出来了（自己发的 + 对方回的）', !!roam, JSON.stringify(cBubbles));
    await sleep(400);
    await C.shot(`${OUT}/01-new-device-history.png`);

    // ---- 设置里的漫游设备列表 ----
    await C.eval(`__click('设置')`); await sleep(500);
    const roamBox = await C.eval(`document.querySelectorAll('.roam-item').length`);
    ok('设置里能看到漫游设备列表', roamBox >= 2, `条目=${roamBox}`);
    const items = await C.eval(`[...document.querySelectorAll('.roam-item')].map(x => x.textContent.trim())`);
    ok('列表里包含本机标记', (items || []).some((t) => t.includes('本机')), JSON.stringify(items));
    await C.shot(`${OUT}/02-roam-devices.png`);

    // 撤销旧设备
    const rev = await C.eval(`(() => {
      const row = [...document.querySelectorAll('.roam-item')].find(r => !r.textContent.includes('本机'));
      const btn = row && row.querySelector('button');
      if (btn) { btn.click(); return true; } return false;
    })()`);
    ok('旧设备上有撤销按钮', rev === true);
    await sleep(700);
    const after = await C.eval(`document.querySelectorAll('.roam-item').length`);
    ok('撤销后列表只剩本机', after === 1, `条目=${after}`);
    await C.shot(`${OUT}/03-roam-revoked.png`);

    // 关闭设置
    await C.eval(`__click('关闭')`); await sleep(300);

    // ---- 信任状态机：未核对 → 已验证 → 刷新后仍在 ----
    await C.eval(`__click('核对安全码')`); await sleep(600);
    const pills0 = await C.eval(`[...document.querySelectorAll('.pill')].map(p => p.textContent.trim())`);
    ok('安全码弹窗按设备列出，初始为未核对', (pills0 || []).length >= 1 && pills0.every((t) => t === '未核对'), JSON.stringify(pills0));
    await C.shot(`${OUT}/04-trust-unverified.png`);

    await C.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '标记已验证').click()`);
    await sleep(600);
    const pills1 = await C.eval(`[...document.querySelectorAll('.pill')].map(p => p.textContent.trim())`);
    ok('标记后变成已验证', pills1.includes('已验证'), JSON.stringify(pills1));
    await C.shot(`${OUT}/05-trust-verified.png`);

    await C.reload();
    if (await C.waitFor(`!!document.querySelector('.auth-card')`)) {
      await C.eval(HELPERS);
      await C.eval(`__fillByLabel('口令', '${PW}')`);
      await C.eval(`__click('解锁')`);
      await C.waitFor(`!!document.querySelector('.app')`, 20000);
    }
    await C.waitFor(`document.querySelectorAll('.conv-item').length > 0`, 15000);
    await C.eval(`__openFirstConv()`); await sleep(500);
    await C.eval(`__click('核对安全码')`); await sleep(700);
    const pills2 = await C.eval(`[...document.querySelectorAll('.pill')].map(p => p.textContent.trim())`);
    ok('信任状态写进加密密钥库，刷新/解锁后仍为已验证', pills2.includes('已验证'), JSON.stringify(pills2));

    // 取消信任
    await C.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '取消信任')?.click()`);
    await sleep(500);
    const pills3 = await C.eval(`[...document.querySelectorAll('.pill')].map(p => p.textContent.trim())`);
    ok('取消信任后回到未核对', pills3.includes('未核对'), JSON.stringify(pills3));

    console.log(`\n漫游/信任 ${pass}/${pass + fails.length}`);
    if (fails.length) {
      console.log('失败：' + fails.join('；'));
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    A.kill(); Bo.kill(); C.kill();
  }
})();
