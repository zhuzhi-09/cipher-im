/// Double Ratchet（对应 Web 端 ratchet.ts，逐行移植）
///  - AEAD：AES-256-GCM，nonce 由一次性消息密钥确定派生
///  - 状态里的字节一律存标准 base64 字符串，和 Web 端的序列化形状一致
library;

import 'dart:typed_data';

import 'primitives.dart';

const maxSkip = 512;
const maxSkippedKeys = 1024;

class RatchetHeader {
  RatchetHeader({required this.dh, required this.pn, required this.n});
  final String dh;
  final int pn;
  final int n;

  Map<String, dynamic> toJson() => {'dh': dh, 'pn': pn, 'n': n};
  factory RatchetHeader.fromJson(Map<String, dynamic> j) =>
      RatchetHeader(dh: j['dh'] as String, pn: (j['pn'] as num).toInt(), n: (j['n'] as num).toInt());
}

class RatchetState {
  RatchetState({
    required this.dhsPriv,
    required this.dhsPub,
    required this.dhr,
    required this.rk,
    required this.cks,
    required this.ckr,
    required this.ns,
    required this.nr,
    required this.pn,
    required this.ad,
    Map<String, String>? skipped,
  }) : skipped = skipped ?? <String, String>{};

  String dhsPriv;
  String dhsPub;
  String? dhr;
  String rk;
  String? cks;
  String? ckr;
  int ns;
  int nr;
  int pn;
  String ad;
  Map<String, String> skipped; // Dart 的 Map 默认保持插入顺序：超量时先删最早的

  RatchetState copy() => RatchetState(
    dhsPriv: dhsPriv,
    dhsPub: dhsPub,
    dhr: dhr,
    rk: rk,
    cks: cks,
    ckr: ckr,
    ns: ns,
    nr: nr,
    pn: pn,
    ad: ad,
    skipped: Map.of(skipped),
  );

  /// 回滚：把另一份快照的内容整体搬回来（解密失败时用）
  void restore(RatchetState s) {
    dhsPriv = s.dhsPriv;
    dhsPub = s.dhsPub;
    dhr = s.dhr;
    rk = s.rk;
    cks = s.cks;
    ckr = s.ckr;
    ns = s.ns;
    nr = s.nr;
    pn = s.pn;
    ad = s.ad;
    skipped = Map.of(s.skipped);
  }

  Map<String, dynamic> toJson() => {
    'dhsPriv': dhsPriv,
    'dhsPub': dhsPub,
    'dhr': dhr,
    'rk': rk,
    'cks': cks,
    'ckr': ckr,
    'ns': ns,
    'nr': nr,
    'pn': pn,
    'ad': ad,
    'skipped': skipped,
  };

  factory RatchetState.fromJson(Map<String, dynamic> j) => RatchetState(
    dhsPriv: j['dhsPriv'],
    dhsPub: j['dhsPub'],
    dhr: j['dhr'],
    rk: j['rk'],
    cks: j['cks'],
    ckr: j['ckr'],
    ns: (j['ns'] as num).toInt(),
    nr: (j['nr'] as num).toInt(),
    pn: (j['pn'] as num).toInt(),
    ad: j['ad'],
    skipped: Map<String, String>.from(j['skipped'] as Map? ?? const {}),
  );
}

Bytes headerBytes(RatchetHeader h) => concat([fromB64(h.dh), u32be(h.pn), u32be(h.n)]);

({Bytes rk, Bytes ck}) _kdfRk(Bytes rk, Bytes dhOut) {
  final out = hkdf(dhOut, rk, 'CipherIM-RK-v1', 64);
  return (rk: Uint8List.sublistView(out, 0, 32), ck: Uint8List.sublistView(out, 32, 64));
}

({Bytes ck, Bytes mk}) _kdfCk(Bytes ck) =>
    (ck: hmacSha256(ck, Uint8List.fromList([1])), mk: hmacSha256(ck, Uint8List.fromList([2])));

Bytes _aad(RatchetState st, RatchetHeader h) => concat([fromB64(st.ad), headerBytes(h)]);

/// 发起方初始化：已知对端 SPK 公钥，先做一次 DH 棘轮
Future<RatchetState> initRatchetAlice(Bytes sk, Bytes bobSpkPub, Bytes ad) async {
  final dhs = await genDh();
  final r = _kdfRk(sk, await dh(dhs.priv, bobSpkPub));
  return RatchetState(
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
  );
}

/// 接收方初始化：以自己 SPK 作为首个棘轮密钥
RatchetState initRatchetBob(Bytes sk, Bytes bobSpkPriv, Bytes bobSpkPub, Bytes ad) => RatchetState(
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
);

Future<({RatchetHeader header, Bytes ct})> ratchetEncrypt(RatchetState st, Bytes plaintext) async {
  final cks = st.cks;
  if (cks == null) throw CryptoException('发送链未初始化');
  final r = _kdfCk(fromB64(cks));
  st.cks = toB64(r.ck);
  final header = RatchetHeader(dh: st.dhsPub, pn: st.pn, n: st.ns);
  st.ns += 1;
  final ct = await aeadSeal(r.mk, plaintext, _aad(st, header));
  return (header: header, ct: ct);
}

void _skipMessageKeys(RatchetState st, int until) {
  if (until <= st.nr) return;
  if (st.ckr == null) throw CryptoException('接收链未初始化');
  if (until - st.nr > maxSkip) throw CryptoException('跳过的消息过多，拒绝处理');
  while (st.nr < until) {
    final r = _kdfCk(fromB64(st.ckr!));
    st.ckr = toB64(r.ck);
    st.skipped['${st.dhr}:${st.nr}'] = toB64(r.mk);
    st.nr += 1;
  }
  final extra = st.skipped.length - maxSkippedKeys;
  if (extra > 0) {
    for (final k in st.skipped.keys.take(extra).toList()) {
      st.skipped.remove(k);
    }
  }
}

Future<void> _dhRatchet(RatchetState st, String theirDhPub) async {
  st.pn = st.ns;
  st.ns = 0;
  st.nr = 0;
  st.dhr = theirDhPub;

  final r1 = _kdfRk(fromB64(st.rk), await dh(fromB64(st.dhsPriv), fromB64(theirDhPub)));
  st.rk = toB64(r1.rk);
  st.ckr = toB64(r1.ck);

  final dhs = await genDh();
  st.dhsPriv = toB64(dhs.priv);
  st.dhsPub = toB64(dhs.pub);

  final r2 = _kdfRk(fromB64(st.rk), await dh(dhs.priv, fromB64(theirDhPub)));
  st.rk = toB64(r2.rk);
  st.cks = toB64(r2.ck);
}

Future<Bytes> ratchetDecrypt(RatchetState st, RatchetHeader header, Bytes ct) async {
  final skipKey = '${header.dh}:${header.n}';
  final stored = st.skipped.remove(skipKey);
  if (stored != null) return aeadOpen(fromB64(stored), ct, _aad(st, header));

  if (st.dhr != header.dh) {
    if (st.dhr != null) _skipMessageKeys(st, header.pn);
    await _dhRatchet(st, header.dh);
  }

  if (header.n < st.nr) throw CryptoException('消息密钥已丢弃（重复或过旧）');
  _skipMessageKeys(st, header.n);

  final ckr = st.ckr;
  if (ckr == null) throw CryptoException('接收链未初始化');
  final r = _kdfCk(fromB64(ckr));
  st.ckr = toB64(r.ck);
  st.nr += 1;
  return aeadOpen(r.mk, ct, _aad(st, header));
}
