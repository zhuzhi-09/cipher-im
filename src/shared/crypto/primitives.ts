/**
 * 密码学原语封装
 * - X25519 / Ed25519 用 @noble（纯 JS，浏览器与 Node 行为一致，不依赖 WebCrypto 的曲线支持）
 * - AES-256-GCM 用 WebCrypto（Chrome/Firefox/Safari/Node22 都原生支持，硬件加速）
 * 所有函数只接受 / 返回 Uint8Array，字符串编码一律显式指定，避免隐式转换坑。
 */
import { x25519, ed25519 } from '@noble/curves/ed25519';
import { sha256 as _sha256 } from '@noble/hashes/sha256';
import { hkdf as _hkdf } from '@noble/hashes/hkdf';
import { hmac as _hmac } from '@noble/hashes/hmac';

export type Bytes = Uint8Array;
export interface KeyPair {
  priv: Bytes;
  pub: Bytes;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function utf8(s: string): Bytes {
  return enc.encode(s);
}
export function fromUtf8(b: Bytes): string {
  return dec.decode(b);
}

export function randomBytes(n: number): Bytes {
  // WebCrypto 单次 getRandomValues 上限 65536 字节，大块需分段填充
  const b = new Uint8Array(n);
  const CHUNK = 65536;
  for (let off = 0; off < n; off += CHUNK) {
    globalThis.crypto.getRandomValues(b.subarray(off, Math.min(off + CHUNK, n)));
  }
  return b;
}

export function concat(...parts: Bytes[]): Bytes {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function equal(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ---------------- 编解码 ---------------- */

export function toHex(b: Bytes): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}
export function fromHex(s: string): Bytes {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toB64(b: Bytes): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const rest = b.length - i;
    const b0 = b[i];
    const b1 = rest > 1 ? b[i + 1] : 0;
    const b2 = rest > 2 ? b[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += rest > 1 ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += rest > 2 ? B64[b2 & 63] : '=';
  }
  return out;
}
export function fromB64(s: string): Bytes {
  const clean = s.replace(/=+$/, '').replace(/\s+/g, '');
  const out: number[] = [];
  const idx = (c: string) => B64.indexOf(c);
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = idx(clean[i]);
    const c1 = i + 1 < clean.length ? idx(clean[i + 1]) : 0;
    const c2 = i + 2 < clean.length ? idx(clean[i + 2]) : -1;
    const c3 = i + 3 < clean.length ? idx(clean[i + 3]) : -1;
    if (c0 < 0 || c1 < 0) throw new Error('bad base64');
    out.push((c0 << 2) | (c1 >> 4));
    if (c2 >= 0) out.push(((c1 & 15) << 4) | (c2 >> 2));
    if (c3 >= 0) out.push(((c2 & 3) << 6) | c3);
  }
  return new Uint8Array(out);
}

/* ---------------- 哈希 / KDF / MAC ---------------- */

export function sha256(b: Bytes): Bytes {
  return _sha256(b);
}

export function hkdf(ikm: Bytes, salt: Bytes, info: string, len: number): Bytes {
  return _hkdf(_sha256, ikm, salt, utf8(info), len);
}

export function hmacSha256(key: Bytes, data: Bytes): Bytes {
  return _hmac(_sha256, key, data);
}

/* ---------------- X25519 ---------------- */

export function genDh(): KeyPair {
  const priv = randomBytes(32);
  return { priv, pub: x25519.getPublicKey(priv) };
}

export function dhPubFromPriv(priv: Bytes): Bytes {
  return x25519.getPublicKey(priv);
}

export function dh(priv: Bytes, pub: Bytes): Bytes {
  return x25519.getSharedSecret(priv, pub);
}

/* ---------------- Ed25519 ---------------- */

export function genSigSeed(): Bytes {
  return randomBytes(32);
}
export function sigPub(seed: Bytes): Bytes {
  return ed25519.getPublicKey(seed);
}
export function sign(seed: Bytes, msg: Bytes): Bytes {
  return ed25519.sign(msg, seed);
}
export function verify(pub: Bytes, msg: Bytes, sig: Bytes): boolean {
  try {
    return ed25519.verify(sig, msg, pub);
  } catch {
    return false;
  }
}

/* ---------------- AEAD ---------------- */

function aeadNonce(key: Bytes): Bytes {
  // 密钥在协议里保证一次性使用（链密钥每步派生新 mk），因此由密钥确定派生 nonce 是安全的，
  // 且省掉每包 12 字节的随机 nonce。绝不对同一 key 加密两次（上层保证）。
  return sha256(concat(key, utf8('aead-nonce'))).slice(0, 12);
}

const subtle = globalThis.crypto.subtle;

async function importAes(raw: Bytes): Promise<CryptoKey> {
  return subtle.importKey('raw', raw as unknown as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function aeadSeal(key: Bytes, plaintext: Bytes, aad: Bytes): Promise<Bytes> {
  const k = await importAes(key);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: aeadNonce(key) as unknown as BufferSource, additionalData: aad as unknown as BufferSource, tagLength: 128 },
    k,
    plaintext as unknown as BufferSource,
  );
  return new Uint8Array(ct);
}

export async function aeadOpen(key: Bytes, ct: Bytes, aad: Bytes): Promise<Bytes> {
  const k = await importAes(key);
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: aeadNonce(key) as unknown as BufferSource, additionalData: aad as unknown as BufferSource, tagLength: 128 },
    k,
    ct as unknown as BufferSource,
  );
  return new Uint8Array(pt);
}

/**
 * 随机 nonce 版本：用于「同一密钥会重复加密不同数据」的场景（本地密钥库落盘）。
 * 输出格式 = nonce(12B) || 密文，解密时自动拆解。
 * 切记：消息链路里要用上面的 aeadSeal（密钥一次性），这里不要混用。
 */
export async function aeadSealRandom(key: Bytes, plaintext: Bytes, aad: Bytes): Promise<Bytes> {
  const nonce = randomBytes(12);
  const k = await importAes(key);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as unknown as BufferSource, additionalData: aad as unknown as BufferSource, tagLength: 128 },
    k,
    plaintext as unknown as BufferSource,
  );
  return concat(nonce, new Uint8Array(ct));
}

export async function aeadOpenRandom(key: Bytes, packed: Bytes, aad: Bytes): Promise<Bytes> {
  if (packed.length < 13) throw new Error('密文长度异常');
  const nonce = packed.slice(0, 12);
  const k = await importAes(key);
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as unknown as BufferSource, additionalData: aad as unknown as BufferSource, tagLength: 128 },
    k,
    packed.slice(12) as unknown as BufferSource,
  );
  return new Uint8Array(pt);
}

/* ---------------- 口令 KDF（本地密钥库用） ---------------- */

export async function pbkdf2(password: string, salt: Bytes, iterations = 200000): Promise<Bytes> {
  const baseKey = await subtle.importKey('raw', utf8(password) as unknown as BufferSource, 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}
