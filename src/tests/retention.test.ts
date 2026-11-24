/** 服务端 14 天保留期清理测试 */
import fs from 'node:fs';
import { DB } from '../server/db';

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

const DAY = 24 * 60 * 60 * 1000;
const file = `/tmp/cim-retention-${Date.now()}.db`;
const db = new DB(file);
const raw = (db as any).db;

db.createUser('u1', 'U1', 'secret123');
db.addDevice('u1', {
  device: 'd1',
  ikSigPub: 'sig',
  ikDhPub: 'dh',
  spkId: 's1',
  spkPub: 'spk',
  spkSig: 'spksig',
  opks: [{ id: 'o1', pub: 'opk' }],
});
const conv = db.createConv('direct', '', 'u1', ['u1', 'u2']);
ok('会话与成员写入成功', db.isMember(conv, 'u1'));

// 一条 15 天前的旧消息、一条今天的消息
const oldMsg = db.insertMessage(conv, 'u1', 'd1', 'direct');
db.addDelivery(oldMsg, conv, 'u1', 'd1', '{"ct":"old"}');
const newMsg = db.insertMessage(conv, 'u1', 'd1', 'direct');
db.addDelivery(newMsg, conv, 'u1', 'd1', '{"ct":"new"}');
raw.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(Date.now() - 15 * DAY, oldMsg);

// 一个旧文件密文
const oldBlob = 'a'.repeat(32);
db.addBlob(oldBlob, 'u1', 128, 'application/octet-stream');
raw.prepare('UPDATE blobs SET created_at = ? WHERE id = ?').run(Date.now() - 15 * DAY, oldBlob);
db.addBlob('b'.repeat(32), 'u1', 64, 'application/octet-stream');

const cutoff = Date.now() - 14 * DAY;
const histAllBefore = db.history('u1', 'd1', conv, null, 50, 0);
ok('清理前两条消息都在', histAllBefore.length === 2);

const r = db.prune(cutoff);
ok('旧消息被删除', r.messages === 1, String(r.messages));
ok('旧投递记录被删除', r.deliveries === 1, String(r.deliveries));
ok('旧文件密文被标记删除', r.blobs.length === 1 && r.blobs[0] === oldBlob);

const remain = raw.prepare('SELECT COUNT(*) c FROM messages').get().c;
ok('今天的消息保留', remain === 1, String(remain));
const hist = db.history('u1', 'd1', conv, null, 50, cutoff);
ok('历史查询不返回过期消息', hist.length === 1 && hist[0].msg_id === newMsg, JSON.stringify(hist.map((h: any) => h.msg_id)));

// 重复清理应幂等
const r2 = db.prune(cutoff);
ok('重复清理幂等', r2.messages === 0 && r2.blobs.length === 0);

db.db.close();
fs.rmSync(file, { force: true });
fs.rmSync(`${file}-wal`, { force: true });
fs.rmSync(`${file}-shm`, { force: true });

console.log(`\n结果：${pass} 通过，${fails.length} 失败`);
if (fails.length) process.exit(1);
process.exit(0);
