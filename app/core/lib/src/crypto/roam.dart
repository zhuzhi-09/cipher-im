/// 跨设备漫游密钥（对应 Web 端 roam.ts）
///  - 历史副本：用收件账号的漫游公钥 + 临时密钥 ECDH 封装
///  - 漫游私钥：用账号口令 PBKDF2(20 万次) 得到 KEK，AES-GCM（随机 nonce）封好存服务端
library;

import 'dart:typed_data';

import 'primitives.dart';
import 'random.dart';

const _info = 'CipherIM-roam-v1';
final _aad = utf8Bytes('CipherIM-roam-msg');
final _keyAad = utf8Bytes('CipherIM-roam-key-v1');

Future<KeyPair> createRoamKeys() => genDh();

// salt 用临时公钥（双方都知道），两端才能派生出同一把密钥
Future<Bytes> _deriveRoamKey(Bytes priv, Bytes peerPub, Bytes ephPub) async {
  final shared = await dh(priv, peerPub);
  if (bytesEqual(shared, Uint8List(32))) throw CryptoException('漫游密钥协商失败');
  return hkdf(shared, ephPub, _info, 32);
}

Future<({String eph, String ct})> sealForRoam(Bytes roamPub, Bytes plaintext) async {
  final eph = await genDh();
  final key = await _deriveRoamKey(eph.priv, roamPub, eph.pub);
  final ct = await aeadSeal(key, plaintext, concat([_aad, eph.pub]));
  return (eph: toB64(eph.pub), ct: toB64(ct));
}

Future<Bytes> openRoam(Bytes roamPriv, String ephB64, String ctB64) async {
  final ephPub = fromB64(ephB64);
  final key = await _deriveRoamKey(roamPriv, ephPub, ephPub);
  return aeadOpen(key, fromB64(ctB64), concat([_aad, ephPub]));
}

Future<({String salt, String sealed})> wrapRoamPriv(String password, Bytes priv) async {
  final salt = randomBytes(32);
  final kek = await pbkdf2(password, salt, 200000);
  final sealed = await aeadSealRandom(kek, priv, _keyAad);
  return (salt: toB64(salt), sealed: toB64(sealed));
}

Future<Bytes> unwrapRoamPriv(String password, String saltB64, String sealedB64) async {
  final kek = await pbkdf2(password, fromB64(saltB64), 200000);
  try {
    return await aeadOpenRandom(kek, fromB64(sealedB64), _keyAad);
  } catch (_) {
    throw CryptoException('口令无法解封漫游密钥');
  }
}
