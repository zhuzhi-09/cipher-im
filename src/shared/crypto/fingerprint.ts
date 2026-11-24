/**
 * 安全码（安全号码 / safety number）
 *
 * 用于线下核对身份、防中间人：双方各自看到同一串数字。
 * 算法：对排序后的两方 IK_sig 公钥做 SHA-256，取前 30 字节渲染成
 * 12 组 5 位数字（与 Signal 的 60 位展示方式一致，便于逐组念）。
 */
import { Bytes, concat, sha256, utf8, toHex } from './primitives';

export function safetyNumber(ikSigA: Bytes, ikSigB: Bytes): string {
  const aHex = toHex(ikSigA);
  const bHex = toHex(ikSigB);
  const first = aHex < bHex ? ikSigA : ikSigB;
  const second = aHex < bHex ? ikSigB : ikSigA;

  // 两轮不同域分离的哈希各出 6 组，共 12 组 / 60 位数字（与 Signal 的展示长度一致）
  let digits = '';
  for (const round of ['v1', 'v2']) {
    const digest = sha256(concat(utf8(`CipherIM-SafetyNumber-${round}`), first, second)).slice(0, 30);
    for (let i = 0; i < 30; i += 5) {
      let v = 0;
      for (let j = 0; j < 5; j++) v = v * 256 + digest[i + j];
      digits += String(v % 100000).padStart(5, '0');
    }
  }
  return digits;
}

export function formatSafetyNumber(s: string): string[] {
  return s.match(/.{1,5}/g) ?? [];
}

export function shortFingerprint(ikSig: Bytes): string {
  return toHex(sha256(ikSig).slice(0, 4)).toUpperCase();
}
