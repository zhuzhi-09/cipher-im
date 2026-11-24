/**
 * 导出加密兼容测试数据：spec/vectors/crypto-v1.json
 * 用法：bash scripts/vectors.sh export
 *
 * 所有随机数来自 rng.ts 的确定性流，重复导出结果完全一样。
 * 字节约定：primitives 段用 hex；其余（密钥、线格式）沿用协议里的标准 base64。
 */
import fs from 'node:fs';
import path from 'node:path';
import { installDeterministicRng, setRng, rngBytes } from './rng';
import {
  sha256,
  hkdf,
  hmacSha256,
  dhPubFromPriv,
  dh,
  sigPub,
  sign,
  aeadSeal,
  aeadSealRandom,
  pbkdf2,
  toHex,
  toB64,
  fromB64,
  utf8,
  concat,
} from '../../shared/crypto/primitives';
import { createDeviceKeys, publicBundleOf, DeviceKeys, PublicBundle, createIdentity } from '../../shared/crypto/identity';
import { x3dhInitiate, x3dhRespond } from '../../shared/crypto/x3dh';
import { safetyNumber, shortFingerprint } from '../../shared/crypto/fingerprint';
import { createRoamKeys, sealForRoam, wrapRoamPriv } from '../../shared/crypto/roam';
import { Party, serializeKeys, Step, StepIn, World } from './ops';

installDeterministicRng();

const hex = toHex;

/**
 * 服务端给出的预密钥包：从第 from 枚开始带 n 枚 OPK（X3DH 只用第一枚）。
 * 真实服务端每发一次包就消耗掉发出去的 OPK，所以同一枚不会给两个人——脚本里也要避免重复使用。
 */
function bundle(keys: DeviceKeys, opkCount: number, from = 0): PublicBundle {
  const b = publicBundleOf(keys);
  return { ...b, opks: b.opks.slice(from, from + opkCount) };
}

async function primitives() {
  setRng('primitives');
  const inputs = [new Uint8Array(0), utf8('abc'), utf8('CipherIM 端到端'), rngBytes(200)];
  const sha = inputs.map((b) => ({ in: hex(b), out: hex(sha256(b)) }));

  const hk = [
    { ikm: rngBytes(32), salt: new Uint8Array(32), info: 'CipherIM-X3DH-v1', len: 32 },
    { ikm: rngBytes(32), salt: rngBytes(32), info: 'CipherIM-RK-v1', len: 64 },
    { ikm: rngBytes(32), salt: rngBytes(32), info: 'CipherIM-roam-v1', len: 32 },
  ].map((c) => ({ ikm: hex(c.ikm), salt: hex(c.salt), info: c.info, len: c.len, out: hex(hkdf(c.ikm, c.salt, c.info, c.len)) }));

  const hm = [Uint8Array.of(1), Uint8Array.of(2), rngBytes(50)].map((d) => {
    const key = rngBytes(32);
    return { key: hex(key), data: hex(d), out: hex(hmacSha256(key, d)) };
  });

  const x = Array.from({ length: 3 }, () => {
    const a = rngBytes(32);
    const b = rngBytes(32);
    return { priv: hex(a), pub: hex(dhPubFromPriv(a)), peerPub: hex(dhPubFromPriv(b)), shared: hex(dh(a, dhPubFromPriv(b))) };
  });

  const ed = [new Uint8Array(0), utf8('CipherIM-SPK-v1'), rngBytes(77)].map((msg) => {
    const seed = rngBytes(32);
    return { seed: hex(seed), pub: hex(sigPub(seed)), msg: hex(msg), sig: hex(sign(seed, msg)) };
  });

  const aead = [];
  for (const [pt, aad] of [
    [new Uint8Array(0), new Uint8Array(0)],
    [utf8('{"t":"text","text":"你好"}'), rngBytes(70)],
    [rngBytes(1000), utf8('blob')],
  ] as const) {
    const key = rngBytes(32);
    const nonce = sha256(concat(key, utf8('aead-nonce'))).slice(0, 12);
    aead.push({ key: hex(key), nonce: hex(nonce), pt: hex(pt), aad: hex(aad), ct: hex(await aeadSeal(key, pt, aad)) });
  }

  const aeadRandom = [];
  for (const [i, pt] of [utf8('vault'), rngBytes(33)].entries()) {
    const key = rngBytes(32);
    const aad = utf8('CipherIM-roam-key-v1');
    const label = `aeadRandom-${i}`;
    setRng(label);
    const packed = await aeadSealRandom(key, pt, aad);
    aeadRandom.push({ rng: label, key: hex(key), pt: hex(pt), aad: hex(aad), packed: hex(packed) });
  }

  setRng('pbkdf2');
  const pb = [];
  for (const [pw, iter] of [
    ['password', 1000],
    ['口令 with 空格', 1000],
    ['correct horse battery staple', 200000],
  ] as const) {
    const salt = rngBytes(32);
    pb.push({ password: pw, salt: hex(salt), iterations: iter, out: hex(await pbkdf2(pw, salt, iter)) });
  }

  const b64 = [0, 1, 2, 3, 4, 5, 31, 32, 33].map((n) => {
    const b = rngBytes(n);
    return { hex: hex(b), b64: toB64(b) };
  });

  return { sha256: sha, hkdf: hk, hmac: hm, x25519: x, ed25519: ed, aead, aeadRandom, pbkdf2: pb, base64: b64 };
}

function identities() {
  const out = [];
  for (const [label, n] of [
    ['identity-a', 2],
    ['identity-b', 0],
  ] as const) {
    setRng(label);
    out.push({ rng: label, opkCount: n, keys: serializeKeys(createDeviceKeys(n)) });
  }
  // 单独的 createIdentity，验证「Ed25519 种子 → X25519 私钥」的确定派生
  setRng('identity-only');
  const id = createIdentity();
  out.push({ rng: 'identity-only', identityOnly: { sigSeed: toB64(id.sigSeed), dhPriv: toB64(id.dhPriv), ikSigPub: toB64(id.ikSigPub), ikDhPub: toB64(id.ikDhPub) } });
  return out;
}

function x3dhCases(alice: DeviceKeys, bob: DeviceKeys) {
  const cases = [];
  for (const [name, n] of [
    ['with-opk', 1],
    ['without-opk', 0],
  ] as const) {
    const b = bundle(bob, n);
    const label = `x3dh-${name}`;
    setRng(label);
    const r = x3dhInitiate(alice.identity, b);
    const resp = x3dhRespond({
      selfDhPriv: bob.identity.dhPriv,
      selfIkDhPub: bob.identity.ikDhPub,
      spkPriv: bob.spk.priv,
      opkPriv: n ? bob.opks[0].priv : null,
      initiatorIkDhPub: alice.identity.ikDhPub,
      initiatorEkPub: r.ekPub,
    });
    if (toB64(resp.sk) !== toB64(r.sk)) throw new Error('X3DH 双方 SK 不一致');
    cases.push({
      name,
      rng: label,
      initiator: 'alice',
      responder: 'bob',
      bundle: b,
      out: { sk: toB64(r.sk), ad: toB64(r.ad), ekPriv: toB64(r.ekPriv), ekPub: toB64(r.ekPub), spkId: r.spkId, opkId: r.opkId },
    });
  }
  // 签名被篡改的预密钥包必须拒绝
  const bad = bundle(bob, 1);
  const sig = fromB64(bad.spkSig);
  sig[0] ^= 1;
  cases.push({ name: 'bad-signature', rng: 'x3dh-bad', initiator: 'alice', responder: 'bob', bundle: { ...bad, spkSig: toB64(sig) }, out: { error: true } });
  return cases;
}

async function transcript(parties: Record<string, Party>, keys: Record<string, DeviceKeys>) {
  const world = new World(parties);
  const steps: Step[] = [];
  const t = (name: string) => ({ user: parties[name].user, device: parties[name].device });
  const bkey = (name: string) => `${parties[name].user}/${parties[name].device}`;
  const run = async (note: string, s: StepIn) => {
    const rng = `step-${steps.length}`;
    const expect = await world.run({ ...s, rng });
    steps.push({ ...s, rng, note, expect } as Step);
    return expect as any;
  };
  const text = (s: string) => JSON.stringify({ t: 'text', text: s });

  // —— 1. 首次发起、预密钥信封、乱序到达 ——
  const m1 = await run('alice 首次给 bob 发消息：建会话（带 OPK）+ 预密钥信封', {
    op: 'encrypt', actor: 'alice', targets: [t('bob')], bundles: { [bkey('bob')]: bundle(keys.bob, 1) }, payloadJson: text('你好 Bob'),
  });
  const m2 = await run('bob 回复之前 alice 再发一条：仍然是预密钥信封', {
    op: 'encrypt', actor: 'alice', targets: [t('bob')], bundles: {}, payloadJson: text('第二条，带个 emoji 🔐'),
  });
  await run('bob 先收到第二条（乱序）：新建会话并跳过第一条的密钥', { op: 'decrypt', actor: 'bob', from: t('alice'), body: m2.bodies[0].body });
  await run('bob 再收到第一条：在已有链路上用暂存的跳过密钥解开', { op: 'decrypt', actor: 'bob', from: t('alice'), body: m1.bodies[0].body });
  await run('同一条再收一次：密钥已用掉，必须失败', { op: 'decrypt', actor: 'bob', from: t('alice'), body: m1.bodies[0].body });

  // —— 2. 回复、换棘轮 ——
  const r1 = await run('bob 回复：普通信封，bob 这边触发过 DH 棘轮', { op: 'encrypt', actor: 'bob', targets: [t('alice')], bundles: {}, payloadJson: text('收到') });
  await run('alice 收到回复：确认链路，之后不再用预密钥信封', { op: 'decrypt', actor: 'alice', from: t('bob'), body: r1.bodies[0].body });
  const m3 = await run('alice 再发：普通信封', { op: 'encrypt', actor: 'alice', targets: [t('bob')], bundles: {}, payloadJson: text('第三条') });
  await run('bob 收到', { op: 'decrypt', actor: 'bob', from: t('alice'), body: m3.bodies[0].body });
  const r2 = await run('bob 连发两条之一', { op: 'encrypt', actor: 'bob', targets: [t('alice')], bundles: {}, payloadJson: text('a') });
  const r3 = await run('bob 连发两条之二', { op: 'encrypt', actor: 'bob', targets: [t('alice')], bundles: {}, payloadJson: JSON.stringify({ t: 'system', text: '换行\n引号"反斜杠\\' }) });
  await run('alice 先收第二条', { op: 'decrypt', actor: 'alice', from: t('bob'), body: r3.bodies[0].body });
  await run('alice 再收第一条（跳过密钥）', { op: 'decrypt', actor: 'alice', from: t('bob'), body: r2.bodies[0].body });

  // —— 3. 同时发起：carol 和 bob 同时给对方发首条（carol 拿到的包没有 OPK）——
  const c1 = await run('carol 给 bob 发首条（预密钥包里没有 OPK）', {
    op: 'encrypt', actor: 'carol', targets: [t('bob')], bundles: { [bkey('bob')]: bundle(keys.bob, 0) }, payloadJson: text('我是 carol'),
  });
  const b1 = await run('bob 同时给 carol 发首条', {
    op: 'encrypt', actor: 'bob', targets: [t('carol')], bundles: { [bkey('carol')]: bundle(keys.carol, 1) }, payloadJson: text('我是 bob'),
  });
  await run('bob 收到 carol 的首条：同一对端现在有两条链路', { op: 'decrypt', actor: 'bob', from: t('carol'), body: c1.bodies[0].body });
  await run('carol 收到 bob 的首条', { op: 'decrypt', actor: 'carol', from: t('bob'), body: b1.bodies[0].body });
  const c2 = await run('carol 再发：用最近解密成功的那条链路', { op: 'encrypt', actor: 'carol', targets: [t('bob')], bundles: {}, payloadJson: text('收到你的了') });
  await run('bob 收到：按最近使用顺序逐条尝试', { op: 'decrypt', actor: 'bob', from: t('carol'), body: c2.bodies[0].body });
  const b2 = await run('bob 再发', { op: 'encrypt', actor: 'bob', targets: [t('carol')], bundles: {}, payloadJson: text('好的') });
  await run('carol 收到', { op: 'decrypt', actor: 'carol', from: t('bob'), body: b2.bodies[0].body });

  // —— 4. 一次发给多台设备，缺包的设备跳过 ——
  await run('alice 同时发给 bob（已有会话）、carol（新建，用她的第二枚 OPK）、dave（没有预密钥包 → 跳过）', {
    op: 'encrypt', actor: 'alice',
    targets: [t('bob'), t('carol'), { user: 'dave', device: 'dev-dave' }, t('alice')],
    bundles: { [bkey('carol')]: bundle(keys.carol, 1, 1) },
    payloadJson: JSON.stringify({ t: 'file', blobId: 'a'.repeat(32), name: '报告.pdf', size: 12345, mime: 'application/pdf', key: toB64(new Uint8Array(32).fill(7)) }),
  });

  // —— 5. 群组：发送者密钥 ——
  const g = 'group-42';
  const d1 = await run('alice 把自己的群密钥分发给 bob', { op: 'distributeSenderKey', actor: 'alice', groupId: g, targets: [t('bob')], bundles: {} });
  await run('bob 收到 skdm：载荷类型 skdm，并存下 alice 的群密钥', { op: 'decrypt', actor: 'bob', from: t('alice'), body: d1.bodies[0].body });
  const g0 = await run('alice 群消息 #0', { op: 'encryptGroup', actor: 'alice', groupId: g, payloadJson: text('群里第一条') });
  const g1 = await run('alice 群消息 #1', { op: 'encryptGroup', actor: 'alice', groupId: g, payloadJson: text('群里第二条') });
  const g2 = await run('alice 群消息 #2', { op: 'encryptGroup', actor: 'alice', groupId: g, payloadJson: text('群里第三条') });
  await run('bob 解 #0', { op: 'decryptGroup', actor: 'bob', body: g0.body });
  await run('bob 跳过 #1 直接解 #2（链往前推）', { op: 'decryptGroup', actor: 'bob', body: g2.body });
  await run('bob 再解 #1：v1 不支持群内乱序，必须失败', { op: 'decryptGroup', actor: 'bob', body: g1.body });
  await run('成员变动：alice 轮换群密钥', { op: 'rotateSenderKey', actor: 'alice', groupId: g });
  const g3 = await run('轮换后 alice 先发了群消息（新密钥的分发还没送出，真实场景里分发要先联网取预密钥包）', {
    op: 'encryptGroup', actor: 'alice', groupId: g, payloadJson: text('轮换后'),
  });
  await run('bob 还没收到新密钥：必须失败', { op: 'decryptGroup', actor: 'bob', body: g3.body });
  const d2 = await run('alice 分发新密钥：发的是密钥创建时的初始状态（iteration 0），不是当前状态', {
    op: 'distributeSenderKey', actor: 'alice', groupId: g, targets: [t('bob')], bundles: {},
  });
  await run('bob 收到新 skdm', { op: 'decrypt', actor: 'bob', from: t('alice'), body: d2.bodies[0].body });
  await run('bob 能解开分发之前发出的那条', { op: 'decryptGroup', actor: 'bob', body: g3.body });
  const d3 = await run('alice 又分发了一次同一把密钥（例如重新进群时补发）', {
    op: 'distributeSenderKey', actor: 'alice', groupId: g, targets: [t('bob')], bundles: {},
  });
  await run('bob 收到重复的 skdm：已经推进过的链不能被倒回去', { op: 'decrypt', actor: 'bob', from: t('alice'), body: d3.bodies[0].body });
  await run('所以同一条群消息再来一次仍然解不开（防重放）', { op: 'decryptGroup', actor: 'bob', body: g3.body });
  const g4 = await run('alice 继续发', { op: 'encryptGroup', actor: 'alice', groupId: g, payloadJson: text('继续') });
  await run('bob 正常解开', { op: 'decryptGroup', actor: 'bob', body: g4.body });

  // —— 6. 篡改与伪造：失败不能改变任何状态 ——
  const forged = { ...g4.body, iteration: g4.body.iteration + 50, ct: g4.body.ct.replace(/^./, (ch: string) => (ch === 'A' ? 'B' : 'A')) };
  await run('有人冒充 alice 发群消息、把序号填大 50：解不开', { op: 'decryptGroup', actor: 'bob', body: forged });
  const g5 = await run('alice 的下一条真实群消息', { op: 'encryptGroup', actor: 'alice', groupId: g, payloadJson: text('伪造之后') });
  await run('bob 照样能解：伪造的消息没有把链往前推', { op: 'decryptGroup', actor: 'bob', body: g5.body });

  const toCarol = (steps[21].expect as any).bodies.find((x: any) => x.user === 'carol').body;
  const flip = (s: string) => s.replace(/^./, (ch) => (ch === 'A' ? 'B' : 'A'));
  await run('carol 收到被篡改的预密钥消息（第 21 步发给她、她还没收的那条）：解不开', {
    op: 'decrypt', actor: 'carol', from: t('alice'), body: { ...toCarol, ct: flip(toCarol.ct) },
  });
  await run('再收到原版：作为新会话正常建立（失败的那次没有留下坏链路，所以 created=true）', {
    op: 'decrypt', actor: 'carol', from: t('alice'), body: toCarol,
  });

  return steps;
}

async function roam() {
  setRng('roam-keys');
  const kp = createRoamKeys();
  const seals = [];
  for (const [i, pt] of [JSON.stringify({ t: 'text', text: '历史副本' }), JSON.stringify({ t: 'system', text: '' })].entries()) {
    const label = `roam-seal-${i}`;
    setRng(label);
    const s = await sealForRoam(kp.pub, utf8(pt));
    seals.push({ rng: label, plaintext: pt, eph: s.eph, ct: s.ct });
  }
  setRng('roam-wrap');
  const password = '账号口令 pw-123';
  const w = await wrapRoamPriv(password, kp.priv);
  return { rng: 'roam-keys', priv: toB64(kp.priv), pub: toB64(kp.pub), seals, wrap: { rng: 'roam-wrap', password, salt: w.salt, sealed: w.sealed } };
}

async function blobs() {
  setRng('blob');
  const out = [];
  for (const n of [0, 5, 4096]) {
    const key = rngBytes(32);
    const data = rngBytes(n);
    out.push({ key: toB64(key), data: toB64(data), ct: toB64(await aeadSeal(key, data, utf8('blob'))) });
  }
  return out;
}

async function main() {
  const mk = (name: string, user: string, device: string, opks: number) => {
    setRng(`keys-${name}`);
    const k = createDeviceKeys(opks);
    return { party: { user, device, keys: serializeKeys(k) } as Party, keys: k };
  };
  const a = mk('alice', 'alice', 'dev-alice', 3);
  const b = mk('bob', 'bob', 'dev-bob', 3);
  const c = mk('carol', 'carol', 'dev-carol', 3);
  const parties = { alice: a.party, bob: b.party, carol: c.party };
  const keys = { alice: a.keys, bob: b.keys, carol: c.keys };

  const doc = {
    version: 1,
    generatedBy: 'src/tests/vectors/export.ts',
    rng: 'block(i) = SHA-256(utf8("CipherIM-test-rng-v1|" + label) || u32be(i))；按顺序流式取字节，余下的留给下次。每段数据注明它用的 label',
    encoding: 'primitives 段是 hex；其余是标准 base64（带 = 填充），与线协议一致',
    primitives: await primitives(),
    identity: identities(),
    fingerprint: {
      safety: [
        { a: parties.alice.keys.identity.ikSigPub, b: parties.bob.keys.identity.ikSigPub, digits: safetyNumber(keys.alice.identity.ikSigPub, keys.bob.identity.ikSigPub) },
        { a: parties.carol.keys.identity.ikSigPub, b: parties.alice.keys.identity.ikSigPub, digits: safetyNumber(keys.carol.identity.ikSigPub, keys.alice.identity.ikSigPub) },
      ],
      short: [a, b, c].map((p) => ({ ikSigPub: p.party.keys.identity.ikSigPub, out: shortFingerprint(p.keys.identity.ikSigPub) })),
    },
    parties,
    x3dh: x3dhCases(keys.alice, keys.bob),
    transcript: await transcript(parties, keys),
    roam: await roam(),
    blob: await blobs(),
  };

  const file = path.resolve('spec/vectors/crypto-v1.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 1) + '\n');
  console.log(`已导出 ${file}：会话脚本 ${doc.transcript.length} 步`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
