/** 跨设备漫游密钥测试：封/解、口令封装、账号隔离 */
import { createRoamKeys, sealForRoam, openRoam, wrapRoamPriv, unwrapRoamPriv } from '../shared/crypto/roam';
import { utf8, toB64 } from '../shared/crypto/primitives';

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
async function throws(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function main() {
  // 1) 基本封解往返
  const alice = createRoamKeys();
  const plain = utf8(JSON.stringify({ t: 'text', text: '跨设备历史副本 ✓ 中文 emoji 🎹' }));
  const sealed = await sealForRoam(alice.pub, plain);
  const opened = await openRoam(alice.priv, sealed.eph, sealed.ct);
  ok('封/解往返一致', toB64(opened) === toB64(plain));
  ok('eph 是 32 字节 X25519 公钥', Buffer.from(sealed.eph, 'base64').length === 32);
  ok('密文非空', sealed.ct.length > 0);

  // 2) 每次封装用新临时密钥（密文与 eph 都不重复）
  const s2 = await sealForRoam(alice.pub, plain);
  ok('同一明文两次封装 eph 不同', s2.eph !== sealed.eph);
  ok('同一明文两次封装密文不同', s2.ct !== sealed.ct);
  const o2 = await openRoam(alice.priv, s2.eph, s2.ct);
  ok('第二次封装同样能解', toB64(o2) === toB64(plain));

  // 3) 账号隔离：别人的私钥解不开
  const bob = createRoamKeys();
  ok(
    'B 的私钥解不开发给 A 的副本',
    await throws(() => openRoam(bob.priv, sealed.eph, sealed.ct)),
  );
  ok(
    '篡改密文解不开',
    await throws(() => openRoam(alice.priv, sealed.eph, sealed.ct.slice(0, -4) + 'AAAA')),
  );
  ok(
    '篡改 eph 解不开（AAD 绑定临时公钥）',
    await throws(() => openRoam(alice.priv, s2.eph, sealed.ct)),
  );

  // 4) 口令封装：服务端存 sealed，同一口令在另一台设备可解
  const wrapped = await wrapRoamPriv('correct horse battery staple', alice.priv);
  const unwrapped = await unwrapRoamPriv('correct horse battery staple', wrapped.salt, wrapped.sealed);
  ok('口令解封得到同一私钥', toB64(unwrapped) === toB64(alice.priv));
  ok('封存内容不含明文私钥', !Buffer.from(wrapped.sealed, 'base64').toString('base64').includes(toB64(alice.priv)));
  ok(
    '错误口令解封失败',
    await throws(() => unwrapRoamPriv('wrong password', wrapped.salt, wrapped.sealed)),
  );
  const wrapped2 = await wrapRoamPriv('correct horse battery staple', alice.priv);
  ok('同一口令两次封存 salt 不同', wrapped2.salt !== wrapped.salt);

  // 5) 新设备场景：别人发的副本，新设备用口令解封后能读
  const carolDevice2 = createRoamKeys(); // 模拟新设备的临时密钥，与漫游私钥无关
  const forAlice = await sealForRoam(alice.pub, utf8('设备 1 时代收到的消息'));
  const newDevPriv = await unwrapRoamPriv('correct horse battery staple', wrapped.salt, wrapped.sealed);
  const readBack = await openRoam(newDevPriv, forAlice.eph, forAlice.ct);
  ok('新设备解封后能读旧副本', Buffer.from(readBack).toString('utf8') === '设备 1 时代收到的消息');
  void carolDevice2;

  console.log(`\n漫游密钥 ${pass}/${pass + fails.length}`);
  if (fails.length) {
    console.log('失败：' + fails.join('、'));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
