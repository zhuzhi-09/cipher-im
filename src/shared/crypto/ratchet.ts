/**
 * Double Ratchet（双棘轮）
 *
 * 目标：
 *  - 前向保密：每条消息的密钥用完即弃，泄露当前状态无法解历史
 *  - 后向保密（治愈）：收到对方新 DH 公钥即换棘轮，泄露后恢复安全
 *  - 乱序容忍：暂存被跳过的消息密钥
 *
 * 与 Signal 规范的差异（都在安全上等价或更保守，已记入 docs/SECURITY.md）：
 *  - AEAD 用 AES-256-GCM（Signal 用 AES-CBC + HMAC，我方用 AEAD 省一次 MAC）
 *  - nonce 由消息密钥确定派生（密钥保证一次性使用），省 12 字节开销
 */
import { Bytes, concat, hkdf, hmacSha256, genDh, dh, aeadSeal, aeadOpen, toB64, fromB64 } from './primitives';

export const MAX_SKIP = 512; // 单链最多容忍跳过的消息数
export const MAX_SKIPPED_KEYS = 1024; // 暂存密钥上限，防内存耗尽

export interface RatchetHeader {
  dh: string; // b64，发送方当前棘轮公钥
  pn: number; // 上一链的消息数
  n: number; // 当前链的消息序号
}

export interface RatchetState {
  dhsPriv: string;
  dhsPub: string;
  dhr: string | null;
  rk: string;
  cks: string | null;
  ckr: string | null;
  ns: number;
  nr: number;
  pn: number;
  ad: string;
  skipped: Record<string, string>;
}

function u32(n: number): Bytes {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

export function headerBytes(h: RatchetHeader): Bytes {
  return concat(fromB64(h.dh), u32(h.pn), u32(h.n));
}

function kdfRk(rk: Bytes, dhOut: Bytes): { rk: Bytes; ck: Bytes } {
  const out = hkdf(dhOut, rk, 'CipherIM-RK-v1', 64);
  return { rk: out.slice(0, 32), ck: out.slice(32, 64) };
}

function kdfCk(ck: Bytes): { ck: Bytes; mk: Bytes } {
  return {
    ck: hmacSha256(ck, Uint8Array.of(1)),
    mk: hmacSha256(ck, Uint8Array.of(2)),
  };
}

function aad(st: RatchetState, h: RatchetHeader): Bytes {
  return concat(fromB64(st.ad), headerBytes(h));
}

/** 发起方初始化：已知对端 SPK 公钥，先做一次 DH 棘轮 */
export function initRatchetAlice(sk: Bytes, bobSpkPub: Bytes, ad: Bytes): RatchetState {
  const dhs = genDh();
  const r = kdfRk(sk, dh(dhs.priv, bobSpkPub));
  return {
    dhsPriv: toB64(dhs.priv),
    dhsPub: toB64(dhs.pub),
    dhr: toB64(bobSpkPub),
    rk: toB64(r.rk),
    cks: toB64(r.ck),
    ckr: null,
    ns: 0,
    nr: 0,
    pn: 0,
    ad: toB64(ad),
    skipped: {},
  };
}

/** 接收方初始化：以自己 SPK 作为首个棘轮密钥 */
export function initRatchetBob(sk: Bytes, bobSpkPriv: Bytes, bobSpkPub: Bytes, ad: Bytes): RatchetState {
  return {
    dhsPriv: toB64(bobSpkPriv),
    dhsPub: toB64(bobSpkPub),
    dhr: null,
    rk: toB64(sk),
    cks: null,
    ckr: null,
    ns: 0,
    nr: 0,
    pn: 0,
    ad: toB64(ad),
    skipped: {},
  };
}

export async function ratchetEncrypt(st: RatchetState, plaintext: Bytes): Promise<{ header: RatchetHeader; ct: Bytes }> {
  if (!st.cks) throw new Error('发送链未初始化');
  const { ck, mk } = kdfCk(fromB64(st.cks));
  st.cks = toB64(ck);
  const header: RatchetHeader = { dh: st.dhsPub, pn: st.pn, n: st.ns };
  st.ns += 1;
  const ct = await aeadSeal(mk, plaintext, aad(st, header));
  return { header, ct };
}

function skipMessageKeys(st: RatchetState, until: number) {
  if (until <= st.nr) return; // 无消息可跳（例如对方刚换棘轮、PN=0）
  if (!st.ckr) throw new Error('接收链未初始化');
  if (until - st.nr > MAX_SKIP) throw new Error('跳过的消息过多，拒绝处理');
  while (st.nr < until) {
    const { ck, mk } = kdfCk(fromB64(st.ckr));
    st.ckr = toB64(ck);
    st.skipped[`${st.dhr}:${st.nr}`] = toB64(mk);
    st.nr += 1;
  }
  const keys = Object.keys(st.skipped);
  if (keys.length > MAX_SKIPPED_KEYS) {
    for (const k of keys.slice(0, keys.length - MAX_SKIPPED_KEYS)) delete st.skipped[k];
  }
}

function dhRatchet(st: RatchetState, theirDhpPub: string) {
  st.pn = st.ns;
  st.ns = 0;
  st.nr = 0;
  st.dhr = theirDhpPub;

  const r1 = kdfRk(fromB64(st.rk), dh(fromB64(st.dhsPriv), fromB64(theirDhpPub)));
  st.rk = toB64(r1.rk);
  st.ckr = toB64(r1.ck);

  const dhs = genDh();
  st.dhsPriv = toB64(dhs.priv);
  st.dhsPub = toB64(dhs.pub);

  const r2 = kdfRk(fromB64(st.rk), dh(dhs.priv, fromB64(theirDhpPub)));
  st.rk = toB64(r2.rk);
  st.cks = toB64(r2.ck);
}

export async function ratchetDecrypt(st: RatchetState, header: RatchetHeader, ct: Bytes): Promise<Bytes> {
  const skipKey = `${header.dh}:${header.n}`;
  const stored = st.skipped[skipKey];
  if (stored) {
    delete st.skipped[skipKey];
    return aeadOpen(fromB64(stored), ct, aad(st, header));
  }

  if (st.dhr !== header.dh) {
    if (st.dhr) skipMessageKeys(st, header.pn);
    dhRatchet(st, header.dh);
  }

  if (header.n < st.nr) throw new Error('消息密钥已丢弃（重复或过旧）');
  skipMessageKeys(st, header.n);

  if (!st.ckr) throw new Error('接收链未初始化');
  const { ck, mk } = kdfCk(fromB64(st.ckr));
  st.ckr = toB64(ck);
  st.nr += 1;
  return aeadOpen(mk, ct, aad(st, header));
}
