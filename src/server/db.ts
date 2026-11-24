/**
 * 服务端存储层（node:sqlite，单文件数据库）
 *
 * 设计原则：库里只存「谁给谁发了多长的密文」，不存任何明文、不存任何私钥。
 *  - users / devices / opks：账号与设备公钥、一次性预密钥池
 *  - convs / conv_members：会话与成员
 *  - messages / deliveries：一条消息按「目标设备」拆成多条投递记录，各自持有本设备的密文
 *  - receipts：每台设备读到哪个消息 id（用于未读计数与已读回执）
 *  - blobs：文件密文（客户端加过密的二进制）
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export interface BundleIn {
  device: string;
  ikSigPub: string;
  ikDhPub: string;
  spkId: string;
  spkPub: string;
  spkSig: string;
  opks: { id: string; pub: string }[];
}

export interface ConvRow {
  id: number;
  kind: 'direct' | 'group';
  name: string;
  created_by: string;
  created_at: number;
}

export class DB {
  db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        pass_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        user TEXT NOT NULL,
        device TEXT NOT NULL,
        ik_sig_pub TEXT NOT NULL,
        ik_dh_pub TEXT NOT NULL,
        spk_id TEXT NOT NULL,
        spk_pub TEXT NOT NULL,
        spk_sig TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen INTEGER,
        PRIMARY KEY (user, device)
      );
      CREATE TABLE IF NOT EXISTS opks (
        user TEXT NOT NULL,
        device TEXT NOT NULL,
        opk_id TEXT NOT NULL,
        opk_pub TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user, device, opk_id)
      );
      CREATE TABLE IF NOT EXISTS convs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conv_members (
        conv INTEGER NOT NULL,
        user TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (conv, user)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conv INTEGER NOT NULL,
        sender_user TEXT NOT NULL,
        sender_device TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        msg_id INTEGER NOT NULL,
        conv INTEGER NOT NULL,
        user TEXT NOT NULL,
        device TEXT NOT NULL,
        body TEXT NOT NULL,
        delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_device ON deliveries(user, device, msg_id);
      CREATE TABLE IF NOT EXISTS roam_keys (
        user TEXT PRIMARY KEY,
        pub TEXT NOT NULL,
        salt TEXT NOT NULL,
        sealed TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS roam_devices (
        user TEXT NOT NULL,
        device TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (user, device)
      );
      CREATE TABLE IF NOT EXISTS hist (
        msg_id INTEGER NOT NULL,
        user TEXT NOT NULL,
        eph TEXT NOT NULL,
        ct TEXT NOT NULL,
        PRIMARY KEY (msg_id, user)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        conv INTEGER NOT NULL,
        user TEXT NOT NULL,
        device TEXT NOT NULL,
        upto INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (conv, user, device)
      );
      CREATE TABLE IF NOT EXISTS blobs (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        size INTEGER NOT NULL,
        mime TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        token TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        device TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_subs (
        endpoint TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        device TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_push_subs_device ON push_subs(user, device);
      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
    `);
  }

  /* ---------------- Web Push 订阅 ---------------- */

  /** 一个推送端点只属于一台设备：同一浏览器换账号登录时，旧归属直接覆盖 */
  addPushSub(user: string, device: string, endpoint: string, p256dh: string, auth: string) {
    this.db
      .prepare('INSERT OR REPLACE INTO push_subs (endpoint, user, device, p256dh, auth, created_at) VALUES (?,?,?,?,?,?)')
      .run(endpoint, user, device, p256dh, auth, Date.now());
  }

  removePushSub(user: string, endpoint: string): boolean {
    return Number(this.db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user = ?').run(endpoint, user).changes) > 0;
  }

  dropPushEndpoint(endpoint: string) {
    this.db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
  }

  pushSubsOf(user: string, device: string) {
    return this.db
      .prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE user = ? AND device = ?')
      .all(user, device) as { endpoint: string; p256dh: string; auth: string }[];
  }

  kvGet(k: string): string | null {
    const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
    return r ? r.v : null;
  }

  kvSet(k: string, v: string) {
    this.db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?,?)').run(k, v);
  }

  /* ---------------- 账号 ---------------- */

  hashPassword(pw: string): string {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
    return `${salt}:${hash}`;
  }

  verifyPassword(pw: string, stored: string): boolean {
    const [salt, hash] = stored.split(':');
    if (!salt || !hash) return false;
    const calc = scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
    const expect = Buffer.from(hash, 'hex');
    return calc.length === expect.length && timingSafeEqual(calc, expect);
  }

  userExists(username: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  }

  createUser(username: string, displayName: string, password: string) {
    this.db
      .prepare('INSERT INTO users (username, display_name, pass_hash, created_at) VALUES (?,?,?,?)')
      .run(username, displayName, this.hashPassword(password), Date.now());
  }

  getUser(username: string) {
    return this.db.prepare('SELECT username, display_name, pass_hash FROM users WHERE username = ?').get(username) as
      | { username: string; display_name: string; pass_hash: string }
      | undefined;
  }

  listUsers(q: string) {
    return this.db
      .prepare('SELECT username, display_name FROM users WHERE username LIKE ? OR display_name LIKE ? ORDER BY username LIMIT 20')
      .all(`%${q}%`, `%${q}%`) as { username: string; display_name: string }[];
  }

  /* ---------------- 设备与预密钥 ---------------- */

  addDevice(username: string, b: BundleIn) {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO devices (user, device, ik_sig_pub, ik_dh_pub, spk_id, spk_pub, spk_sig, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(username, b.device, b.ikSigPub, b.ikDhPub, b.spkId, b.spkPub, b.spkSig, Date.now());
    const ins = this.db.prepare('INSERT OR IGNORE INTO opks (user, device, opk_id, opk_pub, used) VALUES (?,?,?,?,0)');
    for (const o of b.opks) ins.run(username, b.device, o.id, o.pub);
  }

  devicesOf(username: string) {
    return this.db
      .prepare('SELECT device, ik_sig_pub, ik_dh_pub, spk_id, spk_pub, spk_sig FROM devices WHERE user = ?')
      .all(username) as {
      device: string;
      ik_sig_pub: string;
      ik_dh_pub: string;
      spk_id: string;
      spk_pub: string;
      spk_sig: string;
    }[];
  }

  /** 取某设备的预密钥包，并原子地消耗一枚 OPK（不足时退回无 OPK 模式） */
  takeBundle(username: string, device: string, maxOpks = 3) {
    const d = this.db
      .prepare('SELECT ik_sig_pub, ik_dh_pub, spk_id, spk_pub, spk_sig FROM devices WHERE user = ? AND device = ?')
      .get(username, device) as any;
    if (!d) return null;

    const opks: { id: string; pub: string }[] = [];
    for (let i = 0; i < maxOpks; i++) {
      const o = this.db
        .prepare('SELECT opk_id, opk_pub FROM opks WHERE user = ? AND device = ? AND used = 0 LIMIT 1')
        .get(username, device) as { opk_id: string; opk_pub: string } | undefined;
      if (!o) break;
      this.db.prepare('UPDATE opks SET used = 1 WHERE user = ? AND device = ? AND opk_id = ?').run(username, device, o.opk_id);
      opks.push({ id: o.opk_id, pub: o.opk_pub });
    }

    return {
      ikSigPub: d.ik_sig_pub,
      ikDhPub: d.ik_dh_pub,
      spkId: d.spk_id,
      spkPub: d.spk_pub,
      spkSig: d.spk_sig,
      opks,
    };
  }

  opkStock(username: string, device: string): number {
    return (this.db
      .prepare('SELECT COUNT(*) c FROM opks WHERE user = ? AND device = ? AND used = 0')
      .get(username, device) as { c: number }).c;
  }

  touchDevice(username: string, device: string) {
    this.db.prepare('UPDATE devices SET last_seen = ? WHERE user = ? AND device = ?').run(Date.now(), username, device);
  }

  /* ---------------- 令牌 ---------------- */

  issueToken(username: string, device: string): string {
    const token = randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO tokens (token, user, device, created_at) VALUES (?,?,?,?)').run(token, username, device, Date.now());
    return token;
  }

  tokenInfo(token: string) {
    return this.db.prepare('SELECT user, device FROM tokens WHERE token = ?').get(token) as
      | { user: string; device: string }
      | undefined;
  }

  /* ---------------- 会话 ---------------- */

  convsOf(username: string): ConvRow[] {
    return this.db
      .prepare(
        'SELECT c.* FROM convs c JOIN conv_members m ON m.conv = c.id WHERE m.user = ? ORDER BY c.id DESC',
      )
      .all(username) as unknown as ConvRow[];
  }

  membersOf(conv: number) {
    return this.db
      .prepare('SELECT user, role FROM conv_members WHERE conv = ?')
      .all(conv) as { user: string; role: string }[];
  }

  isMember(conv: number, user: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM conv_members WHERE conv = ? AND user = ?').get(conv, user);
  }

  createConv(kind: 'direct' | 'group', name: string, by: string, members: string[]): number {
    const info = this.db
      .prepare('INSERT INTO convs (kind, name, created_by, created_at) VALUES (?,?,?,?)')
      .run(kind, name, by, Date.now());
    const id = Number(info.lastInsertRowid);
    const ins = this.db.prepare('INSERT OR IGNORE INTO conv_members (conv, user, role, joined_at) VALUES (?,?,?,?)');
    for (const m of members) ins.run(id, m, m === by ? 'owner' : 'member', Date.now());
    return id;
  }

  addMembers(conv: number, members: string[]) {
    const ins = this.db.prepare('INSERT OR IGNORE INTO conv_members (conv, user, role, joined_at) VALUES (?,?,?,?)');
    for (const m of members) ins.run(conv, m, 'member', Date.now());
  }

  findDirect(userA: string, userB: string): number | null {
    const row = this.db
      .prepare(
        `SELECT c.id FROM convs c
         JOIN conv_members m1 ON m1.conv = c.id AND m1.user = ?
         JOIN conv_members m2 ON m2.conv = c.id AND m2.user = ?
         WHERE c.kind = 'direct' LIMIT 1`,
      )
      .get(userA, userB) as { id: number } | undefined;
    return row ? row.id : null;
  }

  convKind(conv: number): 'direct' | 'group' | null {
    const r = this.db.prepare('SELECT kind FROM convs WHERE id = ?').get(conv) as { kind: 'direct' | 'group' } | undefined;
    return r ? r.kind : null;
  }

  convName(conv: number): string {
    const r = this.db.prepare('SELECT name FROM convs WHERE id = ?').get(conv) as { name: string } | undefined;
    return r ? r.name : '';
  }

  /* ---------------- 跨设备漫游 ---------------- */

  /** 只在账号还没有漫游密钥时写入（第一台设备初始化，后续设备只读） */
  setRoamKeyIfAbsent(user: string, pub: string, salt: string, sealed: string): boolean {
    if (this.db.prepare('SELECT 1 FROM roam_keys WHERE user = ?').get(user)) return false;
    this.db
      .prepare('INSERT INTO roam_keys (user, pub, salt, sealed, created_at) VALUES (?,?,?,?,?)')
      .run(user, pub, salt, sealed, Date.now());
    return true;
  }

  roamKey(user: string) {
    return this.db.prepare('SELECT pub, salt, sealed FROM roam_keys WHERE user = ?').get(user) as
      | { pub: string; salt: string; sealed: string }
      | undefined;
  }

  addRoamDevice(user: string, device: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO roam_devices (user, device, added_at) VALUES (?,?,?)')
      .run(user, device, Date.now());
  }

  roamDevices(user: string) {
    return this.db
      .prepare('SELECT device, added_at FROM roam_devices WHERE user = ? ORDER BY added_at')
      .all(user) as { device: string; added_at: number }[];
  }

  isRoamDevice(user: string, device: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM roam_devices WHERE user = ? AND device = ?').get(user, device);
  }

  /** 撤销某设备的漫游权限，同时把它踢下线（令牌作废） */
  revokeRoamDevice(user: string, device: string): boolean {
    const had = this.isRoamDevice(user, device);
    this.db.prepare('DELETE FROM roam_devices WHERE user = ? AND device = ?').run(user, device);
    this.db.prepare('DELETE FROM tokens WHERE user = ? AND device = ?').run(user, device);
    this.db.prepare('DELETE FROM push_subs WHERE user = ? AND device = ?').run(user, device); // 被踢的设备也别再收提醒
    return had;
  }

  addHist(msgId: number, user: string, eph: string, ct: string) {
    this.db.prepare('INSERT OR REPLACE INTO hist (msg_id, user, eph, ct) VALUES (?,?,?,?)').run(msgId, user, eph, ct);
  }

  histFor(user: string, conv: number, beforeId: number | null, limit: number, since: number) {
    const rows = this.db
      .prepare(
        `SELECT h.msg_id, m.conv, m.sender_user, m.sender_device, m.created_at, h.eph, h.ct
         FROM hist h JOIN messages m ON m.id = h.msg_id
         WHERE h.user = ? AND m.conv = ? AND m.created_at >= ? AND (? IS NULL OR h.msg_id < ?)
         ORDER BY h.msg_id DESC LIMIT ?`,
      )
      .all(user, conv, since, beforeId, beforeId, limit) as any[];
    return rows.reverse();
  }

  /* ---------------- 消息 ---------------- */

  insertMessage(conv: number, senderUser: string, senderDevice: string, kind: string): number {
    const info = this.db
      .prepare('INSERT INTO messages (conv, sender_user, sender_device, kind, created_at) VALUES (?,?,?,?,?)')
      .run(conv, senderUser, senderDevice, kind, Date.now());
    return Number(info.lastInsertRowid);
  }

  addDelivery(msgId: number, conv: number, user: string, device: string, body: string) {
    this.db
      .prepare('INSERT INTO deliveries (msg_id, conv, user, device, body) VALUES (?,?,?,?,?)')
      .run(msgId, conv, user, device, body);
  }

  /** 取某设备在某会话里尚未确认投递的记录（按 id 升序） */
  pendingFor(user: string, device: string) {
    return this.db
      .prepare('SELECT id, msg_id, conv, body FROM deliveries WHERE user = ? AND device = ? AND delivered_at IS NULL ORDER BY msg_id LIMIT 500')
      .all(user, device) as { id: number; msg_id: number; conv: number; body: string }[];
  }

  markDelivered(deliveryIds: number[]) {
    if (!deliveryIds.length) return;
    const st = this.db.prepare('UPDATE deliveries SET delivered_at = ? WHERE id = ?');
    const t = Date.now();
    for (const id of deliveryIds) st.run(t, id);
  }

  history(user: string, device: string, conv: number, beforeId: number | null, limit: number, since = 0) {
    const rows = this.db
      .prepare(
        `SELECT d.id AS delivery_id, d.msg_id, d.conv, d.body, m.sender_user, m.sender_device, m.kind, m.created_at
         FROM deliveries d JOIN messages m ON m.id = d.msg_id
         WHERE d.user = ? AND d.device = ? AND d.conv = ? AND m.created_at >= ? AND (? IS NULL OR d.msg_id < ?)
         ORDER BY d.msg_id DESC LIMIT ?`,
      )
      .all(user, device, conv, since, beforeId, beforeId, limit) as any[];
    return rows.reverse();
  }

  lastMessage(conv: number): { id: number; created_at: number } | null {
    const r = this.db.prepare('SELECT id, created_at FROM messages WHERE conv = ? ORDER BY id DESC LIMIT 1').get(conv) as
      | { id: number; created_at: number }
      | undefined;
    return r ?? null;
  }

  /** 未读数：我这条设备上、消息 id 大于我已读位置的数量 */
  unread(conv: number, user: string, device: string): number {
    const upTo = (this.db
      .prepare('SELECT upto FROM receipts WHERE conv = ? AND user = ? AND device = ?')
      .get(conv, user, device) as { upto: number } | undefined)?.upto ?? 0;
    return (this.db
      .prepare('SELECT COUNT(*) c FROM deliveries WHERE conv = ? AND user = ? AND device = ? AND msg_id > ?')
      .get(conv, user, device, upTo) as { c: number }).c;
  }

  setReceipt(conv: number, user: string, device: string, upto: number) {
    this.db
      .prepare(
        `INSERT INTO receipts (conv, user, device, upto, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(conv, user, device) DO UPDATE SET upto = MAX(upto, excluded.upto), updated_at = excluded.updated_at`,
      )
      .run(conv, user, device, upto, Date.now());
  }

  /** 某会话里每个人读到哪了（取该用户所有设备的最小已读位置作为「已读」口径） */
  readStates(conv: number): { user: string; upto: number }[] {
    return this.db
      .prepare('SELECT user, MIN(upto) AS upto FROM receipts WHERE conv = ? GROUP BY user')
      .all(conv) as { user: string; upto: number }[];
  }

  /* ---------------- 文件密文 ---------------- */

  addBlob(id: string, owner: string, size: number, mime: string) {
    this.db.prepare('INSERT INTO blobs (id, owner, size, mime, created_at) VALUES (?,?,?,?,?)').run(id, owner, size, mime, Date.now());
  }

  /** 某账号当前占用的文件密文总量（用于配额判断） */
  blobBytesOf(owner: string): number {
    return (this.db.prepare('SELECT COALESCE(SUM(size),0) s FROM blobs WHERE owner = ?').get(owner) as { s: number }).s;
  }

  blob(id: string) {
    return this.db.prepare('SELECT id, owner, size, mime FROM blobs WHERE id = ?').get(id) as
      | { id: string; owner: string; size: number; mime: string }
      | undefined;
  }

  stats() {
    const q = (sql: string) => (this.db.prepare(sql).get() as { c: number }).c;
    return {
      users: q('SELECT COUNT(*) c FROM users'),
      devices: q('SELECT COUNT(*) c FROM devices'),
      convs: q('SELECT COUNT(*) c FROM convs'),
      messages: q('SELECT COUNT(*) c FROM messages'),
      deliveries: q('SELECT COUNT(*) c FROM deliveries'),
      blobs: q('SELECT COUNT(*) c FROM blobs'),
      bytes: (this.db.prepare('SELECT COALESCE(SUM(size),0) s FROM blobs').get() as { s: number }).s,
    };
  }

  /* ---------------- 保留期清理 ---------------- */

  /**
   * 删除早于 cutoff 的消息、投递记录与文件密文。
   * 返回被删掉的 blob id，调用方负责把磁盘上的密文文件也删掉。
   */
  prune(cutoff: number): { messages: number; deliveries: number; blobs: string[] } {
    const raw = this.db as any;
    const oldMsgs = this.db.prepare('SELECT id FROM messages WHERE created_at < ?').all(cutoff) as { id: number }[];
    const ids = oldMsgs.map((m) => m.id);

    let deliveries = 0;
    if (ids.length) {
      const st = raw.prepare('DELETE FROM deliveries WHERE msg_id = ?');
      const stH = raw.prepare('DELETE FROM hist WHERE msg_id = ?');
      for (const id of ids) {
        deliveries += Number(st.run(id).changes ?? 0);
        stH.run(id); // 历史副本跟消息同寿命
      }
      const del = raw.prepare('DELETE FROM messages WHERE id = ?');
      for (const id of ids) del.run(id);
    }

    const oldBlobs = this.db.prepare('SELECT id FROM blobs WHERE created_at < ?').all(cutoff) as { id: string }[];
    if (oldBlobs.length) {
      const delB = raw.prepare('DELETE FROM blobs WHERE id = ?');
      for (const b of oldBlobs) delB.run(b.id);
    }

    // 会话本身保留，成员关系不清空；没有消息的空会话对用户无感
    return { messages: ids.length, deliveries, blobs: oldBlobs.map((b) => b.id) };
  }

  static fingerprint(bundle: string): string {
    return createHash('sha256').update(bundle).digest('hex').slice(0, 12);
  }
}
