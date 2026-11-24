/**
 * 浅色 / 深色两套主题在真实界面上的截图（桌面 + 手机 + 设置弹窗）
 * 用法：node scripts/mode-shots.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME || '/usr/local/bin/chromium';
const OUT = process.env.OUT_DIR || 'out/screens/modes';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Browser {
  constructor(port, profile) {
    this.port = port;
    this.profile = profile;
    this.id = 0;
    this.pending = new Map();
  }

  async launch(scale = 2) {
    fs.rmSync(this.profile, { recursive: true, force: true });
    this.proc = spawn(
      CHROME,
      [
        '--headless=new',
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${this.profile}`,
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--window-size=1280,860',
        `--force-device-scale-factor=${scale}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page) {
          this.ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
          await new Promise((res, rej) => {
            this.ws.on('open', res);
            this.ws.on('error', rej);
          });
          this.ws.on('message', (raw) => {
            const m = JSON.parse(raw.toString());
            if (m.id && this.pending.has(m.id)) {
              this.pending.get(m.id)(m);
              this.pending.delete(m.id);
            }
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
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 10000);
    });
  }

  async goto(url) {
    await this.cmd('Page.enable');
    await this.cmd('Runtime.enable');
    await this.cmd('Page.navigate', { url });
    await sleep(900);
  }

  async eval(expr) {
    const r = await this.cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  }

  async waitFor(expr, timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = await this.eval(expr);
      if (v) return v;
      await sleep(120);
    }
    return false;
  }

  async shot(path) {
    const r = await this.cmd('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path, Buffer.from(r.data, 'base64'));
    return path;
  }

  async setPref(mode) {
    await this.eval(`localStorage.setItem('cipherim.theme', ${JSON.stringify(mode)})`);
    await this.cmd('Page.reload');
    await sleep(900);
  }

  async mobile(on) {
    if (on) {
      await this.cmd('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
      });
    } else {
      await this.cmd('Emulation.clearDeviceMetricsOverride');
    }
    await sleep(500);
  }

  kill() {
    try { this.ws?.close(); } catch {}
    try { this.proc?.kill('SIGKILL'); } catch {}
  }
}

const HELPERS = `
window.__fillByLabel = (label, value) => {
  const fields = [...document.querySelectorAll('.field')];
  const f = fields.find(x => x.querySelector('span')?.textContent.includes(label));
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
true;
`;

async function register(b, username, displayName) {
  await b.waitFor(`!!document.querySelector('.auth-card')`);
  await b.eval(HELPERS);
  await b.eval(`__click('注册')`);
  await sleep(150);
  await b.eval(`__fillByLabel('用户名', ${JSON.stringify(username)})`);
  await b.eval(`__fillByLabel('昵称', ${JSON.stringify(displayName)})`);
  await b.eval(`__fillByLabel('口令', 'pw123456')`);
  await b.eval(`__fillByLabel('邀请码', 'dev-code')`);
  await sleep(120);
  await b.eval(`__click('注册并生成密钥')`);
  return b.waitFor(`!!document.querySelector('.app')`, 15000);
}

async function send(b, text) {
  await b.eval(`__setComposer(${JSON.stringify(text)})`);
  await sleep(100);
  await b.eval(`__click('发送')`);
  await sleep(400);
}

async function runMode(mode, idx) {
  const stamp = `m${idx}${Date.now().toString(36).slice(-3)}`;
  const alice = `ua${stamp}`;
  const bob = `ub${stamp}`;
  const portA = 9500 + idx * 2;
  const A = new Browser(portA, `/tmp/cim-mode-${mode}-a`);
  const B = new Browser(portA + 1, `/tmp/cim-mode-${mode}-b`);
  try {
    await A.launch();
    await B.launch();
    await A.goto(BASE);
    await B.goto(BASE);
    await A.setPref(mode);
    await B.setPref(mode);

    await A.waitFor(`!!document.querySelector('.auth-card')`);
    await A.shot(`${OUT}/auth-${mode}.png`);
    await register(A, alice, '朱乐轩');
    await register(B, bob, '季风');

    await A.eval(HELPERS);
    await A.eval(`__click('新会话')`);
    await sleep(250);
    await A.eval(`__fillByLabel('用户名', ${JSON.stringify(bob)})`);
    await sleep(250);
    await A.eval(`__click('建立会话')`);
    await A.waitFor(`document.querySelectorAll('.conv-item').length > 0`, 8000);
    await A.eval(`document.querySelector('.conv-item')?.click()`);
    await sleep(300);

    await B.eval(HELPERS);
    const bConv = await B.waitFor(`document.querySelectorAll('.conv-item').length > 0`, 10000);
    if (!bConv) throw new Error('B 未收到会话');
    await B.eval(`document.querySelector('.conv-item')?.click()`);
    await sleep(400);

    await send(B, 'VPS 那边 8100 端口已经起了，Caddy 反代还没配');
    await A.waitFor(`[...document.querySelectorAll('.row:not(.mine) .bubble')].length >= 1`, 10000);
    await send(A, '好，等会儿配。先把界面定下来');
    await send(A, '外观按扁平极简那套走：底色浅、层次只靠 1px 细线，强调色只留给状态点和未读角标。深色模式也一并做了，跟随系统。');
    await sleep(300);
    await send(B, '那先把深色看一眼，别到晚上刺眼');
    await A.waitFor(`[...document.querySelectorAll('.row:not(.mine) .bubble')].length >= 2`, 10000);
    await send(A, '图标也全换成线描 SVG 了，不再用 emoji');
    await A.waitFor(`document.querySelectorAll('.bubble').length >= 5`, 10000);
    await sleep(6000);

    await A.shot(`${OUT}/desktop-${mode}.png`);

    // 设置弹窗：外观三段选择器
    await A.eval(`document.querySelectorAll('.side-head button')[1].click()`);
    await sleep(400);
    await A.shot(`${OUT}/settings-${mode}.png`);
    await A.eval(`document.querySelector('.overlay')?.click()`);
    await sleep(300);

    // 手机窄屏：切到 390 宽后重新点一次会话，让侧边栏按窄屏规则折叠
    await A.mobile(true);
    await A.eval(`document.querySelector('.conv-item')?.click()`);
    await sleep(700);
    await A.shot(`${OUT}/mobile-${mode}.png`);
    await A.mobile(false);
    console.log(`  ✓ ${mode} 截图完成`);
  } finally {
    A.kill();
    B.kill();
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const modes = ['light', 'dark'];
  for (let i = 0; i < modes.length; i++) {
    console.log(`[${i + 1}/${modes.length}] ${modes[i]}`);
    await runMode(modes[i], i);
  }
  console.log(`输出目录：${OUT}`);
  process.exit(0);
})().catch((e) => {
  console.error('截图任务崩溃：', e);
  process.exit(1);
});
