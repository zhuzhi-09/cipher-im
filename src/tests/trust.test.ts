/** 安全码信任状态机（纯逻辑） */
import { trustState, markVerified } from '../shared/crypto/trust';

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

const SN = '123456 654321 000000 111111 222222 333333';

ok('从未核对 → 未核对', trustState(SN, undefined) === 'unverified', trustState(SN, undefined));
ok('从没记录（null）→ 未核对', trustState(SN, null) === 'unverified');

const rec = markVerified(SN);
ok('标记后状态为 verified', rec.state === 'verified');
ok('记录的就是当前安全码', rec.safety === SN);
ok('核对过且一致 → 已验证', trustState(SN, rec) === 'verified');
ok(
  '公钥变了（安全码不同）→ 已变更',
  trustState('999999 888888 777777 666666 555555 444444', rec) === 'changed',
);
ok('已变更标记本身被尊重', trustState(SN, { ...rec, state: 'changed' }) === 'changed');
ok('重新核对可以回到已验证', trustState(SN, markVerified(SN, rec.at + 1)) === 'verified');
ok('两次核对时间不同（可审计）', markVerified(SN, 1).at !== markVerified(SN, 2).at);

console.log(`\n信任状态机 ${pass}/${pass + fails.length}`);
if (fails.length) {
  console.log('失败：' + fails.join('、'));
  process.exit(1);
}
