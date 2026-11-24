/**
 * 身份密钥与预密钥
 *
 * 每个「账号 + 设备」持有一份独立身份：
 *  - IK_sig：Ed25519，长期签名密钥（用于给 SPK 签名、生成安全码）
 *  - IK_dh ：X25519，长期 DH 密钥（参与 X3DH）
 *  - SPK   ：X25519 中等期密钥，由 IK_sig 签名后上传
 *  - OPK   ：X25519 一次性密钥池，服务端按需消耗
 *
 * 私钥永远只在设备上，服务端只拿得到公钥。
 */
import {
  Bytes,
  concat,
  sha256,
  utf8,
  genDh,
  dhPubFromPriv,
  dh,
  genSigSeed,
  sigPub,
  sign,
  verify,
  toB64,
  fromB64,
  randomBytes,
} from './primitives';

export const SPK_DOMAIN = utf8('CipherIM-SPK-v1');

export interface Identity {
  sigSeed: Bytes; // Ed25519 私钥种子
  dhPriv: Bytes; // X25519 私钥
  ikSigPub: Bytes;
  ikDhPub: Bytes;
}

export interface PreKeyPair {
  id: string;
  priv: Bytes;
  pub: Bytes;
}

export interface SpkPair extends PreKeyPair {
  sig: Bytes; // 由 IK_sig 对 SPK_DOMAIN||pub 的签名
}

export interface DeviceKeys {
  identity: Identity;
  spk: SpkPair;
  opks: PreKeyPair[];
}

export interface PublicBundle {
  ikSigPub: string; // b64
  ikDhPub: string; // b64
  spkId: string;
  spkPub: string; // b64
  spkSig: string; // b64
  opks: { id: string; pub: string }[];
}

/** 从 Ed25519 种子确定派生 DH 私钥：避免用户看到两份独立种子，也方便备份 */
function deriveDhPrivate(seed: Bytes): Bytes {
  return sha256(concat(seed, utf8('CipherIM-dh-derive-v1')));
}

export function createIdentity(): Identity {
  const sigSeed = genSigSeed();
  const dhPriv = deriveDhPrivate(sigSeed);
  return {
    sigSeed,
    dhPriv,
    ikSigPub: sigPub(sigSeed),
    ikDhPub: dhPubFromPriv(dhPriv),
  };
}

export function createSpk(identity: Identity): SpkPair {
  const kp = genDh();
  const id = toB64(randomBytes(6));
  return {
    id,
    priv: kp.priv,
    pub: kp.pub,
    sig: sign(identity.sigSeed, concat(SPK_DOMAIN, kp.pub)),
  };
}

export function createOpks(n: number): PreKeyPair[] {
  return Array.from({ length: n }, () => {
    const kp = genDh();
    return { id: toB64(randomBytes(6)), priv: kp.priv, pub: kp.pub };
  });
}

export function createDeviceKeys(opkN = 24): DeviceKeys {
  const identity = createIdentity();
  const spk = createSpk(identity);
  const opks = createOpks(opkN);
  return { identity, spk, opks };
}

export function publicBundleOf(keys: DeviceKeys): PublicBundle {
  return {
    ikSigPub: toB64(keys.identity.ikSigPub),
    ikDhPub: toB64(keys.identity.ikDhPub),
    spkId: keys.spk.id,
    spkPub: toB64(keys.spk.pub),
    spkSig: toB64(keys.spk.sig),
    opks: keys.opks.map((o) => ({ id: o.id, pub: toB64(o.pub) })),
  };
}

export function verifyBundle(b: PublicBundle): boolean {
  const ikSigPub = fromB64(b.ikSigPub);
  return verify(ikSigPub, concat(SPK_DOMAIN, fromB64(b.spkPub)), fromB64(b.spkSig));
}

/* ---------------- 序列化（本地密钥库用） ---------------- */

export interface SerializedIdentity {
  sigSeed: string;
  dhPriv: string;
  ikSigPub: string;
  ikDhPub: string;
}

export function serializeIdentity(i: Identity): SerializedIdentity {
  return {
    sigSeed: toB64(i.sigSeed),
    dhPriv: toB64(i.dhPriv),
    ikSigPub: toB64(i.ikSigPub),
    ikDhPub: toB64(i.ikDhPub),
  };
}

export function deserializeIdentity(s: SerializedIdentity): Identity {
  return {
    sigSeed: fromB64(s.sigSeed),
    dhPriv: fromB64(s.dhPriv),
    ikSigPub: fromB64(s.ikSigPub),
    ikDhPub: fromB64(s.ikDhPub),
  };
}

export function identityDhShared(self: Identity, peerPub: Bytes): Bytes {
  return dh(self.dhPriv, peerPub);
}
