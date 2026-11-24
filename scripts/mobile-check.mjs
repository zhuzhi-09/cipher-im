/**
 * 手机端布局回归：会话打开时侧栏不得占位（否则聊天被挤到下面），点 ☰ 时侧栏必须是整屏覆盖层
 * 用法：node scripts/mobile-check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const OUT = 'out/screens/mobile';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fails.push(n); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); } };

class B {
  constructor() { this.id = 0; this.pending = new Map(); }
  async launch(port, profile, w, h, dpr = 2) {
    fs.rmSync(profile, { recursive: true, force: true });
    this.proc = spawn('/usr/local/bin/chromium', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--window-size=${w},${h}`, `--force-device-scale-factor=${dpr}`, 'about:blank'], { stdio: 'ignore' });
    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const p = list.find((t) => t.type === 'page');
        if (p) { this.ws = new WebSocket(p.webSocketDebuggerUrl, { perMessageDeflate: false }); await new Promise((r, j) => { this.ws.on('open', r); this.ws.on('error', j); }); this.ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } }); return; }
      } catch {}
      await sleep(150);
    }
    throw new Error('浏览器启动失败');
  }
  cmd(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 12000); }); }
  async goto(url) { await this.cmd('Page.enable'); await this.cmd('Runtime.enable'); await this.cmd('Page.navigate', { url }); await sleep(900); }
  eval(e) { return this.cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value); }
  async waitFor(e, t = 12000) { const t0 = Date.now(); while (Date.now() - t0 < t) { const v = await this.eval(e); if (v) return v; await sleep(120); } return false; }
  async shot(p) { const r = await this.cmd('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(p, Buffer.from(r.data, 'base64')); }
  kill() { try { this.ws?.close(); } catch {} try { this.proc?.kill('SIGKILL'); } catch {} }
}

const HELPERS = `
window.__fill=(label,v)=>{const f=[...document.querySelectorAll('.field')].find(x=>x.querySelector('span')?.textContent.includes(label));if(!f)return false;const el=f.querySelector('input,textarea');const p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));return true};
window.__click=(t)=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===t||x.getAttribute('aria-label')===t);if(!b)return false;b.click();return true};
window.__send=(t)=>{const el=document.querySelector('.composer textarea');if(!el)return false;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,t);el.dispatchEvent(new Event('input',{bubbles:true}));return true};
window.__rect=(sel)=>{const el=document.querySelector(sel);return el?el.getBoundingClientRect().toJSON():null};
window.__bubbles=()=>[...document.querySelectorAll('.bubble')].map(b=>b.textContent.trim());
true;`;

const stamp = Date.now().toString(36).slice(-4);
const AL = `ma${stamp}`, BO = `mb${stamp}`;

async function reg(b, user, name) {
  await b.waitFor(`!!document.querySelector('.auth-card')`);
  await b.eval(HELPERS);
  await b.eval(`__click('注册')`); await sleep(150);
  await b.eval(`__fill('用户名','${user}')`);
  await b.eval(`__fill('昵称','${name}')`);
  await b.eval(`__fill('口令','pw123456')`);
  await b.eval(`__fill('邀请码','dev-code')`);
  await b.eval(`__click('注册并生成密钥')`);
  return b.waitFor(`!!document.querySelector('.app')`, 20000);
}

(async () => {
  const A = new B(), Bo = new B();
  try {
    await A.launch(9811, '/tmp/cim-mob-a', 430, 932);
    await Bo.launch(9812, '/tmp/cim-mob-b', 430, 932);
    await A.goto(BASE); await Bo.goto(BASE);
    ok('A 注册成功（430×932 视口）', !!(await reg(A, AL, '课桌一号')));
    ok('B 注册成功', !!(await reg(Bo, BO, '季风')));

    await A.eval(`__click('新会话')`); await sleep(300);
    await A.eval(`__fill('用户名','${BO}')`); await sleep(300);
    await A.eval(`__click('建立会话')`);
    await A.waitFor(`document.querySelectorAll('.conv-item').length > 0`);

    console.log('\n[1] 打开会话后：侧栏必须完全退出布局');
    await A.eval(`document.querySelector('.conv-item').click()`);
    await sleep(600);
    const s1 = await A.eval(`({ sid: !!document.querySelector('.sidebar'), main: __rect('.main'), ih: innerHeight })`);
    ok('侧栏已不渲染', s1.sid === false, JSON.stringify(s1));
    ok('聊天区从屏幕顶部开始', Math.round(s1.main.top) === 0, JSON.stringify(s1.main));
    ok('聊天区铺满整个视口高度', Math.abs(s1.main.height - s1.ih) < 2, JSON.stringify({ h: s1.main.height, ih: s1.ih }));

    await Bo.waitFor(`document.querySelectorAll('.conv-item').length > 0`, 12000);
    await Bo.eval(`document.querySelector('.conv-item').click()`);
    await Bo.eval(`__send('手机端测试：这条要能正常收到')`); await sleep(120);
    await Bo.eval(`__click('发送')`);
    await A.waitFor(`__bubbles().some(t=>t.includes('手机端测试'))`);
    await A.shot(`${OUT}/01-chat-fullscreen.png`);

    console.log('\n[2] 点 ☰：侧栏应当是整屏覆盖层，不能把聊天挤下去');
    await A.eval(`__click('会话列表')`);
    await sleep(500);
    const s2 = await A.eval(`({ side: __rect('.sidebar'), main: __rect('.main'), ih: innerHeight, iw: innerWidth })`);
    ok('侧栏覆盖整屏', s2.side && Math.abs(s2.side.height - s2.ih) < 2 && s2.side.width >= s2.iw - 1, JSON.stringify(s2.side));
    ok('聊天区没有被挤动（仍在顶部且满高）', Math.round(s2.main.top) === 0 && Math.abs(s2.main.height - s2.ih) < 2, JSON.stringify(s2.main));
    await A.shot(`${OUT}/02-sidebar-overlay.png`);

    console.log('\n[3] 覆盖层可以关掉');
    const closed = await A.eval(`__click('关闭会话列表')`);
    await sleep(300);
    const s3 = await A.eval(`({ sid: !!document.querySelector('.sidebar'), main: __rect('.main'), ih: innerHeight })`);
    ok('有关闭按钮且点击后侧栏消失', closed === true && s3.sid === false, JSON.stringify(s3));
    ok('关闭后聊天仍是满屏', Math.abs(s3.main.height - s3.ih) < 2, JSON.stringify(s3.main));
    await A.shot(`${OUT}/03-back-to-chat.png`);

    console.log('\n[4] 桌面端不受影响（1280 双栏）');
    const D = new B();
    await D.launch(9813, '/tmp/cim-mob-d', 1280, 860, 1);
    await D.goto(BASE);
    ok('桌面端侧栏仍在左侧固定 300px', await (async () => {
      const r = await D.eval(`({ side: __rect('.sidebar'), main: __rect('.main'), iw: innerWidth })`);
      return r.side && Math.abs(r.side.width - 300) < 2 && Math.abs(r.main.left - 300) < 2;
    })());
    await D.shot(`${OUT}/04-desktop-columns.png`);
    D.kill();
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    A.kill(); Bo.kill();
  }
  console.log(`\n手机布局 ${pass}/${pass + fails.length}`);
  if (fails.length) console.log('失败：' + fails.join('；'));
  if (fails.length) process.exitCode = 1;
})();
