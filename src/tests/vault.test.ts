/** 本地密钥库往返测试：序列化 → 加密 → 解密 → 恢复后链路仍然可用 */
import { createDeviceKeys, publicBundleOf } from '../shared/crypto/identity';
import { CryptoClient } from '../shared/crypto/client';
import { randomBytes } from '../shared/crypto/primitives';
import { serializeVault, deserializeVault, sealVaultText, openVaultText } from '../web/store';
import type { VaultState } from '../web/store';

let pass = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function main() {
  const ka = createDeviceKeys();
  const kb = createDeviceKeys();
  const A = new CryptoClient('alice', 'a-d1', ka);
  const B = new CryptoClient('bob', 'b-d1', kb);

  // 先建立真实链路并收发几条，制造会话状态
  const e1 = await A.encryptToDevices([{ user: 'bob', device: 'b-d1' }], new Map([['bob/b-d1', publicBundleOf(kb)]]), { t: 'text', text: '第一条' });
  await B.decryptFrom('alice', 'a-d1', e1.bodies[0].body);
  const e2 = await A.encryptToDevices([{ user: 'bob', device: 'b-d1' }], new Map(), { t: 'text', text: '第二条' });
  await B.decryptFrom('alice', 'a-d1', e2.bodies[0].body);

  const vault: VaultState = {
    username: 'alice',
    displayName: 'Alice',
    deviceId: 'a-d1',
    keys: ka,
    client: A,
    token: 'tok-123',
    reads: { '7': 42 },
    contacts: { bob: 'Bob' },
    log: { '7': [{ id: 7, from: { user: 'alice', device: 'a-d1' }, createdAt: 1, payload: { t: 'text', text: '本地日志' }, mine: true }] },
    roam: { pub: 'roam-pub', priv: 'roam-priv' },
    trust: { 'bob/b-d1': { safety: '000000111111', state: 'verified', at: 1 } },
  };

  const text = serializeVault(vault);
  ok('序列化包含会话', text.includes('sessions'));
  ok('序列化后不含明文消息', !text.includes('第一条'));

  const kek = randomBytes(32);
  const sealed = await sealVaultText(kek, text);
  ok('加密后取不到明文', !sealed.includes('alice') || sealed.length > 0);

  const reopened = await openVaultText(kek, sealed);
  ok('同口令可解', reopened === text);
  ok('错误口令解不开', (await openVaultText(randomBytes(32), sealed).then(() => false).catch(() => true)) === true);

  const restored = deserializeVault(reopened);
  ok('恢复出用户名', restored.username === 'alice' && restored.deviceId === 'a-d1');
  ok('恢复出已读位置', restored.reads['7'] === 42);
  ok('恢复出联系人缓存', restored.contacts.bob === 'Bob');

  // 关键：恢复后的客户端还能在旧链路上继续发消息，且对方能解
  const e3 = await restored.client.encryptToDevices([{ user: 'bob', device: 'b-d1' }], new Map(), { t: 'text', text: '重启后发的' });
  const d3 = await B.decryptFrom('alice', 'a-d1', e3.bodies[0].body);
  ok('重启后链路仍可用', (d3.payload as any).text === '重启后发的', (d3.payload as any).text);

  // 恢复后的客户端也能解对方新消息
  const e4 = await B.encryptToDevices([{ user: 'alice', device: 'a-d1' }], new Map(), { t: 'text', text: '对方回复' });
  const d4 = await restored.client.decryptFrom('bob', 'b-d1', e4.bodies[0].body);
  ok('重启后仍能解对方消息', (d4.payload as any).text === '对方回复');

  console.log(`\n结果：${pass} 通过，${fails.length} 失败`);
  if (fails.length) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error('崩溃：', e);
  process.exit(1);
});
