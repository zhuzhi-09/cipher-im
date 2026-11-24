/**
 * 群组消息加密：Sender Key（发送者密钥）
 *
 * 群聊不能每条消息按「人 × 设备」做双棘轮，否则 N 人群一条消息要加密 N 份。
 * 做法与 Signal 群组一致：
 *  - 每个成员设备为自己发起的群消息生成一条对称链（keyId + chainKey）
 *  - chainKey 通过已有的双棘轮会话，逐个加密分发给群里每台设备（SKDM）
 *  - 群里一条消息只加密一次，服务端按成员设备扇出
 *  - 成员变动 → 重新生成发送者密钥（防止退群者继续解密）
 */
import { Bytes, concat, utf8, hmacSha256, aeadSeal, aeadOpen, randomBytes, toB64, fromB64 } from './primitives';

export const MAX_CHAIN_ADVANCE = 1024;

export interface SenderKeyState {
  groupId: string;
  ownerUser: string;
  ownerDevice: string;
  keyId: string;
  chainKey: string; // b64
  iteration: number;
}

export interface SenderKeyDistribution {
  groupId: string;
  ownerUser: string;
  ownerDevice: string;
  keyId: string;
  chainKey: string;
  iteration: number;
}

function u32(n: number): Bytes {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

function groupAad(groupId: string, ownerUser: string, ownerDevice: string, keyId: string, iteration: number): Bytes {
  return concat(
    utf8('CipherIM-GRP-v1'),
    utf8(groupId),
    Uint8Array.of(0),
    utf8(ownerUser),
    Uint8Array.of(0),
    utf8(ownerDevice),
    Uint8Array.of(0),
    utf8(keyId),
    u32(iteration),
  );
}

export function createSenderKey(groupId: string, ownerUser: string, ownerDevice: string): SenderKeyState {
  return {
    groupId,
    ownerUser,
    ownerDevice,
    keyId: toB64(randomBytes(8)),
    chainKey: toB64(randomBytes(32)),
    iteration: 0,
  };
}

function ratchetChain(chainKey: Bytes): { chainKey: Bytes; mk: Bytes } {
  return {
    chainKey: hmacSha256(chainKey, Uint8Array.of(2)),
    mk: hmacSha256(chainKey, Uint8Array.of(1)),
  };
}

export async function senderKeyEncrypt(st: SenderKeyState, plaintext: Bytes): Promise<{ iteration: number; ct: Bytes }> {
  const iteration = st.iteration;
  const r = ratchetChain(fromB64(st.chainKey));
  st.chainKey = toB64(r.chainKey);
  st.iteration = iteration + 1;
  const ct = await aeadSeal(r.mk, plaintext, groupAad(st.groupId, st.ownerUser, st.ownerDevice, st.keyId, iteration));
  return { iteration, ct };
}

export function senderKeyDistribution(st: SenderKeyState): SenderKeyDistribution {
  return {
    groupId: st.groupId,
    ownerUser: st.ownerUser,
    ownerDevice: st.ownerDevice,
    keyId: st.keyId,
    chainKey: st.chainKey,
    iteration: st.iteration,
  };
}

export function senderKeyFromDistribution(d: SenderKeyDistribution): SenderKeyState {
  return { ...d };
}

export async function senderKeyDecrypt(
  st: SenderKeyState,
  keyId: string,
  iteration: number,
  ct: Bytes,
): Promise<Bytes> {
  if (st.keyId !== keyId) throw new Error('发送者密钥已轮换，需要重新分发');
  if (iteration > st.iteration + MAX_CHAIN_ADVANCE) throw new Error('消息序号跳跃过大，拒绝处理');
  if (iteration < st.iteration) throw new Error('群消息序号已过期（v1 不支持群内乱序补齐）');

  let ck = fromB64(st.chainKey);
  let mk: Bytes = new Uint8Array(0);
  for (let i = st.iteration; i <= iteration; i++) {
    const r = ratchetChain(ck);
    ck = r.chainKey;
    mk = r.mk;
  }
  st.chainKey = toB64(ck);
  st.iteration = iteration + 1;
  return aeadOpen(mk, ct, groupAad(st.groupId, st.ownerUser, st.ownerDevice, st.keyId, iteration));
}
