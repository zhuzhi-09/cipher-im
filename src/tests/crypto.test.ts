/** 加密内核自测：不依赖网络与服务器，纯算法与协议行为验证 */
import {
  Bytes,
  toB64,
  fromB64,
  randomBytes,
  aeadSeal,
  aeadOpen,
  equal,
  concat,
  utf8,
  sha256,
} from '../shared/crypto/primitives';
import {
  createDeviceKeys,
  publicBundleOf,
  verifyBundle,
  createOpks,
} from '../shared/crypto/identity';
import { x3dhInitiate, x3dhRespond } from '../shared/crypto/x3dh';
import { CryptoClient, senderKeyMapKey } from '../shared/crypto/client';
import { safetyNumber } from '../shared/crypto/fingerprint';
import type { PublicBundle } from '../shared/crypto/identity';
import type { Payload } from '../shared/protocol';

let pass = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function expectThrow(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    ok(name, false, '本应抛错但成功了');
  } catch {
    ok(name, true);
  }
}

function mkClient(name: string) {
  const keys = createDeviceKeys();
  const client = new CryptoClient(name, `${name}-dev1`, keys);
  return { keys, client, bundle: publicBundleOf(keys) };
}

async function main() {
  console.log('\n[1] 编码与 AEAD 基础');
  for (const n of [0, 1, 3, 5, 32, 100]) {
    const b = randomBytes(n);
    ok(`base64 往返 ${n}B`, equal(fromB64(toB64(b)), b));
  }
  {
    const key = randomBytes(32);
    const pt = utf8('机密内容 secret');
    const aad = utf8('ctx');
    const ct = await aeadSeal(key, pt, aad);
    ok('AES-GCM 加解密', equal(await aeadOpen(key, ct, aad), pt));
    const bad = new Uint8Array(ct);
    bad[0] ^= 1;
    await expectThrow('AES-GCM 篡改被拒', () => aeadOpen(key, bad, aad));
    await expectThrow('AAD 不匹配被拒', () => aeadOpen(key, ct, utf8('ctx2')));
  }

  console.log('\n[2] 预密钥包签名校验');
  {
    const a = mkClient('alice');
    ok('合法包校验通过', verifyBundle(a.bundle));
    const forged = { ...a.bundle, spkPub: toB64(randomBytes(32)) };
    ok('伪造 SPK 被检出', !verifyBundle(forged));
  }

  console.log('\n[3] X3DH 双方派生一致');
  {
    const a = mkClient('alice2');
    const b = mkClient('bob2');
    const init = x3dhInitiate(a.keys.identity, b.bundle);
    const resp = x3dhRespond({
      selfDhPriv: b.keys.identity.dhPriv,
      selfIkDhPub: b.keys.identity.ikDhPub,
      spkPriv: b.keys.spk.priv,
      opkPriv: b.keys.opks[0].priv,
      initiatorIkDhPub: a.keys.identity.ikDhPub,
      initiatorEkPub: init.ekPub,
    });
    ok('SK 一致', equal(init.sk, resp.sk));
    ok('AD 一致', equal(init.ad, resp.ad));
    ok('OPK 被标记消耗', init.opkId === b.keys.opks[0].id);
  }

  console.log('\n[4] 直聊：预密钥消息 + 双向棘轮');
  {
    const a = mkClient('alice3');
    const b = mkClient('bob3');
    const bundles = new Map([[`bob3/bob3-dev1`, b.bundle]]);

    const m1 = await a.client.encryptToDevices([{ user: 'bob3', device: 'bob3-dev1' }], bundles, { t: 'text', text: '第一条' });
    ok('首条为 prekey 信封', m1.bodies[0].body.kind === 'prekey');
    const d1 = await b.client.decryptFrom('alice3', 'alice3-dev1', m1.bodies[0].body);
    ok('B 解出明文', d1.payload.t === 'text' && (d1.payload as any).text === '第一条');
    ok('B 由本条新建会话', d1.created === true);

    const m2 = await a.client.encryptToDevices([{ user: 'bob3', device: 'bob3-dev1' }], bundles, { t: 'text', text: '第二条' });
    ok('对端未回复前继续带预密钥头', m2.bodies[0].body.kind === 'prekey');
    const d2 = await b.client.decryptFrom('alice3', 'alice3-dev1', m2.bodies[0].body);
    ok('B 用同一链解出第二条', (d2.payload as any).text === '第二条');

    // B 回信：注意 B 需要 A 的公钥包才能建会话（真实场景从服务端取）
    const aBundle = a.bundle;
    const r1 = await b.client.encryptToDevices([{ user: 'alice3', device: 'alice3-dev1' }], new Map([['alice3/alice3-dev1', aBundle]]), { t: 'text', text: 'B 回复' });
    const rd = await a.client.decryptFrom('bob3', 'bob3-dev1', r1.bodies[0].body);
    ok('A 解出 B 的回复', (rd.payload as any).text === 'B 回复');

    const m3 = await a.client.encryptToDevices([{ user: 'bob3', device: 'bob3-dev1' }], bundles, { t: 'text', text: '棘轮已转动后' });
    const d3 = await b.client.decryptFrom('alice3', 'alice3-dev1', m3.bodies[0].body);
    ok('DH 棘轮转动后仍可解', (d3.payload as any).text === '棘轮已转动后');
  }

  console.log('\n[5] 乱序、重放、篡改');
  {
    const a = mkClient('alice4');
    const b = mkClient('bob4');
    const bundles = new Map([[`bob4/bob4-dev1`, b.bundle]]);
    const target = [{ user: 'bob4', device: 'bob4-dev1' }];

    const msgs: Bytes[] = [];
    const texts = ['m0', 'm1', 'm2', 'm3'];
    for (let i = 0; i < texts.length; i++) {
      const e = await a.client.encryptToDevices(target, bundles, { t: 'text', text: texts[i] });
      msgs.push(e.bodies[0].body as any);
    }
    // 先收 3，再收 0、2，最后 1
    const order = [3, 0, 2, 1];
    const got: string[] = new Array(4).fill('');
    for (const i of order) {
      const d = await b.client.decryptFrom('alice4', 'alice4-dev1', msgs[i] as any);
      got[i] = (d.payload as any).text;
    }
    ok('乱序四条全部解出', got.join(',') === texts.join(','), got.join(','));

    await expectThrow('重放同一报文被拒', async () => {
      await b.client.decryptFrom('alice4', 'alice4-dev1', msgs[0] as any);
    });

    const e = await a.client.encryptToDevices(target, bundles, { t: 'text', text: 'tamper' });
    const body = JSON.parse(JSON.stringify(e.bodies[0].body));
    const raw = fromB64(body.ct);
    raw[5] ^= 0xff;
    body.ct = toB64(raw);
    await expectThrow('篡改密文被拒', async () => {
      await b.client.decryptFrom('alice4', 'alice4-dev1', body);
    });
  }

  console.log('\n[6] 多轮棘轮（10 轮来回，每轮多条）');
  {
    const a = mkClient('alice5');
    const b = mkClient('bob5');
    const aBun = new Map([['bob5/bob5-dev1', b.bundle]]);
    const bBun = new Map([['alice5/alice5-dev1', a.bundle]]);
    const at = [{ user: 'bob5', device: 'bob5-dev1' }];
    const bt = [{ user: 'alice5', device: 'alice5-dev1' }];

    let lastA = '';
    let lastB = '';
    for (let round = 0; round < 10; round++) {
      for (let k = 0; k < 2; k++) {
        const txt = `A-r${round}-${k}`;
        const e = await a.client.encryptToDevices(at, aBun, { t: 'text', text: txt });
        const d = await b.client.decryptFrom('alice5', 'alice5-dev1', e.bodies[0].body);
        lastA = (d.payload as any).text;
      }
      const txt = `B-r${round}`;
      const e = await b.client.encryptToDevices(bt, bBun, { t: 'text', text: txt });
      const d = await a.client.decryptFrom('bob5', 'bob5-dev1', e.bodies[0].body);
      lastB = (d.payload as any).text;
    }
    ok('多轮后末条一致', lastA === 'A-r9-1' && lastB === 'B-r9', `${lastA} / ${lastB}`);
  }

  console.log('\n[7] 群组：发送者密钥分发与解密');
  {
    const a = mkClient('alice6');
    const b = mkClient('bob6');
    const c = mkClient('carol6');
    const gid = 'g-test-1';

    // A 需要 B、C 的公钥包来分发自己的群密钥
    const bundlesForA = new Map([
      ['bob6/bob6-dev1', b.bundle],
      ['carol6/carol6-dev1', c.bundle],
    ]);
    const dist = await a.client.buildSenderKeyDistribution(
      gid,
      [
        { user: 'bob6', device: 'bob6-dev1' },
        { user: 'carol6', device: 'carol6-dev1' },
      ],
      bundlesForA,
    );
    for (const d of dist.bodies) {
      if (d.user === 'bob6') await b.client.decryptFrom('alice6', 'alice6-dev1', d.body);
      else await c.client.decryptFrom('alice6', 'alice6-dev1', d.body);
    }
    ok('B 收到 A 的群密钥', b.client.hasPeerSenderKey(gid, 'alice6', 'alice6-dev1'));
    ok('C 收到 A 的群密钥', c.client.hasPeerSenderKey(gid, 'alice6', 'alice6-dev1'));

    const g1 = await a.client.encryptGroup(gid, { t: 'text', text: '群消息1' });
    const bd1 = await b.client.decryptGroup(g1);
    const cd1 = await c.client.decryptGroup(g1);
    ok('B 解出群消息1', (bd1 as any).text === '群消息1');
    ok('C 解出群消息1', (cd1 as any).text === '群消息1');

    const g2 = await a.client.encryptGroup(gid, { t: 'text', text: '群消息2' });
    ok('B 解出群消息2', (await b.client.decryptGroup(g2) as any).text === '群消息2');

    await expectThrow('群消息倒序解密被拒', async () => {
      const g1body = JSON.parse(JSON.stringify(g1));
      await b.client.decryptGroup(g1body);
    });

    await expectThrow('keyId 不匹配被拒', async () => {
      const g1body = { ...JSON.parse(JSON.stringify(g2)), keyId: 'ffff' };
      await c.client.decryptGroup(g1body);
    });

    // 成员变动后轮换：旧 keyId 的密文应解不开
    a.client.rotateOwnSenderKey(gid);
    const g3 = await a.client.encryptGroup(gid, { t: 'text', text: '轮换后' });
    await expectThrow('轮换后旧密钥设备无法解密', async () => {
      await b.client.decryptGroup(g3);
    });
    ok('轮换产生新 keyId', g3.keyId !== g1.keyId);
  }

  console.log('\n[8] 文件加密（随机密钥 + AEAD）');
  {
    const file = randomBytes(200 * 1024);
    const key = randomBytes(32);
    const ct = await aeadSeal(key, file, utf8('blob'));
    ok('文件密文往返一致', equal(await aeadOpen(key, ct, utf8('blob')), file));
    const bad = new Uint8Array(ct);
    bad[bad.length - 1] ^= 1;
    await expectThrow('文件密文篡改被拒', () => aeadOpen(key, bad, utf8('blob')));
  }

  console.log('\n[9] 安全码');
  {
    const a = mkClient('alice7');
    const b = mkClient('bob7');
    const s1 = safetyNumber(a.keys.identity.ikSigPub, b.keys.identity.ikSigPub);
    const s2 = safetyNumber(b.keys.identity.ikSigPub, a.keys.identity.ikSigPub);
    ok('双方安全码一致', s1 === s2);
    ok('安全码为 60 位数字', /^\d{60}$/.test(s1), s1);
    const c = mkClient('carol7');
    ok('与第三方安全码不同', safetyNumber(a.keys.identity.ikSigPub, c.keys.identity.ikSigPub) !== s1);
  }

  console.log(`\n结果：${pass} 通过，${failures.length} 失败`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log(' - ' + f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n自测崩溃：', e);
  process.exit(1);
});
