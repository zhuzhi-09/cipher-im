/**
 * 输入框自适应校验：一行起步、随内容长高、封顶后框内滚动
 * 用法：node scripts/composer-shots.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME || '/usr/local/bin/chromium';
const OUT = process.env.OUT_DIR || 'out/screens/composer';
const PORT = 9700;
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
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page) {
          this.ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
          await new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
          this.ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } });
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, 10000);
    });
  }
  async goto(url) { await this.cmd('Page.enable'); await this.cmd('Runtime.enable'); await this.cmd('Page.navigate', { url }); await sleep(800); }
  eval(expr) { return this.cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value); }
  async waitFor(expr, timeout = 8000) {
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
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === text);
  if (!b) return false;
  b.click();
  return true;
};
window.__setComposer = (value) => {
  const el = document.querySelector('.composer textarea');
  if (!el) return false;
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
};
window.__layout = () => {
  const comp = document.querySelector('.composer');
  const send = document.querySelector('.composer .send');
  const msgs = document.querySelector('.messages');
  const r = (el) => el ? el.getBoundingClientRect().toJSON() : null;
  return {
    ih: window.innerHeight,
    docH: document.documentElement.scrollHeight,
    bodyH: document.body.scrollHeight,
    comp: r(comp),
    send: r(send),
    msgs: r(msgs),
  };
};
window.__ta = () => {
  const el = document.querySelector('.composer textarea');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    h: Math.round(r.height),
    client: el.clientHeight,
    scroll: el.scrollHeight,
    scrollable: el.scrollHeight > el.clientHeight + 1,
    ih: window.innerHeight,
  };
};
true;
`;

(async () => {
  const a = new B();
  const bob = new B();
  try {
    await a.launch(PORT, '/tmp/cim-comp-a');
    await bob.launch(PORT + 1, '/tmp/cim-comp-b');
    await a.goto(BASE);
    await bob.goto(BASE);

    const stamp = Date.now().toString(36).slice(-4);
    const alice = `uc${stamp}`;
    const bobName = `ud${stamp}`;
    await a.waitFor(`!!document.querySelector('.auth-card')`);
    await a.eval(HELPERS);
    await a.eval(`__click('注册')`);
    await sleep(150);
    await a.eval(`__fillByLabel('用户名', '${alice}')`);
    await a.eval(`__fillByLabel('昵称', '朱乐轩')`);
    await a.eval(`__fillByLabel('口令', 'pw123456')`);
    await a.eval(`__fillByLabel('邀请码', 'dev-code')`);
    await sleep(100);
    await a.eval(`__click('注册并生成密钥')`);
    await a.waitFor(`!!document.querySelector('.app')`, 15000);

    await bob.waitFor(`!!document.querySelector('.auth-card')`);
    await bob.eval(HELPERS);
    await bob.eval(`__click('注册')`);
    await sleep(150);
    await bob.eval(`__fillByLabel('用户名', '${bobName}')`);
    await bob.eval(`__fillByLabel('昵称', '季风')`);
    await bob.eval(`__fillByLabel('口令', 'pw123456')`);
    await bob.eval(`__fillByLabel('邀请码', 'dev-code')`);
    await sleep(100);
    await bob.eval(`__click('注册并生成密钥')`);
    await bob.waitFor(`!!document.querySelector('.app')`, 15000);

    await a.eval(HELPERS);
    await a.eval(`__click('新会话')`);
    await sleep(250);
    await a.eval(`__fillByLabel('用户名', '${bobName}')`);
    await sleep(250);
    await a.eval(`__click('建立会话')`);
    await a.waitFor(`document.querySelectorAll('.conv-item').length > 0`, 8000);
    await a.eval(`document.querySelector('.conv-item')?.click()`);
    await sleep(400);

    // 造几条历史消息，截图别是空场
    await bob.eval(HELPERS);
    await bob.waitFor(`document.querySelectorAll('.conv-item').length > 0`, 10000);
    await bob.eval(`document.querySelector('.conv-item')?.click()`);
    await bob.eval(`__setComposer('输入框改成一行起步了，看下效果')`);
    await sleep(100);
    await bob.eval(`__click('发送')`);
    await a.waitFor(`[...document.querySelectorAll('.row:not(.mine) .bubble')].length >= 1`, 10000);

    console.log('\n[1] 空输入框 = 一行高');
    let s = await a.eval(`__ta()`);
    ok('高度接近 40px（单行 + 内边距）', s.h >= 38 && s.h <= 46, JSON.stringify(s));
    ok('未出现内部滚动', !s.scrollable, JSON.stringify(s));
    await a.shot(`${OUT}/01-empty.png`);

    console.log('\n[2] 一行文字');
    await a.eval(`__setComposer('晚上好')`);
    await sleep(300);
    s = await a.eval(`__ta()`);
    ok('仍是一行高', s.h <= 46, JSON.stringify(s));
    await a.shot(`${OUT}/02-one-line.png`);

    console.log('\n[3] 三行文字：开始随内容长高');
    await a.eval(`__setComposer('第一行：Caddy 反代还没配\\n第二行：8100 端口只监听 127.0.0.1\\n第三行：证书用 im.example.com 自动签')`);
    await sleep(300);
    s = await a.eval(`__ta()`);
    ok('高度明显超过一行', s.h > 55, JSON.stringify(s));
    ok('尚未触顶（三行仍完整可见）', !s.scrollable && s.h < 158, JSON.stringify(s));
    await a.shot(`${OUT}/03-three-lines.png`);

    console.log('\n[4] 十行文字：到上限就框内滚动，不顶满屏');
    const ten = Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 行长文本，用来把输入框撑到上限`).join('\n');
    await a.eval(`__setComposer(${JSON.stringify(ten)})`);
    await sleep(300);
    s = await a.eval(`__ta()`);
    ok('高度被 max-height 夹住（<=158px）', s.h <= 160, JSON.stringify(s));
    ok('高度不超过视口 30%', s.h < s.ih * 0.32, JSON.stringify(s));
    ok('内容超出后转为框内滚动', s.scrollable, JSON.stringify(s));
    ok('滚动区确实是内容高度', s.scroll > s.client, JSON.stringify(s));
    await a.shot(`${OUT}/04-overflow.png`);
    console.log('  布局：' + JSON.stringify(await a.eval(`__layout()`)));

    console.log('\n[5] 发送后回到一行');
    await a.eval(`__click('发送')`);
    await sleep(600);
    s = await a.eval(`__ta()`);
    ok('清空草稿后高度回落', s.h <= 46, JSON.stringify(s));
    await a.shot(`${OUT}/05-after-send.png`);

    console.log('\n[6] 手机窄屏下同样封顶');
    await a.cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: false });
    await sleep(400);
    await a.eval(`document.querySelector('.conv-item')?.click()`);
    await sleep(600);
    await a.eval(`__setComposer(${JSON.stringify(ten)})`);
    await sleep(400);
    s = await a.eval(`__ta()`);
    ok('手机端也被夹住', s.h <= 160 && s.h < s.ih * 0.32, JSON.stringify(s));
    ok('手机端框内滚动', s.scrollable, JSON.stringify(s));
    await a.shot(`${OUT}/06-mobile-overflow.png`);
    console.log('  手机布局：' + JSON.stringify(await a.eval(`__layout()`)));
  } finally {
    a.kill();
    bob.kill();
  }
  console.log(`\n结果：${pass} 通过，${fails.length} 失败`);
  if (fails.length) { fails.forEach((f) => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('崩溃：', e); process.exit(1); });
