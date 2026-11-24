/**
 * X3DH（Extended Triple Diffie-Hellman）密钥协商
 *
 * 标准 Signal 流程的四次 DH：
 *   DH1 = DH(IK_A, SPK_B)
 *   DH2 = DH(EK_A, IK_B)
 *   DH3 = DH(EK_A, SPK_B)
 *   DH4 = DH(EK_A, OPK_B)   ← 无 OPK 时省略，隐私性略降但可用
 * SK = HKDF(DH1||DH2||DH3||DH4)
 *
 * AD（关联数据）= IK_A_dh || IK_B_dh，绑进每条消息的 AAD，防止会话混淆。
 */
import { Bytes, concat, hkdf, genDh, dh, fromB64, toB64 } from './primitives';
import { Identity, PublicBundle, verifyBundle } from './identity';

const ZERO_SALT = new Uint8Array(32);

export interface X3DHInitResult {
  sk: Bytes;
  ad: Bytes;
  ekPriv: Bytes;
  ekPub: Bytes;
  spkId: string;
  opkId: string | null;
}

export function x3dhInitiate(self: Identity, peer: PublicBundle): X3DHInitResult {
  if (!verifyBundle(peer)) throw new Error('对端预密钥包签名无效，可能被中间人篡改');

  const spk = fromB64(peer.spkPub);
  const ikDhB = fromB64(peer.ikDhPub);
  const ek = genDh();

  const dh1 = dh(self.dhPriv, spk);
  const dh2 = dh(ek.priv, ikDhB);
  const dh3 = dh(ek.priv, spk);
  const dh4 = peer.opks.length > 0 ? dh(ek.priv, fromB64(peer.opks[0].pub)) : new Uint8Array(0);

  const sk = hkdf(concat(dh1, dh2, dh3, dh4), ZERO_SALT, 'CipherIM-X3DH-v1', 32);
  const ad = concat(self.ikDhPub, ikDhB);

  return {
    sk,
    ad,
    ekPriv: ek.priv,
    ekPub: ek.pub,
    spkId: peer.spkId,
    opkId: peer.opks.length > 0 ? peer.opks[0].id : null,
  };
}

export interface X3DHRespondInput {
  selfDhPriv: Bytes;
  selfIkDhPub: Bytes;
  spkPriv: Bytes;
  opkPriv: Bytes | null;
  initiatorIkDhPub: Bytes;
  initiatorEkPub: Bytes;
}

export function x3dhRespond(input: X3DHRespondInput): { sk: Bytes; ad: Bytes } {
  const dh1 = dh(input.spkPriv, input.initiatorIkDhPub);
  const dh2 = dh(input.selfDhPriv, input.initiatorEkPub);
  const dh3 = dh(input.spkPriv, input.initiatorEkPub);
  const dh4 = input.opkPriv ? dh(input.opkPriv, input.initiatorEkPub) : new Uint8Array(0);

  const sk = hkdf(concat(dh1, dh2, dh3, dh4), ZERO_SALT, 'CipherIM-X3DH-v1', 32);
  const ad = concat(input.initiatorIkDhPub, input.selfIkDhPub);
  return { sk, ad };
}

export function bundleToWire(b: PublicBundle) {
  return b;
}

export function b64(b: Bytes): string {
  return toB64(b);
}
