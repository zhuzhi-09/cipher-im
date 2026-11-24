/**
 * 跨设备漫游密钥（Roaming Key）
 *
 * 问题：消息是按「目标设备」加密投递的，新设备没有旧设备的私钥，读不到历史。
 * 做法：每个账号额外有一对 X25519 漫游密钥；发消息时，发送方把明文载荷
 *       再用「收件账号的漫游公钥」封一份历史副本存到服务端，只有该账号的设备能解。
 *
 * 分发：漫游私钥用「账号口令 → PBKDF2 → KEK」封起来存服务端（口令解封模型），
 *       同一账号的新设备输对口令即可解封，旧设备不必在场。
 * 代价：口令泄露 = 该账号历史副本可被解（与本地密钥库同一级别的风险），文档里写明。
 */
import { Bytes, toB64, fromB64, utf8, genDh, dh, hkdf, aeadSeal, aeadOpen, pbkdf2, aeadSealRandom, aeadOpenRandom, randomBytes, concat, equal } from './primitives';

const INFO = 'CipherIM-roam-v1';
const AAD = utf8('CipherIM-roam-msg');
const KEY_AAD = utf8('CipherIM-roam-key-v1');

export interface RoamKeyPair {
  priv: Bytes;
  pub: Bytes;
}

export function createRoamKeys(): RoamKeyPair {
  return genDh();
}

// 注意 salt 必须两端一致：用临时公钥（双方都知道），不能用各自视角的「对端公钥」
// ——封的时候对端是漫游公钥、解的时候对端是临时公钥，拿它当 salt 会派生出两把不同的密钥。
function deriveRoamKey(priv: Bytes, peerPub: Bytes, ephPub: Bytes): Bytes {
  const shared = dh(priv, peerPub);
  // X25519 对低阶点会返回全零，遇到就直接拒绝（正常实现对端不会产生这种公钥）
  if (equal(shared, new Uint8Array(32))) throw new Error('漫游密钥协商失败');
  return hkdf(shared, ephPub, INFO, 32);
}

/** 用对方的漫游公钥密封一段明文；每次新生成临时密钥，所以可以安全用确定性 nonce */
export async function sealForRoam(roamPub: Bytes, plaintext: Bytes): Promise<{ eph: string; ct: string }> {
  const eph = genDh();
  const key = deriveRoamKey(eph.priv, roamPub, eph.pub);
  const ct = await aeadSeal(key, plaintext, concat(AAD, eph.pub));
  return { eph: toB64(eph.pub), ct: toB64(ct) };
}

export async function openRoam(roamPriv: Bytes, ephB64: string, ctB64: string): Promise<Bytes> {
  const ephPub = fromB64(ephB64);
  const key = deriveRoamKey(roamPriv, ephPub, ephPub);
  return aeadOpen(key, fromB64(ctB64), concat(AAD, ephPub));
}

/** 口令 → KEK，把漫游私钥封起来上传（服务端拿不到口令就解不开） */
export async function wrapRoamPriv(password: string, priv: Bytes): Promise<{ salt: string; sealed: string }> {
  const salt = randomBytes(32);
  const kek = await pbkdf2(password, salt, 200000);
  const sealed = await aeadSealRandom(kek, priv, KEY_AAD);
  return { salt: toB64(salt), sealed: toB64(sealed) };
}

export async function unwrapRoamPriv(password: string, saltB64: string, sealedB64: string): Promise<Bytes> {
  const kek = await pbkdf2(password, fromB64(saltB64), 200000);
  try {
    return await aeadOpenRandom(kek, fromB64(sealedB64), KEY_AAD);
  } catch {
    throw new Error('口令无法解封漫游密钥');
  }
}
