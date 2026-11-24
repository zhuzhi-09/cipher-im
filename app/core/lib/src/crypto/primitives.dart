/// 密码学原语：与 Web 端 src/shared/crypto/primitives.ts 逐字节一致
///  - SHA-256 / HMAC / HKDF：package:crypto（同步）
///  - X25519 / Ed25519 / AES-256-GCM / PBKDF2：package:cryptography（异步）
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as c;
import 'package:cryptography/cryptography.dart' as cg;

import 'random.dart';

typedef Bytes = Uint8List;

class CryptoException implements Exception {
  CryptoException(this.message);
  final String message;
  @override
  String toString() => message;
}

/* ---------------- 编解码 ---------------- */

Bytes utf8Bytes(String s) => Uint8List.fromList(utf8.encode(s));
String fromUtf8(Bytes b) => utf8.decode(b);

Bytes concat(List<Bytes> parts) {
  final b = BytesBuilder(copy: false);
  for (final p in parts) {
    b.add(p);
  }
  return b.toBytes();
}

bool bytesEqual(Bytes a, Bytes b) {
  if (a.length != b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff == 0;
}

String toHex(Bytes b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Bytes fromHex(String s) {
  final out = Uint8List(s.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(s.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

/// 标准 base64，带 = 填充（与 Web 端 toB64 一致）
String toB64(Bytes b) => base64.encode(b);

/// 宽松解码：容忍缺少填充和空白（与 Web 端 fromB64 一致）
Bytes fromB64(String s) {
  final clean = s.replaceAll(RegExp(r'\s+'), '').replaceAll(RegExp(r'=+$'), '');
  if (clean.length % 4 == 1) throw const FormatException('bad base64');
  return Uint8List.fromList(base64.decode(base64.normalize(clean)));
}

Bytes u32be(int n) {
  final b = Uint8List(4);
  ByteData.sublistView(b).setUint32(0, n);
  return b;
}

/* ---------------- 哈希 / KDF / MAC ---------------- */

Bytes sha256(Bytes b) => Uint8List.fromList(c.sha256.convert(b).bytes);

Bytes hmacSha256(Bytes key, Bytes data) => Uint8List.fromList(c.Hmac(c.sha256, key).convert(data).bytes);

/// HKDF-SHA256（RFC 5869）
Bytes hkdf(Bytes ikm, Bytes salt, String info, int len) {
  final prk = hmacSha256(salt.isEmpty ? Uint8List(32) : salt, ikm);
  final infoB = utf8Bytes(info);
  final out = BytesBuilder();
  var t = Uint8List(0);
  for (var i = 1; out.length < len; i++) {
    t = hmacSha256(
      prk,
      concat([
        t,
        infoB,
        Uint8List.fromList([i]),
      ]),
    );
    out.add(t);
  }
  return Uint8List.sublistView(out.toBytes(), 0, len);
}

/* ---------------- X25519 ---------------- */

final _x25519 = cg.X25519();

class KeyPair {
  KeyPair(this.priv, this.pub);
  final Bytes priv;
  final Bytes pub;
}

Future<Bytes> dhPubFromPriv(Bytes priv) async {
  final kp = await _x25519.newKeyPairFromSeed(priv);
  return Uint8List.fromList((await kp.extractPublicKey()).bytes);
}

Future<KeyPair> genDh() async {
  final priv = randomBytes(32);
  return KeyPair(priv, await dhPubFromPriv(priv));
}

Future<Bytes> dh(Bytes priv, Bytes pub) async {
  final kp = await _x25519.newKeyPairFromSeed(priv);
  final shared = await _x25519.sharedSecretKey(
    keyPair: kp,
    remotePublicKey: cg.SimplePublicKey(pub, type: cg.KeyPairType.x25519),
  );
  return Uint8List.fromList(await shared.extractBytes());
}

/* ---------------- Ed25519 ---------------- */

final _ed25519 = cg.Ed25519();

Future<Bytes> sigPub(Bytes seed) async {
  final kp = await _ed25519.newKeyPairFromSeed(seed);
  return Uint8List.fromList((await kp.extractPublicKey()).bytes);
}

Future<Bytes> sign(Bytes seed, Bytes msg) async {
  final kp = await _ed25519.newKeyPairFromSeed(seed);
  final sig = await _ed25519.sign(msg, keyPair: kp);
  return Uint8List.fromList(sig.bytes);
}

Future<bool> verify(Bytes pub, Bytes msg, Bytes sig) async {
  if (pub.length != 32 || sig.length != 64) return false;
  try {
    return await _ed25519.verify(
      msg,
      signature: cg.Signature(sig, publicKey: cg.SimplePublicKey(pub, type: cg.KeyPairType.ed25519)),
    );
  } catch (_) {
    return false;
  }
}

/* ---------------- AEAD：AES-256-GCM ---------------- */

final _aes = cg.AesGcm.with256bits();

/// 消息链路用：密钥一次性，nonce 由密钥确定派生（与 Web 端一致）
Bytes aeadNonce(Bytes key) => Uint8List.sublistView(sha256(concat([key, utf8Bytes('aead-nonce')])), 0, 12);

Future<Bytes> _seal(Bytes key, Bytes nonce, Bytes pt, Bytes aad) async {
  final box = await _aes.encrypt(pt, secretKey: cg.SecretKey(key), nonce: nonce, aad: aad);
  return concat([Uint8List.fromList(box.cipherText), Uint8List.fromList(box.mac.bytes)]);
}

Future<Bytes> _open(Bytes key, Bytes nonce, Bytes ct, Bytes aad) async {
  if (ct.length < 16) throw CryptoException('密文长度异常');
  final body = Uint8List.sublistView(ct, 0, ct.length - 16);
  final tag = Uint8List.sublistView(ct, ct.length - 16);
  try {
    final pt = await _aes.decrypt(
      cg.SecretBox(body, nonce: nonce, mac: cg.Mac(tag)),
      secretKey: cg.SecretKey(key),
      aad: aad,
    );
    return Uint8List.fromList(pt);
  } on cg.SecretBoxAuthenticationError {
    throw CryptoException('解密失败（认证标签不符）');
  }
}

Future<Bytes> aeadSeal(Bytes key, Bytes pt, Bytes aad) => _seal(key, aeadNonce(key), pt, aad);

Future<Bytes> aeadOpen(Bytes key, Bytes ct, Bytes aad) => _open(key, aeadNonce(key), ct, aad);

/// 随机 nonce 版本（同一密钥会加密多次的场景，例如漫游私钥封装）。输出 = nonce(12) || 密文
Future<Bytes> aeadSealRandom(Bytes key, Bytes pt, Bytes aad) async {
  final nonce = randomBytes(12);
  return concat([nonce, await _seal(key, nonce, pt, aad)]);
}

Future<Bytes> aeadOpenRandom(Bytes key, Bytes packed, Bytes aad) {
  if (packed.length < 13) throw CryptoException('密文长度异常');
  return _open(key, Uint8List.sublistView(packed, 0, 12), Uint8List.sublistView(packed, 12), aad);
}

/* ---------------- 口令 KDF ---------------- */

Future<Bytes> pbkdf2(String password, Bytes salt, [int iterations = 200000]) async {
  final kdf = cg.Pbkdf2(macAlgorithm: cg.Hmac.sha256(), iterations: iterations, bits: 256);
  final k = await kdf.deriveKey(secretKey: cg.SecretKey(utf8Bytes(password)), nonce: salt);
  return Uint8List.fromList(await k.extractBytes());
}
