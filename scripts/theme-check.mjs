/**
 * 主题系统校验：偏好 → data-theme 的解析、持久化、跟随系统、meta 配色、无 emoji 残留
 * 需要开发实例已在运行（BASE 默认 http://127.0.0.1:8099）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME || '/usr/local/bin/chromium';
const PORT = 9600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
};

class B {
  constructor() {
    this.id = 0;
    this.pending = new Map();
  }
  async launch() {
    fs.rmSync('/tmp/cim-themecheck', { recursive: true, force: true });
    this.proc = spawn(
      CHROME,
      ['--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/cim-themecheck', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,860', 'about:blank'],
      { stdio: 'ignore' },
    );
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page) {
          this.ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
          await new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
          this.ws.on('message', (raw) => {
            const m = JSON.parse(raw.toString());
            if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
          });
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
  async goto(url) {
    await this.cmd('Page.enable');
    await this.cmd('Runtime.enable');
    await this.cmd('Page.navigate', { url });
    await sleep(700);
  }
  eval(expr) {
    return this.cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value);
  }
  async reload() { await this.cmd('Page.reload'); await sleep(700); }
  async emulateDark(on) {
    await this.cmd('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: on ? 'dark' : 'light' }],
    });
    await sleep(200);
  }
  kill() { try { this.ws?.close(); } catch {} try { this.proc?.kill('SIGKILL'); } catch {} }
}

const state = `(() => ({
  theme: document.documentElement.dataset.theme,
  meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
  bg: getComputedStyle(document.body).backgroundColor,
}))()`;

(async () => {
  const b = new B();
  try {
    await b.launch();
    await b.emulateDark(false);
    await b.goto(BASE);
    await b.eval(`localStorage.removeItem('cipherim.theme')`);

    console.log('\n[1] 未设置偏好时跟随系统（系统浅色）');
    let s = await b.eval(state);
    ok('data-theme = light', s.theme === 'light', JSON.stringify(s));
    ok('meta theme-color = 浅色底', s.meta === '#F7F7F8', s.meta);

    console.log('\n[2] 系统切到深色（仍为跟随系统）');
    await b.emulateDark(true);
    await sleep(300);
    s = await b.eval(state);
    ok('data-theme 自动变 deep', s.theme === 'dark', JSON.stringify(s));
    ok('meta theme-color 跟着变', s.meta === '#0E0E10', s.meta);

    console.log('\n[3] 手动固定浅色后，系统深色不应影响');
    await b.eval(`localStorage.setItem('cipherim.theme','light')`);
    await b.goto(BASE);
    s = await b.eval(state);
    ok('固定浅色生效', s.theme === 'light', JSON.stringify(s));
    ok('深色系统下仍是浅色', s.bg === 'rgb(247, 247, 248)', s.bg);

    console.log('\n[4] 固定深色 + 刷新，首屏即深色（无闪烁语义）');
    await b.eval(`localStorage.setItem('cipherim.theme','dark')`);
    await b.emulateDark(false);
    await b.goto(BASE);
    s = await b.eval(state);
    ok('固定深色生效', s.theme === 'dark', JSON.stringify(s));
    ok('底色为深色', s.bg === 'rgb(14, 14, 16)', s.bg);

    console.log('\n[5] 界面里没有 emoji 残留');
    const text = await b.eval('document.body.innerText');
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u.test(text || '');
    ok('无 emoji 字符', !emoji, (text || '').slice(0, 60));
    const svgCount = await b.eval(`document.querySelectorAll('svg.icon').length`);
    ok('存在线描 SVG 图标', svgCount > 0, `svg=${svgCount}`);

    console.log('\n[6] 偏好回到跟随系统');
    await b.eval(`localStorage.setItem('cipherim.theme','system')`);
    await b.goto(BASE);
    s = await b.eval(state);
    ok('跟随系统（此时系统浅色）', s.theme === 'light', JSON.stringify(s));
  } finally {
    b.kill();
  }

  console.log(`\n结果：${pass} 通过，${fails.length} 失败`);
  if (fails.length) { fails.forEach((f) => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('崩溃：', e); process.exit(1); });
