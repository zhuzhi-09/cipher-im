/**
 * 测试数据里「会话脚本」的每一步怎么执行——导出器和校验器共用，保证两边语义一致
 * Dart 端照着这里的语义实现自己的回放器。
 */
import { CryptoClient } from '../../shared/crypto/client';
import type { DeviceKeys, PublicBundle } from '../../shared/crypto/identity';
import { fromB64, toB64 } from '../../shared/crypto/primitives';
import type { GroupBody, WireBody } from '../../shared/protocol';
import { setRng } from './rng';

export interface SerializedKeys {
  identity: { sigSeed: string; dhPriv: string; ikSigPub: string; ikDhPub: string };
  spk: { id: string; priv: string; pub: string; sig: string };
  opks: { id: string; priv: string; pub: string }[];
}

export function serializeKeys(k: DeviceKeys): SerializedKeys {
  return {
    identity: {
      sigSeed: toB64(k.identity.sigSeed),
      dhPriv: toB64(k.identity.dhPriv),
      ikSigPub: toB64(k.identity.ikSigPub),
      ikDhPub: toB64(k.identity.ikDhPub),
    },
    spk: { id: k.spk.id, priv: toB64(k.spk.priv), pub: toB64(k.spk.pub), sig: toB64(k.spk.sig) },
    opks: k.opks.map((o) => ({ id: o.id, priv: toB64(o.priv), pub: toB64(o.pub) })),
  };
}

export function deserializeKeys(s: SerializedKeys): DeviceKeys {
  return {
    identity: {
      sigSeed: fromB64(s.identity.sigSeed),
      dhPriv: fromB64(s.identity.dhPriv),
      ikSigPub: fromB64(s.identity.ikSigPub),
      ikDhPub: fromB64(s.identity.ikDhPub),
    },
    spk: { id: s.spk.id, priv: fromB64(s.spk.priv), pub: fromB64(s.spk.pub), sig: fromB64(s.spk.sig) },
    opks: s.opks.map((o) => ({ id: o.id, priv: fromB64(o.priv), pub: fromB64(o.pub) })),
  };
}

export interface Party {
  user: string;
  device: string;
  keys: SerializedKeys;
}

type Target = { user: string; device: string };

/** 每一步的输入；输出字段在 StepOut 里 */
export type StepIn =
  | { op: 'encrypt'; actor: string; targets: Target[]; bundles: Record<string, PublicBundle>; payloadJson: string }
  | { op: 'decrypt'; actor: string; from: Target; body: WireBody }
  | { op: 'distributeSenderKey'; actor: string; groupId: string; targets: Target[]; bundles: Record<string, PublicBundle> }
  | { op: 'encryptGroup'; actor: string; groupId: string; payloadJson: string }
  | { op: 'decryptGroup'; actor: string; body: GroupBody }
  | { op: 'rotateSenderKey'; actor: string; groupId: string };

export type StepOut =
  | { bodies: { user: string; device: string; body: WireBody }[]; skipped: Target[] }
  | { payloadJson: string; created?: boolean; usedOpk?: string | null }
  | { body: GroupBody }
  | { error: true }
  | Record<string, never>;

export type Step = StepIn & { rng: string; note: string; expect: StepOut };

export class World {
  clients = new Map<string, CryptoClient>();
  constructor(parties: Record<string, Party>) {
    for (const [name, p] of Object.entries(parties)) {
      this.clients.set(name, new CryptoClient(p.user, p.device, deserializeKeys(p.keys)));
    }
  }

  private c(name: string): CryptoClient {
    const c = this.clients.get(name);
    if (!c) throw new Error(`没有这个角色：${name}`);
    return c;
  }

  /** 执行一步；预期会失败的步骤（解不开）返回 { error: true } */
  async run(s: StepIn & { rng: string }): Promise<StepOut> {
    setRng(s.rng);
    const c = this.c(s.actor);
    const bmap = (b: Record<string, PublicBundle>) => new Map(Object.entries(b));
    try {
      switch (s.op) {
        case 'encrypt': {
          const r = await c.encryptToDevices(s.targets, bmap(s.bundles), JSON.parse(s.payloadJson));
          return { bodies: r.bodies, skipped: r.skipped };
        }
        case 'decrypt': {
          const r = await c.decryptFrom(s.from.user, s.from.device, s.body);
          return { payloadJson: JSON.stringify(r.payload), created: r.created, usedOpk: r.usedOpk };
        }
        case 'distributeSenderKey': {
          const r = await c.buildSenderKeyDistribution(s.groupId, s.targets, bmap(s.bundles));
          return { bodies: r.bodies, skipped: r.skipped };
        }
        case 'encryptGroup':
          return { body: await c.encryptGroup(s.groupId, JSON.parse(s.payloadJson)) };
        case 'decryptGroup':
          return { payloadJson: JSON.stringify(await c.decryptGroup(s.body)) };
        case 'rotateSenderKey':
          c.rotateOwnSenderKey(s.groupId);
          return {};
      }
    } catch {
      return { error: true };
    }
  }
}
