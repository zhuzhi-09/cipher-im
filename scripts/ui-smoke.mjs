/**
 * 浏览器 UI 冒烟测试（CDP 驱动无头 chromium，不依赖 puppeteer）
 * 两个独立 profile 模拟两台设备：注册 → 建会话 → 互发消息 → 截图
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME || '/usr/local/bin/chromium';
const OUT = process.env.OUT_DIR || 'out/screens';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

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
        'about:blank',
      ],
      { stdio: 'ignore', detached: false },
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
      } catch {
        /* retry */
      }
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
    await sleep(800);
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
    try {
      this.ws?.close();
    } catch {}
    try {
      this.proc?.kill('SIGKILL');
    } catch {}
  }
}

// 页面内 helper：按文本点按钮、给受控 input 赋值（React 需要原生 setter + input 事件）
const HELPERS = `
window.__fill = (sel, value) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
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
  const btns = [...document.querySelectorAll('button')];
  const b = btns.find(x => x.textContent.trim() === text);
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
window.__text = () => document.body.innerText;
true;
`;

async function register(b, username, displayName, password) {
  await b.waitFor(`!!document.querySelector('.auth-card')`);
  await b.eval(HELPERS);
  await b.eval(`__click('注册')`);
  await sleep(150);
  await b.eval(`__fillByLabel('用户名', ${JSON.stringify(username)})`);
  await b.eval(`__fillByLabel('昵称', ${JSON.stringify(displayName)})`);
  await b.eval(`__fillByLabel('口令', ${JSON.stringify(password)})`);
  await b.eval(`__fillByLabel('邀请码', 'dev-code')`);
  await sleep(120);
  await b.eval(`__click('注册并生成密钥')`);
  return b.waitFor(`!!document.querySelector('.app')`, 15000);
}

async function main() {
  const stamp = Date.now().toString(36).slice(-4);
  const alice = `ua${stamp}`;
  const bob = `ub${stamp}`;
  const A = new Browser(9333, '/tmp/cim-profile-a');
  const B = new Browser(9334, '/tmp/cim-profile-b');

  try {
    await A.launch();
    await B.launch();
    await A.goto(BASE);
    await B.goto(BASE);

    console.log('\n[1] 注册两个账号（密钥在浏览器本地生成）');
    const aOk = await register(A, alice, 'Alice', 'pw123456');
    const bOk = await register(B, bob, 'Bob', 'pw123456');
    ok('A 注册后进入主界面', !!aOk);
    ok('B 注册后进入主界面', !!bOk);
    await A.shot(`${OUT}/01-a-main.png`);
    await B.shot(`${OUT}/02-b-main.png`);

    console.log('\n[2] A 发起会话');
    await A.eval(HELPERS);
    await A.eval(`__click('新会话')`);
    await sleep(200);
    const hasDialog = await A.eval(`!!document.querySelector('.dialog')`);
    ok('新会话弹窗打开', !!hasDialog);
    await A.eval(`__fillByLabel('用户名', ${JSON.stringify(bob)})`);
    await sleep(200);
    await A.eval(`__click('建立会话')`);
    const convAppeared = await A.waitFor(`document.querySelectorAll('.conv-item').length > 0`, 8000);
    ok('会话出现在列表', !!convAppeared);

    console.log('\n[3] A 发送加密消息');
    await A.eval(`document.querySelector('.conv-item')?.click()`);
    await sleep(300);
    await A.eval(`__setComposer('你好 Bob，这是浏览器里发的端到端加密消息')`);
    await sleep(120);
    await A.eval(`__click('发送')`);
    const sent = await A.waitFor(`[...document.querySelectorAll('.row.mine .bubble')].some(b => b.innerText.includes('端到端加密消息'))`, 8000);
    ok('A 界面出现自己的消息气泡', !!sent);
    await A.shot(`${OUT}/03-a-sent.png`);

    console.log('\n[4] B 收到并解密');
    await B.eval(HELPERS);
    const bConv = await B.waitFor(`document.querySelectorAll('.conv-item').length > 0`, 10000);
    ok('B 侧出现新会话（服务端推送）', !!bConv);
    await B.eval(`document.querySelector('.conv-item')?.click()`);
    const received = await B.waitFor(`[...document.querySelectorAll('.bubble')].some(b => b.innerText.includes('端到端加密消息'))`, 10000);
    ok('B 成功解密并显示明文', !!received);
    await B.shot(`${OUT}/04-b-received.png`);

    console.log('\n[5] B 回信，A 收到');
    await B.eval(`__setComposer('收到，我这边也能解密')`);
    await sleep(120);
    await B.eval(`__click('发送')`);
    await sleep(300);
    const aGot = await A.waitFor(`[...document.querySelectorAll('.bubble')].some(b => b.innerText.includes('我这边也能解密'))`, 10000);
    ok('A 收到 B 的回信', !!aGot);
    await A.shot(`${OUT}/05-a-reply.png`);

    console.log('\n[6] 刷新页面后仍可解锁并读取历史');
    await A.goto(BASE);
    const unlockShown = await A.waitFor(`!!document.querySelector('.auth-card') || !!document.querySelector('.app')`, 5000);
    const needsUnlock = await A.eval(`document.body.innerText.includes('解锁本地密钥库')`);
    ok('刷新后出现解锁界面（密钥库已持久化）', needsUnlock === true, String(unlockShown));
    await A.eval(HELPERS);
    await A.eval(`__fillByLabel('口令', 'pw123456')`);
    await sleep(100);
    await A.eval(`__click('解锁')`);
    const back = await A.waitFor(`!!document.querySelector('.app')`, 10000);
    ok('口令正确可回到主界面', !!back);
    const stillHasConv = await A.waitFor(`document.querySelectorAll('.conv-item').length > 0`, 8000);
    ok('解锁后会话列表仍在', !!stillHasConv);
    await A.eval(`document.querySelector('.conv-item')?.click()`);
    const history = await A.waitFor(`[...document.querySelectorAll('.bubble')].some(b => b.innerText.includes('端到端加密消息'))`, 10000);
    ok('解锁后历史消息可解密显示', !!history);
    await A.shot(`${OUT}/06-a-after-reload.png`);
  } finally {
    A.kill();
    B.kill();
  }

  console.log(`\n结果：${pass} 通过，${fails.length} 失败`);
  if (fails.length) {
    for (const f of fails) console.log(' - ' + f);
    process.exit(1);
  }
  console.log(`截图目录：${OUT}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('UI 冒烟测试崩溃：', e);
  process.exit(1);
});
