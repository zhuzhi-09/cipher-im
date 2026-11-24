/**
 * 会话管理：把 X3DH + 双棘轮封装成「给某台设备加密 / 解某台设备的密文」
 *
 * 一个会话 == 一台对端设备上的一个「链路」。同一台设备可能同时存在多条链路：
 * 常见于双方几乎同时互相发起会话（A 给 B 发首条的同时 B 也给 A 发首条）。
 * 处理方式与 Signal 的 SessionRecord 一致：
 *  - 同一对端设备下保存最多 3 条会话状态
 *  - 解密时按「最近使用」顺序逐条尝试，成功即把该条设为当前发送链路
 *  - 每次尝试前做深拷贝，失败回滚，避免把一条本来好的链路改坏
 *
 * 每条链路的 id = 该链路初始棘轮公钥（发起方为自己的首个 DH 公钥，接收方为对端首个 DH 公钥），
 * 与 Signal 的 baseKey 语义一致。
 */
import { fromB64, toB64, utf8, fromUtf8 } from './primitives';
import { DeviceKeys, PublicBundle, verifyBundle } from './identity';
import { x3dhInitiate, x3dhRespond } from './x3dh';
import {
  RatchetState,
  RatchetHeader,
  initRatchetAlice,
  initRatchetBob,
  ratchetEncrypt,
  ratchetDecrypt,
} from './ratchet';
import type { WireBody, Payload } from '../protocol';

export const MAX_SESSIONS_PER_PEER = 3;

export interface SessionRecord {
  id: string;
  peerUser: string;
  peerDevice: string;
  peerIkDhPub: string;
  state: RatchetState;
  pendingPrekey: { ekPub: string; spkId: string; opkId: string | null } | null;
}

interface PeerState {
  records: SessionRecord[];
  current: string | null;
  lastUsed: Record<string, number>;
}

export interface DecryptResult {
  payload: Payload;
  created: boolean; // 是否由本条预密钥消息新建了会话
  usedOpk: string | null;
  peerIkSigPub: string | null; // 新建会话时对端身份签名公钥，用于安全码
}

export function encodePayload(p: Payload): Uint8Array {
  return utf8(JSON.stringify(p));
}
export function decodePayload(b: Uint8Array): Payload {
  try {
    const parsed = JSON.parse(fromUtf8(b));
    if (parsed && typeof parsed.t === 'string') return parsed as Payload;
  } catch {
    /* fallthrough */
  }
  throw new Error('载荷解析失败');
}

function cloneState(s: RatchetState): RatchetState {
  return JSON.parse(JSON.stringify(s)) as RatchetState;
}

export class SessionManager {
  peers = new Map<string, PeerState>();
  constructor(public keys: DeviceKeys) {}

  static key(user: string, device: string): string {
    return `${user}/${device}`;
  }

  private peer(user: string, device: string): PeerState {
    const k = SessionManager.key(user, device);
    let p = this.peers.get(k);
    if (!p) {
      p = { records: [], current: null, lastUsed: {} };
      this.peers.set(k, p);
    }
    return p;
  }

  has(user: string, device: string): boolean {
    const p = this.peers.get(SessionManager.key(user, device));
    return !!p && p.records.length > 0;
  }

  /** 用对端预密钥包新建发起方链路 */
  establish(user: string, device: string, bundle: PublicBundle): SessionRecord {
    if (!verifyBundle(bundle)) throw new Error('对端预密钥包签名无效');
    const x = x3dhInitiate(this.keys.identity, bundle);
    const state = initRatchetAlice(x.sk, fromB64(bundle.spkPub), x.ad);
    const rec: SessionRecord = {
      id: state.dhsPub, // 链路 id = 首个棘轮公钥
      peerUser: user,
      peerDevice: device,
      peerIkDhPub: bundle.ikDhPub,
      state,
      pendingPrekey: { ekPub: toB64(x.ekPub), spkId: x.spkId, opkId: x.opkId },
    };
    const p = this.peer(user, device);
    p.records.push(rec);
    p.current = rec.id;
    p.lastUsed[rec.id] = Date.now();
    this.gc(p);
    return rec;
  }

  private gc(p: PeerState) {
    while (p.records.length > MAX_SESSIONS_PER_PEER) {
      // 优先淘汰最久没用、且不是当前的那条
      let victim = -1;
      let oldest = Infinity;
      for (let i = 0; i < p.records.length; i++) {
        const r = p.records[i];
        if (r.id === p.current) continue;
        const t = p.lastUsed[r.id] ?? 0;
        if (t < oldest) {
          oldest = t;
          victim = i;
        }
      }
      if (victim < 0) break;
      delete p.lastUsed[p.records[victim].id];
      p.records.splice(victim, 1);
    }
  }

  async encrypt(user: string, device: string, payload: Payload): Promise<WireBody> {
    const p = this.peer(user, device);
    const rec = p.records.find((r) => r.id === p.current) ?? p.records[p.records.length - 1];
    if (!rec) throw new Error('会话不存在，需要先取得预密钥包');

    const pt = encodePayload(payload);
    const { header, ct } = await ratchetEncrypt(rec.state, pt);
    p.lastUsed[rec.id] = Date.now();

    // 在收到对端任何消息之前，每条都用预密钥信封：
    // 否则对端若先收到后续普通消息，就没有可用链路解密（乱序/首条丢失场景）
    if (rec.pendingPrekey) {
      const pk = rec.pendingPrekey;
      return {
        kind: 'prekey',
        ikSigPub: toB64(this.keys.identity.ikSigPub),
        ikDhPub: toB64(this.keys.identity.ikDhPub),
        ekPub: pk.ekPub,
        spkId: pk.spkId,
        opkId: pk.opkId,
        header,
        ct: toB64(ct),
      };
    }
    return { kind: 'msg', header, ct: toB64(ct) };
  }

  /** 已收到对端消息 → 链路双向确认，后续改用普通信封 */
  private confirmPeer(user: string, device: string) {
    const p = this.peers.get(SessionManager.key(user, device));
    if (!p) return;
    for (const r of p.records) r.pendingPrekey = null;
  }

  async decrypt(body: WireBody, fromUser: string, fromDevice: string): Promise<DecryptResult> {
    if (body.kind === 'group') throw new Error('群组密文不走本方法');

    if (body.kind === 'prekey') return this.decryptPreKey(body, fromUser, fromDevice);

    const p = this.peer(fromUser, fromDevice);
    if (p.records.length === 0) throw new Error('没有与该设备的会话，无法解密');

    const order = [
      ...p.records.filter((r) => r.id === p.current),
      ...p.records.filter((r) => r.id !== p.current),
    ];

    let lastErr: unknown = null;
    for (const rec of order) {
      const snapshot = cloneState(rec.state);
      try {
        const pt = await ratchetDecrypt(rec.state, body.header as RatchetHeader, fromB64(body.ct));
        p.current = rec.id;
        p.lastUsed[rec.id] = Date.now();
        this.confirmPeer(fromUser, fromDevice);
        return { payload: decodePayload(pt), created: false, usedOpk: null, peerIkSigPub: null };
      } catch (e) {
        rec.state = snapshot; // 回滚，别把好的链路改坏
        lastErr = e;
      }
    }
    throw new Error(`无法解密：${(lastErr as Error)?.message ?? '未知原因'}`);
  }

  private async decryptPreKey(
    body: Extract<WireBody, { kind: 'prekey' }>,
    fromUser: string,
    fromDevice: string,
  ): Promise<DecryptResult> {
    const k = this.keys;
    const p = this.peer(fromUser, fromDevice);

    // 同一 baseKey 的链路已存在（对端在收到我方回复前会连发多条预密钥消息）：
    // 先在这条现有链路上解，成功就复用；失败再重建，避免把已推进的链重置坏掉
    const existing = p.records.find((r) => r.id === body.header.dh);
    if (existing) {
      const snapshot = cloneState(existing.state);
      try {
        const pt = await ratchetDecrypt(existing.state, body.header as RatchetHeader, fromB64(body.ct));
        p.current = existing.id;
        p.lastUsed[existing.id] = Date.now();
        this.confirmPeer(fromUser, fromDevice);
        return { payload: decodePayload(pt), created: false, usedOpk: body.opkId, peerIkSigPub: body.ikSigPub };
      } catch {
        existing.state = snapshot;
      }
    }

    if (body.spkId !== k.spk.id) throw new Error('签名预密钥已失效，请让对端重新获取你的预密钥包');
    const opk = body.opkId ? k.opks.find((o) => o.id === body.opkId) : null;
    if (body.opkId && !opk) throw new Error('一次性预密钥已被消耗，请让对端重新获取');

    const { sk, ad } = x3dhRespond({
      selfDhPriv: k.identity.dhPriv,
      selfIkDhPub: k.identity.ikDhPub,
      spkPriv: k.spk.priv,
      opkPriv: opk ? opk.priv : null,
      initiatorIkDhPub: fromB64(body.ikDhPub),
      initiatorEkPub: fromB64(body.ekPub),
    });

    const state = initRatchetBob(sk, k.spk.priv, k.spk.pub, ad);

    let rec = existing;
    const created = !rec;
    if (!rec) {
      rec = {
        id: body.header.dh,
        peerUser: fromUser,
        peerDevice: fromDevice,
        peerIkDhPub: body.ikDhPub,
        state,
        pendingPrekey: null,
      };
      p.records.push(rec);
    } else {
      rec.state = state;
      rec.peerIkDhPub = body.ikDhPub;
    }

    // 新建的链路解密失败要整条撤掉，不能留下一条坏链路
    let pt: Uint8Array;
    try {
      pt = await ratchetDecrypt(rec.state, body.header as RatchetHeader, fromB64(body.ct));
    } catch (e) {
      if (created) p.records.splice(p.records.indexOf(rec), 1);
      throw e;
    }
    p.current = rec.id;
    p.lastUsed[rec.id] = Date.now();
    this.confirmPeer(fromUser, fromDevice);
    this.gc(p);

    return {
      payload: decodePayload(pt),
      created,
      usedOpk: body.opkId,
      peerIkSigPub: body.ikSigPub,
    };
  }

  opkCount(): number {
    return this.keys.opks.length;
  }

  consumeOpk(id: string) {
    this.keys.opks = this.keys.opks.filter((o) => o.id !== id);
  }
}
