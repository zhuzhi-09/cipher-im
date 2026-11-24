// 联测：起一个真实的本地服务端（../../dist/server.mjs），用 Dart 客户端走完整流程
// 先在仓库根目录跑 bash scripts/build.sh；没有构建产物时这组测试跳过
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cipher_core/cipher_core.dart';
import 'package:test/test.dart';

const invite = 'dart-test-code';

late Process server;
late Uri base;
late Directory dataDir;
final serverLog = StringBuffer();

Future<int> freePort() async {
  final s = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final p = s.port;
  await s.close();
  return p;
}

/// 一个测试用户：设备密钥 + 加密客户端 + 连接
class Who {
  Who(this.name);
  final String name;
  late String device;
  late String token;
  late CryptoClient crypto;
  late Link link;
  final inbox = <Map<String, dynamic>>[];
  late Api api;

  Future<void> register() async {
    api = Api(base);
    device = 'd-$name';
    final keys = await createDeviceKeys(5);
    final r = await api.register(
      username: name,
      displayName: '测试 $name',
      password: 'pw-$name-123',
      bundle: registrationBundle(keys, device),
      invite: invite,
    );
    token = r.token;
    crypto = CryptoClient(name, device, keys);
  }

  /// 连上并等到这次连接的 ready；返回 ready 在 inbox 里的位置（之后的报文都属于这次连接）
  Future<int> connect() async {
    link = Link(base: base, token: token, deviceId: device);
    link.messages.listen(inbox.add);
    final n = inbox.length;
    await link.connect();
    final ready = await waitFor((m) => m['t'] == 'ready', after: n);
    return inbox.indexOf(ready);
  }

  /// 等一条满足条件的报文（已经收到的也算）
  Future<Map<String, dynamic>> waitFor(bool Function(Map<String, dynamic>) pred, {int after = 0}) async {
    for (var i = 0; i < 100; i++) {
      final hit = inbox.skip(after).where(pred).firstOrNull;
      if (hit != null) return hit;
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    throw TimeoutException('$name 没等到报文；收到过：${inbox.map((m) => m['t']).toList()}');
  }

  Future<Map<String, PublicBundle>> bundlesOf(String user) async {
    final n = inbox.length;
    link.send({'t': 'bundle', 'user': user});
    final m = await waitFor((m) => m['t'] == 'bundles' && m['user'] == user, after: n);
    return {
      for (final b in m['bundles'] as List)
        '$user/${b['device']}': PublicBundle.fromJson(b['bundle'] as Map<String, dynamic>),
    };
  }

  /// 给 peer 的所有设备发一条文本（走真实的 send 指令）
  Future<int> sendText(int conv, Who peer, String text) async {
    final bundles = await bundlesOf(peer.name);
    final targets = [for (final k in bundles.keys) (user: peer.name, device: k.split('/')[1])];
    final r = await crypto.encryptToDevices(targets, bundles, {'t': 'text', 'text': text});
    final clientId = 'c${DateTime.now().microsecondsSinceEpoch}';
    final n = inbox.length;
    link.send({'t': 'send', 'conv': conv, 'bodies': r.bodies.map((b) => b.toJson()).toList(), 'clientId': clientId});
    final sent = await waitFor((m) => m['t'] == 'sent' && m['clientId'] == clientId, after: n);
    return sent['id'] as int;
  }

  Future<String> receiveText({required int after}) async {
    final m = await waitFor((m) => m['t'] == 'msg', after: after);
    final msg = m['msg'] as Map<String, dynamic>;
    final from = msg['from'] as Map<String, dynamic>;
    final r = await crypto.decryptFrom(from['user'], from['device'], WireBody.fromJson(msg['body']));
    return r.payload['text'] as String;
  }
}

void main() {
  final serverJs = File('../../dist/server.mjs');
  final skip = serverJs.existsSync() ? null : '缺少 dist/server.mjs，先在仓库根目录跑 bash scripts/build.sh';

  group('服务器地址', () {
    test('规范化', () {
      expect(normalizeServerAddress('im.example.com').toString(), 'https://im.example.com');
      expect(normalizeServerAddress(' https://im.example.com/ ').toString(), 'https://im.example.com');
      expect(normalizeServerAddress('https://im.example.com:8443').toString(), 'https://im.example.com:8443');
      expect(normalizeServerAddress('http://localhost:8099').toString(), 'http://localhost:8099');
      expect(normalizeServerAddress('http://127.0.0.1:8099').toString(), 'http://127.0.0.1:8099');
    });
    test('拒绝不安全或多余的部分', () {
      for (final bad in [
        '',
        'http://im.example.com',
        'ftp://im.example.com',
        'https://im.example.com/chat',
        'https://im.example.com/?x=1',
        'https://user:pw@im.example.com',
        'http://192.168.1.5:8099',
      ]) {
        expect(() => normalizeServerAddress(bad), throwsA(isA<ServerAddressException>()), reason: bad);
      }
    });
  });

  group('联测', skip: skip, () {
    setUpAll(() async {
      dataDir = await Directory.systemTemp.createTemp('cim-dart-');
      final port = await freePort();
      base = Uri.parse('http://127.0.0.1:$port');
      server = await Process.start(
        'node',
        ['--experimental-sqlite', serverJs.absolute.path],
        environment: {
          'PORT': '$port',
          'DATA_DIR': dataDir.path,
          'WEB_DIR': dataDir.path,
          'INVITE_CODE': invite,
          'REGISTER_PER_HOUR': '50',
          'LOGIN_PER_MIN': '50',
          'PUSH_DRY_RUN': '1',
        },
      );
      server.stdout.transform(utf8.decoder).listen(serverLog.write);
      server.stderr.transform(utf8.decoder).listen(serverLog.write);
      for (var i = 0; i < 100; i++) {
        try {
          await checkServer(base);
          return;
        } catch (_) {
          await Future<void>.delayed(const Duration(milliseconds: 150));
        }
      }
      fail('服务端没起来：$serverLog');
    });

    tearDownAll(() async {
      server.kill();
      await server.exitCode.timeout(const Duration(seconds: 5), onTimeout: () => -1);
      try {
        await dataDir.delete(recursive: true);
      } catch (_) {}
    });

    test('健康检查认出 Cipher IM 服务器', () async {
      final info = await checkServer(base);
      expect(info.protocol, 1);
      expect(info.retentionDays, 14);
    });

    test('认不出的服务器被拒绝', () async {
      final fake = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      var reply = '{"ok":true}';
      fake.listen(
        (r) => r.response
          ..headers.contentType = ContentType.json
          ..write(reply)
          ..close(),
      );
      final u = Uri.parse('http://127.0.0.1:${fake.port}');
      await expectLater(checkServer(u), throwsA(predicate((e) => '$e'.contains('不是 Cipher IM'))));
      reply = '{"ok":true,"service":"cipher-im","protocol":99}';
      await expectLater(checkServer(u), throwsA(predicate((e) => '$e'.contains('不兼容'))));
      reply = '<html>502</html>';
      await expectLater(checkServer(u), throwsA(predicate((e) => '$e'.contains('不是 Cipher IM'))));
      await fake.close(force: true);
    });

    test('注册、建会话、加密收发、离线补收、换设备', () async {
      final alice = Who('alice');
      final bob = Who('bob');
      await alice.register();
      await bob.register();
      await expectLater(
        Api(base).register(
          username: 'eve',
          displayName: 'e',
          password: 'pw-123456',
          bundle: registrationBundle(await createDeviceKeys(1), 'd-eve'),
          invite: 'wrong',
        ),
        throwsA(isA<ApiException>().having((e) => e.status, 'status', 403)),
      );

      await alice.connect();
      await bob.connect();

      // 建直聊
      var n = alice.inbox.length;
      alice.link.send({'t': 'createDirect', 'peer': 'bob'});
      final convs = await alice.waitFor((m) => m['t'] == 'convs' && (m['convs'] as List).isNotEmpty, after: n);
      final conv = (convs['convs'] as List).first['id'] as int;

      // alice → bob（首条是预密钥信封）
      n = bob.inbox.length;
      await alice.sendText(conv, bob, '你好 Bob，来自 Dart');
      expect(await bob.receiveText(after: n), '你好 Bob，来自 Dart');

      // bob → alice
      n = alice.inbox.length;
      await bob.sendText(conv, alice, '收到，Dart 也回你');
      expect(await alice.receiveText(after: n), '收到，Dart 也回你');

      // bob 断线期间 alice 发的消息，重连后从离线队列补收
      await bob.link.close();
      await alice.sendText(conv, bob, '你离线时发的');
      final pending = await bob.connect(); // 新连接，inbox 继续累积
      expect(await bob.receiveText(after: pending), '你离线时发的');

      // bob 换一台新设备：登录 → 登记新设备密钥 → 新令牌
      final bob2 = Who('bob');
      bob2.api = Api(base);
      final login = await bob2.api.login('bob', 'pw-bob-123');
      final keys2 = await createDeviceKeys(5);
      final dev = await bob2.api.addDevice(login.token, registrationBundle(keys2, 'd-bob-2'));
      bob2
        ..device = 'd-bob-2'
        ..token = dev.token
        ..crypto = CryptoClient('bob', 'd-bob-2', keys2);
      expect(dev.opkStock, 5);
      await bob2.connect();

      // alice 再发：bob 的两台设备各收一份
      final nb = bob.inbox.length;
      final nb2 = bob2.inbox.length;
      await alice.sendText(conv, bob, '两台设备都该收到');
      expect(await bob.receiveText(after: nb), '两台设备都该收到');
      expect(await bob2.receiveText(after: nb2), '两台设备都该收到');

      await alice.link.dispose();
      await bob.link.dispose();
      await bob2.link.dispose();
    });

    test('令牌无效 → 致命错误，不再重连', () async {
      final link = Link(base: base, token: 'not-a-token', deviceId: 'd-x');
      final fatal = link.fatal.first.timeout(const Duration(seconds: 5));
      await link.connect();
      expect('${await fatal}', contains('令牌'));
      await Future<void>.delayed(const Duration(milliseconds: 1500));
      expect(link.status, LinkStatus.offline);
      await link.dispose();
    });

    test('文件密文上传下载', () async {
      final carol = Who('carol');
      await carol.register();
      final key = Uint8List.fromList(List.generate(32, (i) => i));
      final data = utf8Bytes('一份要加密上传的文件内容' * 100);
      final ct = await aeadSeal(key, data, utf8Bytes('blob'));
      final up = await carol.api.putBlob(carol.token, ct, 'text/plain');
      expect(up.size, ct.length);
      final down = await carol.api.getBlob(carol.token, up.id);
      expect(await aeadOpen(key, down, utf8Bytes('blob')), data);
      await expectLater(carol.api.getBlob('bad-token', up.id), throwsA(isA<ApiException>()));
    });

    test('漫游密钥：上传封装后的私钥，新设备用口令解封', () async {
      final dave = Who('dave');
      await dave.register();
      final roam = await createRoamKeys();
      final wrapped = await wrapRoamPriv('pw-dave-123', roam.priv);
      await dave.api.roamInit(dave.token, pub: toB64(roam.pub), salt: wrapped.salt, sealed: wrapped.sealed);

      final k = await dave.api.roamKey(dave.token);
      expect(k.pub, toB64(roam.pub));
      expect(await unwrapRoamPriv('pw-dave-123', k.salt, k.sealed), roam.priv);
      expect(await dave.api.roamPub(dave.token, 'dave'), toB64(roam.pub));
      final devices = await dave.api.roamDevices(dave.token);
      expect(devices.map((d) => d.device), contains('d-dave'));
    });
  });
}
