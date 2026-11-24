/**
 * 测试用确定性随机数：替换 globalThis.crypto.getRandomValues，让加密流程可复现
 *
 * 规格（Dart 端必须一模一样）：
 *   setRng(label) 之后，随机字节流 = block(0) || block(1) || block(2) || …
 *   block(i) = SHA-256( utf8("CipherIM-test-rng-v1|" + label) || u32be(i) )
 *   每次取随机数都从流里按顺序往后拿，上次没用完的字节留给下次（流式，不按调用对齐）
 *
 * 只用于生成 / 校验测试数据，绝不能出现在产品代码里。
 */
import { sha256 } from '@noble/hashes/sha256';

let prefix = new Uint8Array(0);
let counter = 0;
let pool: Uint8Array = new Uint8Array(0);
let label: string | null = null;

export function setRng(l: string) {
  label = l;
  prefix = new TextEncoder().encode(`CipherIM-test-rng-v1|${l}`);
  counter = 0;
  pool = new Uint8Array(0);
}

function nextBlock(): Uint8Array {
  const buf = new Uint8Array(prefix.length + 4);
  buf.set(prefix, 0);
  new DataView(buf.buffer).setUint32(prefix.length, counter);
  counter += 1;
  return sha256(buf);
}

export function rngBytes(n: number): Uint8Array {
  if (label === null) throw new Error('测试随机数未初始化：先 setRng(label)');
  const out = new Uint8Array(n);
  let off = 0;
  while (off < n) {
    if (pool.length === 0) pool = nextBlock();
    const take = Math.min(pool.length, n - off);
    out.set(pool.subarray(0, take), off);
    pool = pool.slice(take);
    off += take;
  }
  return out;
}

/** 把全局 getRandomValues 换成上面的确定性流 */
export function installDeterministicRng() {
  const fn = <T extends ArrayBufferView | null>(arr: T): T => {
    if (!arr) return arr;
    const view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    view.set(rngBytes(view.length));
    return arr;
  };
  Object.defineProperty(globalThis.crypto, 'getRandomValues', { value: fn, configurable: true, writable: true });
}
