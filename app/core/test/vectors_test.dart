// 用 spec/vectors/crypto-v1.json（由 Web 端 TS 实现导出）逐字节核对 Dart 实现
import 'dart:convert';
import 'dart:io';

import 'package:cipher_core/src/crypto/client.dart';
import 'package:cipher_core/src/crypto/fingerprint.dart';
import 'package:cipher_core/src/crypto/identity.dart';
import 'package:cipher_core/src/crypto/primitives.dart';
import 'package:cipher_core/src/crypto/random.dart';
import 'package:cipher_core/src/crypto/roam.dart';
import 'package:cipher_core/src/crypto/x3dh.dart';
import 'package:cipher_core/src/protocol/wire.dart';
import 'package:test/test.dart';

late Map<String, dynamic> v;

void useRng(String label) => cryptoRandom = TestRandomSource(label);

void main() {
  setUpAll(() {
    final f = File('../../spec/vectors/crypto-v1.json');
    v = jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
  });
  tearDownAll(() => cryptoRandom = SecureRandomSource());

  group('primitives', () {
    Map<String, dynamic> p() => v['primitives'] as Map<String, dynamic>;
    List<dynamic> sec(String k) => p()[k] as List<dynamic>;

    test('sha256', () {
      for (final c in sec('sha256')) {
        expect(toHex(sha256(fromHex(c['in']))), c['out']);
      }
    });
    test('hkdf', () {
      for (final c in sec('hkdf')) {
        expect(toHex(hkdf(fromHex(c['ikm']), fromHex(c['salt']), c['info'], c['len'])), c['out']);
      }
    });
    test('hmac', () {
      for (final c in sec('hmac')) {
        expect(toHex(hmacSha256(fromHex(c['key']), fromHex(c['data']))), c['out']);
      }
    });
    test('x25519', () async {
      for (final c in sec('x25519')) {
        expect(toHex(await dhPubFromPriv(fromHex(c['priv']))), c['pub']);
        expect(toHex(await dh(fromHex(c['priv']), fromHex(c['peerPub']))), c['shared']);
      }
    });
    test('ed25519', () async {
      for (final c in sec('ed25519')) {
        expect(toHex(await sigPub(fromHex(c['seed']))), c['pub']);
        expect(toHex(await sign(fromHex(c['seed']), fromHex(c['msg']))), c['sig']);
        expect(await verify(fromHex(c['pub']), fromHex(c['msg']), fromHex(c['sig'])), isTrue);
        final bad = fromHex(c['sig'])..[0] ^= 1;
        expect(await verify(fromHex(c['pub']), fromHex(c['msg']), bad), isFalse);
      }
    });
    test('aead（确定性 nonce）', () async {
      for (final c in sec('aead')) {
        final key = fromHex(c['key']);
        expect(toHex(aeadNonce(key)), c['nonce']);
        expect(toHex(await aeadSeal(key, fromHex(c['pt']), fromHex(c['aad']))), c['ct']);
        expect(toHex(await aeadOpen(key, fromHex(c['ct']), fromHex(c['aad']))), c['pt']);
        final tampered = fromHex(c['ct'])..[0] ^= 1;
        expect(() => aeadOpen(key, tampered, fromHex(c['aad'])), throwsA(isA<CryptoException>()));
      }
    });
    test('aead（随机 nonce）', () async {
      for (final c in sec('aeadRandom')) {
        useRng(c['rng']);
        expect(toHex(await aeadSealRandom(fromHex(c['key']), fromHex(c['pt']), fromHex(c['aad']))), c['packed']);
        expect(toHex(await aeadOpenRandom(fromHex(c['key']), fromHex(c['packed']), fromHex(c['aad']))), c['pt']);
      }
    });
    test('pbkdf2', () async {
      for (final c in sec('pbkdf2')) {
        expect(toHex(await pbkdf2(c['password'], fromHex(c['salt']), c['iterations'])), c['out']);
      }
    }, timeout: const Timeout(Duration(minutes: 2)));
    test('base64', () {
      for (final c in sec('base64')) {
        expect(toB64(fromHex(c['hex'])), c['b64']);
        expect(toHex(fromB64(c['b64'])), c['hex']);
      }
    });
  });

  group('identity', () {
    test('设备密钥（同一随机数流生成出同一套密钥）', () async {
      for (final c in v['identity'] as List) {
        useRng(c['rng']);
        if (c['identityOnly'] != null) {
          expect((await createIdentity()).toJson(), c['identityOnly']);
        } else {
          expect((await createDeviceKeys(c['opkCount'])).toJson(), c['keys']);
        }
      }
      for (final e in (v['parties'] as Map<String, dynamic>).entries) {
        useRng('keys-${e.key}');
        final keys = e.value['keys'];
        expect((await createDeviceKeys((keys['opks'] as List).length)).toJson(), keys, reason: e.key);
      }
    });
  });

  group('fingerprint', () {
    test('安全码与短指纹', () {
      for (final c in v['fingerprint']['safety'] as List) {
        expect(safetyNumber(fromB64(c['a']), fromB64(c['b'])), c['digits']);
        expect(safetyNumber(fromB64(c['b']), fromB64(c['a'])), c['digits']);
      }
      for (final c in v['fingerprint']['short'] as List) {
        expect(shortFingerprint(fromB64(c['ikSigPub'])), c['out']);
      }
    });
  });

  group('x3dh', () {
    test('有 OPK / 无 OPK / 签名被篡改', () async {
      for (final c in v['x3dh'] as List) {
        final alice = DeviceKeys.fromJson(v['parties'][c['initiator']]['keys']);
        useRng(c['rng']);
        Object out;
        try {
          final r = await x3dhInitiate(alice.identity, PublicBundle.fromJson(c['bundle']));
          out = {
            'sk': toB64(r.sk),
            'ad': toB64(r.ad),
            'ekPriv': toB64(r.ekPriv),
            'ekPub': toB64(r.ekPub),
            'spkId': r.spkId,
            'opkId': r.opkId,
          };
        } on CryptoException {
          out = {'error': true};
        }
        expect(out, c['out'], reason: c['name']);
      }
    });
  });

  group('transcript', () {
    test('会话脚本逐步回放', () async {
      final clients = <String, CryptoClient>{};
      (v['parties'] as Map<String, dynamic>).forEach((name, p) {
        clients[name] = CryptoClient(p['user'], p['device'], DeviceKeys.fromJson(p['keys']));
      });
      List<Target> targets(List t) => [for (final x in t) (user: x['user'] as String, device: x['device'] as String)];
      Map<String, PublicBundle> bundles(Map b) => b.map((k, x) => MapEntry(k as String, PublicBundle.fromJson(x)));
      Map<String, dynamic> multi(({List<EncryptedFor> bodies, List<Target> skipped}) r) => {
        'bodies': r.bodies.map((b) => b.toJson()).toList(),
        'skipped': r.skipped.map((t) => {'user': t.user, 'device': t.device}).toList(),
      };

      final steps = v['transcript'] as List;
      for (var i = 0; i < steps.length; i++) {
        final s = steps[i] as Map<String, dynamic>;
        useRng(s['rng']);
        final c = clients[s['actor']]!;
        Object out;
        try {
          out = switch (s['op']) {
            'encrypt' => multi(
              await c.encryptToDevices(targets(s['targets']), bundles(s['bundles']), jsonDecode(s['payloadJson'])),
            ),
            'decrypt' => await () async {
              final r = await c.decryptFrom(s['from']['user'], s['from']['device'], WireBody.fromJson(s['body']));
              return {'payloadJson': jsonEncode(r.payload), 'created': r.created, 'usedOpk': r.usedOpk};
            }(),
            'distributeSenderKey' => multi(
              await c.buildSenderKeyDistribution(s['groupId'], targets(s['targets']), bundles(s['bundles'])),
            ),
            'encryptGroup' => {'body': (await c.encryptGroup(s['groupId'], jsonDecode(s['payloadJson']))).toJson()},
            'decryptGroup' => {'payloadJson': jsonEncode(await c.decryptGroup(GroupBody.fromJson(s['body'])))},
            'rotateSenderKey' => () {
              c.rotateOwnSenderKey(s['groupId']);
              return <String, dynamic>{};
            }(),
            final op => throw StateError('未知操作 $op'),
          };
        } on CryptoException {
          out = {'error': true};
        }
        expect(out, s['expect'], reason: 'step $i ${s['op']}：${s['note']}');
      }
    });
  });

  group('roam', () {
    test('漫游密钥、历史副本、口令封装', () async {
      final r = v['roam'];
      useRng(r['rng']);
      final kp = await createRoamKeys();
      expect({'priv': toB64(kp.priv), 'pub': toB64(kp.pub)}, {'priv': r['priv'], 'pub': r['pub']});
      for (final s in r['seals'] as List) {
        useRng(s['rng']);
        final sealed = await sealForRoam(fromB64(r['pub']), utf8Bytes(s['plaintext']));
        expect({'eph': sealed.eph, 'ct': sealed.ct}, {'eph': s['eph'], 'ct': s['ct']});
        expect(fromUtf8(await openRoam(fromB64(r['priv']), s['eph'], s['ct'])), s['plaintext']);
      }
      final w = r['wrap'];
      useRng(w['rng']);
      final wrapped = await wrapRoamPriv(w['password'], fromB64(r['priv']));
      expect({'salt': wrapped.salt, 'sealed': wrapped.sealed}, {'salt': w['salt'], 'sealed': w['sealed']});
      expect(toB64(await unwrapRoamPriv(w['password'], w['salt'], w['sealed'])), r['priv']);
      expect(() => unwrapRoamPriv('错的口令', w['salt'], w['sealed']), throwsA(isA<CryptoException>()));
    });
  });

  group('blob', () {
    test('文件密文', () async {
      for (final b in v['blob'] as List) {
        expect(toB64(await aeadSeal(fromB64(b['key']), fromB64(b['data']), utf8Bytes('blob'))), b['ct']);
        expect(toB64(await aeadOpen(fromB64(b['key']), fromB64(b['ct']), utf8Bytes('blob'))), b['data']);
      }
    });
  });
}
