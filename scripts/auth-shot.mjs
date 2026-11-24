/** 注册页截图（带邀请码输入框） */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import WebSocket from 'ws';
const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const OUT = 'out/screens/gate';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
const proc = spawn('/usr/local/bin/chromium', ['--headless=new', '--remote-debugging-port=9790', '--user-data-dir=/tmp/cim-gate-shot', '--no-sandbox', '--disable-gpu', '--window-size=1000,760', '--force-device-scale-factor=2', 'about:blank'], { stdio: 'ignore' });
let ws;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:9790/json/list')).json();
    const p = list.find((t) => t.type === 'page');
    if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((r) => ws.on('open', r)); break; }
  } catch {}
  await sleep(150);
}
let id = 0;
const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
const cmd = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await cmd('Page.enable');
await cmd('Page.navigate', { url: BASE });
await sleep(1000);
await cmd('Runtime.evaluate', { expression: `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='注册').click()`, awaitPromise: true });
await sleep(400);
await cmd('Runtime.evaluate', { expression: `(()=>{const f=[...document.querySelectorAll('.field')];const set=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};set(f[0].querySelector('input'),'zhulezhi');set(f[1].querySelector('input'),'朱乐轩');set(f[2].querySelector('input'),'pw123456');})()`, awaitPromise: true });
await sleep(300);
const r = await cmd('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(`${OUT}/register-invite.png`, Buffer.from(r.data, 'base64'));
console.log('ok ->', `${OUT}/register-invite.png`);
try { ws.close(); } catch {}
proc.kill('SIGKILL');
