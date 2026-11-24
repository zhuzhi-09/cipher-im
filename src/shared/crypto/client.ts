/**
 * 加密客户端：把会话（双棘轮）和群组（发送者密钥）拼成业务可直接调用的接口
 *  - 直聊：给对端每台设备各加密一份
 *  - 群聊：自己一条发送者密钥链，加密一次，服务端按成员设备扇出
 *  - 收到任何载荷都先解密再判断类型；收到群密钥分发（skdm）自动入库
 */
import { DeviceKeys, PublicBundle } from './identity';
import { toB64, fromB64, utf8, fromUtf8 } from './primitives';
import { SessionManager, DecryptResult } from './session';
import {
  SenderKeyState,
  createSenderKey,
  senderKeyEncrypt,
  senderKeyDecrypt,
  senderKeyDistribution,
  senderKeyFromDistribution,
  SenderKeyDistribution,
} from './senderkey';
import type { WireBody, Payload, GroupBody } from '../protocol';

export interface Target {
  user: string;
  device: string;
}

export interface EncryptedFor {
  user: string;
  device: string;
  body: WireBody;
}

export function bundleKey(user: string, device: string): string {
  return `${user}/${device}`;
}

export function senderKeyMapKey(groupId: string, user: string, device: string): string {
  return `${groupId}|${user}|${device}`;
}

export class CryptoClient {
  sessions: SessionManager;
  ownSenderKeys = new Map<string, SenderKeyState>();
  peerSenderKeys = new Map<string, SenderKeyState>();

  constructor(
    public username: string,
    public deviceId: string,
    public keys: DeviceKeys,
  ) {
    this.sessions = new SessionManager(keys);
  }

  /** 对一批目标设备加密同一条载荷。缺预密钥包的设备会被跳过并在 skipped 里返回 */
  async encryptToDevices(
    targets: Target[],
    bundles: Map<string, PublicBundle>,
    payload: Payload,
  ): Promise<{ bodies: EncryptedFor[]; skipped: Target[] }> {
    const bodies: EncryptedFor[] = [];
    const skipped: Target[] = [];
    for (const t of targets) {
      if (t.user === this.username && t.device === this.deviceId) continue; // 不给自己发
      if (!this.sessions.has(t.user, t.device)) {
        const b = bundles.get(bundleKey(t.user, t.device));
        if (!b) {
          skipped.push(t);
          continue;
        }
        this.sessions.establish(t.user, t.device, b);
      }
      bodies.push({ ...t, body: await this.sessions.encrypt(t.user, t.device, payload) });
    }
    return { bodies, skipped };
  }

  async decryptFrom(user: string, device: string, body: WireBody): Promise<DecryptResult> {
    const r = await this.sessions.decrypt(body, user, device);
    if (r.payload.t === 'skdm') {
      const d = r.payload.dist;
      this.peerSenderKeys.set(senderKeyMapKey(d.groupId, d.ownerUser, d.ownerDevice), senderKeyFromDistribution(d));
    }
    if (r.usedOpk) this.sessions.consumeOpk(r.usedOpk);
    return r;
  }

  /* ---------------- 群组 ---------------- */

  ensureOwnSenderKey(groupId: string): { state: SenderKeyState; created: boolean } {
    let st = this.ownSenderKeys.get(groupId);
    if (!st) {
      st = createSenderKey(groupId, this.username, this.deviceId);
      this.ownSenderKeys.set(groupId, st);
    }
    return { state: st, created: false };
  }

  /** 成员变动时轮换：丢掉旧链，下次发消息自动生成新密钥 */
  rotateOwnSenderKey(groupId: string): void {
    this.ownSenderKeys.delete(groupId);
  }

  async encryptGroup(groupId: string, payload: Payload): Promise<GroupBody> {
    const { state } = this.ensureOwnSenderKey(groupId);
    const { iteration, ct } = await senderKeyEncrypt(state, utf8(JSON.stringify(payload)));
    return {
      kind: 'group',
      groupId,
      ownerUser: this.username,
      ownerDevice: this.deviceId,
      keyId: state.keyId,
      iteration,
      ct: toB64(ct),
    };
  }

  async decryptGroup(body: GroupBody): Promise<Payload> {
    const st = this.peerSenderKeys.get(senderKeyMapKey(body.groupId, body.ownerUser, body.ownerDevice));
    if (!st) throw new Error('还没有收到该发送者的群密钥，无法解密');
    const pt = await senderKeyDecrypt(st, body.keyId, body.iteration, fromB64(body.ct));
    return JSON.parse(fromUtf8(pt)) as Payload;
  }

  /** 生成「把自己的群密钥分发出去」的密文，逐设备一份 */
  async buildSenderKeyDistribution(
    groupId: string,
    targets: Target[],
    bundles: Map<string, PublicBundle>,
  ): Promise<{ bodies: EncryptedFor[]; skipped: Target[] }> {
    const { state } = this.ensureOwnSenderKey(groupId);
    const dist: SenderKeyDistribution = senderKeyDistribution(state);
    return this.encryptToDevices(targets, bundles, { t: 'skdm', dist });
  }

  hasPeerSenderKey(groupId: string, user: string, device: string): boolean {
    return this.peerSenderKeys.has(senderKeyMapKey(groupId, user, device));
  }
}
