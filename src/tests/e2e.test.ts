/**
 * 端到端联测：真 HTTP + 真 WebSocket + 真加密，两个客户端互相收发
 * 前置：服务已在运行（scripts/run.sh），默认 http://127.0.0.1:8099
 * 用随机用户名，可重复跑，不会互相污染
 */
import WebSocket from 'ws';
import { createDeviceKeys, publicBundleOf } from '../shared/crypto/identity';
import { CryptoClient } from '../shared/crypto/client';
import type { PublicBundle } from '../shared/crypto/identity';
import type { C2S, S2C, WireBody, Payload } from '../shared/protocol';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const WS_BASE = BASE.replace(/^http/, 'ws');

let pass = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class TestClient {
  ws!: WebSocket;
  inbox: S2C[] = [];
  crypto: CryptoClient;
  username: string;
  deviceId: string;
  token = '';
  convs: any[] = [];

  constructor(username: string) {
    this.username = username;
    this.deviceId = `${username}-d1`;
    const keys = createDeviceKeys();
    this.crypto = new CryptoClient(username, this.deviceId, keys);
    this.bundle = publicBundleOf(keys);
  }
  bundle: any;

  async register() {
    const res = await fetch(`${BASE}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: this.username,
        displayName: this.username,
        password: 'secret123',
        bundle: { ...this.bundle, device: this.deviceId },
        invite: process.env.INVITE_CODE || 'dev-code',
      }),
    });
    const j: any = await res.json();
    if (!res.ok) throw new Error(`注册失败: ${j.error}`);
    this.token = j.token;
  }

  async connect() {
    // 令牌走首帧 auth（不再放 URL）
    this.ws = new WebSocket(`${WS_BASE}/ws`);
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as S2C;
      this.inbox.push(m);
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
    });
    this.send({ t: 'auth', token: this.token } as any);
    this.send({ t: 'hello', ...{ device: this.deviceId } } as any);
    const ready = await this.waitFor((m) => m.t === 'ready');
    this.convs = (ready as any).convs;
  }

  send(m: C2S | any) {
    this.ws.send(JSON.stringify(m));
  }

  async waitFor<T extends S2C>(pred: (m: S2C) => boolean, timeout = 4000): Promise<T> {
    const start = Date.now();
    let idx = 0;
    while (Date.now() - start < timeout) {
      for (; idx < this.inbox.length; idx++) {
        const m = this.inbox[idx];
        if (pred(m)) {
          this.inbox.splice(0, idx + 1);
          return m as T;
        }
      }
      await sleep(20);
    }
    throw new Error(`等待消息超时：${this.inbox.map((m) => m.t).join(',')}`);
  }

  async bundlesOf(user: string): Promise<Map<string, PublicBundle>> {
    this.send({ t: 'bundle', user });
    const r = await this.waitFor<any>((m) => m.t === 'bundles' && m.user === user);
    const map = new Map<string, PublicBundle>();
    for (const b of r.bundles) map.set(`${user}/${b.device}`, b.bundle);
    return map;
  }

  async fetchBundleSelf(): Promise<Map<string, PublicBundle>> {
    // 自己的公钥包直接从内存拿
    const map = new Map<string, PublicBundle>();
    map.set(`${this.username}/${this.deviceId}`, this.bundle);
    return map;
  }
}

async function main() {
  const stamp = Date.now().toString(36).slice(-5);
  const alice = new TestClient(`alice_${stamp}`);
  const bob = new TestClient(`bob_${stamp}`);

  console.log('\n[1] 注册 + 连接');
  await alice.register();
  await bob.register();
  ok('两个账号注册成功', alice.token.length > 10 && bob.token.length > 10);
  await alice.connect();
  await bob.connect();
  ok('双方 WebSocket 就绪', alice.convs !== null);

  console.log('\n[2] 建立直聊会话');
  alice.send({ t: 'createDirect', peer: bob.username });
  const convs = await alice.waitFor<any>((m) => m.t === 'convs');
  const conv = convs.convs.find((c: any) => c.kind === 'direct');
  ok('会话已建立', !!conv && conv.members.length === 2, JSON.stringify(convs.convs.map((c: any) => c.id)));

  console.log('\n[3] 直聊加密收发');
  const bobBundles = await alice.bundlesOf(bob.username);
  ok('拿到对方设备公钥包', bobBundles.size === 1);

  const e1 = await alice.crypto.encryptToDevices([{ user: bob.username, device: bob.deviceId }], bobBundles, { t: 'text', text: '你好，这是第一条加密消息' });
  ok('生成 1 份密文', e1.bodies.length === 1);
  alice.send({ t: 'send', conv: conv.id, bodies: e1.bodies.map((b) => ({ user: b.user, device: b.device, body: b.body })) });
  const sent = await alice.waitFor<any>((m) => m.t === 'sent');
  ok('服务端已落库', typeof sent.id === 'number');

  const incoming = await bob.waitFor<any>((m) => m.t === 'msg');
  const dec = await bob.crypto.decryptFrom(alice.username, alice.deviceId, incoming.msg.body as WireBody);
  ok('对方解出明文', dec.payload.t === 'text' && (dec.payload as any).text === '你好，这是第一条加密消息');
  ok('密文确实不含明文', JSON.stringify(incoming.msg.body).includes('加密消息') === false);

  console.log('\n[4] 回信与已读回执');
  const aliceBundles = await bob.bundlesOf(alice.username);
  const e2 = await bob.crypto.encryptToDevices([{ user: alice.username, device: alice.deviceId }], aliceBundles, { t: 'text', text: '收到，回你一条' });
  bob.send({ t: 'send', conv: conv.id, bodies: e2.bodies.map((b) => ({ user: b.user, device: b.device, body: b.body })) });
  await bob.waitFor((m) => m.t === 'sent');
  const inA = await alice.waitFor<any>((m) => m.t === 'msg');
  const decA = await alice.crypto.decryptFrom(bob.username, bob.deviceId, inA.msg.body as WireBody);
  ok('发起方解出回信', (decA.payload as any).text === '收到，回你一条');

  bob.send({ t: 'receipt', conv: conv.id, upto: sent.id });
  const rc = await alice.waitFor<any>((m) => m.t === 'receipt');
  ok('收到已读回执', rc.user === bob.username && rc.upto === sent.id);

  console.log('\n[5] 离线消息');
  bob.ws.close();
  await sleep(150);
  const e3 = await alice.crypto.encryptToDevices([{ user: bob.username, device: bob.deviceId }], bobBundles, { t: 'text', text: '你离线时发的' });
  alice.send({ t: 'send', conv: conv.id, bodies: e3.bodies.map((b) => ({ user: b.user, device: b.device, body: b.body })) });
  await alice.waitFor((m) => m.t === 'sent');
  await sleep(100);
  await bob.connect();
  const offline = await bob.waitFor<any>((m) => m.t === 'msg', 5000);
  const decO = await bob.crypto.decryptFrom(alice.username, alice.deviceId, offline.msg.body as WireBody);
  ok('重连后补收离线消息', (decO.payload as any).text === '你离线时发的');

  console.log('\n[6] 群聊：密钥分发 + 群消息');
  alice.send({ t: 'createGroup', name: '联测群', members: [bob.username] });
  const gc = await alice.waitFor<any>((m) => m.t === 'convs');
  const group = gc.convs.find((c: any) => c.kind === 'group');
  ok('群聊已创建', !!group && group.members.length === 2);
  // bob 会收到 memberChange
  await bob.waitFor((m) => m.t === 'memberChange');

  const bobBundles2 = await alice.bundlesOf(bob.username);
  const dist = await alice.crypto.buildSenderKeyDistribution(group.id.toString(), [{ user: bob.username, device: bob.deviceId }], bobBundles2);
  ok('生成群密钥分发密文', dist.bodies.length === 1);
  alice.send({ t: 'send', conv: group.id, bodies: dist.bodies.map((b) => ({ user: b.user, device: b.device, body: b.body })) });
  await alice.waitFor((m) => m.t === 'sent');
  const skdmMsg = await bob.waitFor<any>((m) => m.t === 'msg');
  await bob.crypto.decryptFrom(alice.username, alice.deviceId, skdmMsg.msg.body as WireBody);
  ok('对方收到群密钥', bob.crypto.hasPeerSenderKey(group.id.toString(), alice.username, alice.deviceId));

  const g1 = await alice.crypto.encryptGroup(group.id.toString(), { t: 'text', text: '这是群消息' });
  alice.send({ t: 'sendGroup', conv: group.id, body: g1 });
  await alice.waitFor((m) => m.t === 'sent');
  const gmsg = await bob.waitFor<any>((m) => m.t === 'msg');
  const gdec = await bob.crypto.decryptGroup(gmsg.msg.body as any);
  ok('对方解出群消息', (gdec as any).text === '这是群消息');

  console.log('\n[7] 历史记录');
  bob.send({ t: 'history', conv: group.id, limit: 50 });
  const hist = await bob.waitFor<any>((m) => m.t === 'history');
  ok('群历史可拉取', hist.msgs.length >= 1);

  bob.send({ t: 'history', conv: conv.id, limit: 50 });
  const hist2 = await bob.waitFor<any>((m) => m.t === 'history');
  const bodies = hist2.msgs.map((m: any) => JSON.stringify(m.body));
  ok('直聊历史里没有明文', bodies.every((b: string) => !b.includes('加密消息')));

  console.log('\n[8] 服务端统计');
  const health: any = await (await fetch(`${BASE}/api/health`)).json();
  ok('服务端有账号与消息', health.users >= 2 && health.messages >= 4, JSON.stringify(health));

  console.log(`\n结果：${pass} 通过，${fails.length} 失败`);
  if (fails.length) {
    for (const f of fails) console.log(' - ' + f);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('联测崩溃：', e);
  process.exit(1);
});
