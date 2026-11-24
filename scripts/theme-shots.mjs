/**
 * UI 风格候选截图：对每个主题跑一遍真实交互（注册 → 建会话 → 互发消息）再截图
 * 用法：node scripts/theme-shots.mjs [theme1 theme2 ...]   默认四个候选
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME || '/usr/local/bin/chromium';
const OUT = process.env.OUT_DIR || 'out/screens/themes';
const THEMES = process.argv.slice(2).length ? process.argv.slice(2) : ['md3', 'flat', 'paper', 'swiss'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Browser {
  constructor(port, profile) {
    this.port = port;
    this.profile = profile;
    this.id = 0;
    this.pending = new Map();
  }

  async launch() {
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
        '--force-device-scale-factor=2',
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

  kill() {
    try { this.ws?.close(); } catch {}
    try { this.proc?.kill('SIGKILL'); } catch {}
  }
}

const HELPERS = `
window.__fill = (sel, value) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
};
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

async function runTheme(theme, idx) {
  const stamp = `t${idx}${Date.now().toString(36).slice(-3)}`;
  const alice = `ua${stamp}`;
  const bob = `ub${stamp}`;
  const portA = 9400 + idx * 2;
  const portB = portA + 1;
  const A = new Browser(portA, `/tmp/cim-th-${theme}-a`);
  const B = new Browser(portB, `/tmp/cim-th-${theme}-b`);
  try {
    await A.launch();
    await B.launch();
    await A.goto(`${BASE}/?theme=${theme}`);
    await B.goto(`${BASE}/?theme=${theme}`);

    // 登录页也截一张，风格判断不能只看聊天页
    await A.waitFor(`!!document.querySelector('.auth-card')`);
    await A.shot(`${OUT}/auth-${theme}.png`);

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

    // B 侧要等会话推送到，再点开，才能双向都有气泡
    await B.eval(HELPERS);
    const bConv = await B.waitFor(`document.querySelectorAll('.conv-item').length > 0`, 10000);
    if (!bConv) throw new Error('B 侧未收到会话');
    await B.eval(`document.querySelector('.conv-item')?.click()`);
    await sleep(400);

    // 对话：对方先开口 → 我方长段落 → 我方补充
    await send(B, 'VPS 那边 8100 端口已经起了，Caddy 反代还没配');
    await A.waitFor(`[...document.querySelectorAll('.row:not(.mine) .bubble')].length >= 1`, 10000);
    await send(A, '好，等会儿配。先把界面定下来');
    await send(A, '现在这套深色界面信息密度太高了，配色也偏重。想换成更克制的方向：底色浅、层次靠留白和细线区分，强调色只出现在发送键和未读提示上。');
    await sleep(300);
    await send(B, '那就先看几版，选一个再细调');
    await A.waitFor(`[...document.querySelectorAll('.row:not(.mine) .bubble')].length >= 2`, 10000);
    await send(A, '嗯，四种都跑通了加密链路，只是外壳不同');

    await A.waitFor(`document.querySelectorAll('.bubble').length >= 5`, 10000);
    await sleep(8000); // 等“正在输入”提示自己消失，别把状态截进候选图
    await sleep(500);
    await A.shot(`${OUT}/chat-${theme}.png`);
    console.log(`  ✓ ${theme} 截图完成`);
  } catch (e) {
    console.error(`  ✗ ${theme} 失败：${e.message}`);
    throw e;
  } finally {
    A.kill();
    B.kill();
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (let i = 0; i < THEMES.length; i++) {
    console.log(`[${i + 1}/${THEMES.length}] ${THEMES[i]}`);
    await runTheme(THEMES[i], i);
  }
  console.log(`输出目录：${OUT}`);
  process.exit(0);
})().catch((e) => {
  console.error('截图任务崩溃：', e);
  process.exit(1);
});
