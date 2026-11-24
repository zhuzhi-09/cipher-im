// 联测：起一个真实的本地服务端，几个原生客户端（ChatService）互发单聊、群聊消息
// 先在仓库根目录跑 bash scripts/build.sh；没有 dist/server.mjs 时整组跳过
// 服务端脚本也可以用环境变量 CIPHER_SERVER_JS 指定
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cipher_core/cipher_core.dart';
import 'package:cipherim/service.dart';
import 'package:cipherim/vault.dart';
import 'package:flutter_test/flutter_test.dart';

const invite = 'flutter-test-code';

late Process server;
late Uri base;
late Directory tmp;
final serverLog = StringBuffer();

Future<int> freePort() async {
  final s = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final p = s.port;
  await s.close();
  return p;
}

Future<void> until(bool Function() ok, String what) async {
  for (var i = 0; i < 150; i++) {
    if (ok()) return;
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
  throw TimeoutException('等不到：$what');
}

Future<ChatService> signUp(String name) async {
  final v = await Account.register(
    server: base,
    username: name,
    displayName: '测试$name',
    password: 'pw-$name-123',
    invite: invite,
  );
  final store = VaultStore.forTest(File('${tmp.path}/$name.bin'), randomBytes(32));
  final s = ChatService(v, store)..start();
  await until(() => s.status == LinkStatus.online, '$name 上线');
  return s;
}

List<String> texts(ChatService s, int conv) => [
  for (final m in s.msgs[conv] ?? const <LocalMsg>[])
    if (m.type == 'text') m.payload['text'] as String,
];

void main() {
  final serverJs = File(Platform.environment['CIPHER_SERVER_JS'] ?? '../../dist/server.mjs');
  final skip = serverJs.existsSync() ? null : '缺少 dist/server.mjs';

  setUpAll(() async {
    if (skip != null) return;
    tmp = await Directory.systemTemp.createTemp('cim-flutter-');
    final port = await freePort();
    base = Uri.parse('http://127.0.0.1:$port');
    server = await Process.start(
      'node',
      ['--experimental-sqlite', serverJs.absolute.path],
      environment: {
        'PORT': '$port',
        'DATA_DIR': tmp.path,
        'WEB_DIR': tmp.path,
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
    if (skip != null) return;
    server.kill();
    await server.exitCode.timeout(const Duration(seconds: 5), onTimeout: () => -1);
    try {
      await tmp.delete(recursive: true);
    } catch (_) {}
  });

  test('单聊、群聊、离线补收、通知、本机密钥库', skip: skip, () async {
    final alice = await signUp('alice');
    final bob = await signUp('bob');
    final carol = await signUp('carol');

    final notified = <String>[];
    bob.onNotify = (c, m, sender) => notified.add('$sender:${m.payload['text']}');
    bob.setVisible(false);

    // 单聊：alice 建会话、发消息；bob 在后台，应弹通知、计未读
    final conv = (await alice.createDirect('bob'))!;
    alice.openConv(conv);
    await alice.sendText(conv, '你好 bob');
    await until(() => texts(bob, conv).contains('你好 bob'), 'bob 收到');
    expect(notified, ['测试alice:你好 bob']);
    await until(() => bob.convById(conv)?.unread == 1, 'bob 未读 1');
    await until(() => alice.msgs[conv]!.every((m) => m.id > 0 && !m.sending), 'alice 的消息被确认');

    // bob 回到前台、打开会话：未读清零，alice 收到已读回执
    bob.setVisible(true);
    bob.openConv(conv);
    expect(bob.convById(conv)!.unread, 0);
    await until(() => (alice.receipts[conv]?['bob'] ?? 0) >= alice.msgs[conv]!.last.id, 'alice 收到已读');
    await bob.sendText(conv, '收到');
    await until(() => texts(alice, conv).contains('收到'), 'alice 收到回复');

    // 群聊：三个人，每人发一条，其他两人都能解开
    final g = (await alice.createGroup('测试群', ['bob', 'carol']))!;
    await until(() => bob.convById(g) != null && carol.convById(g) != null, '大家看到群');
    await alice.sendText(g, 'alice 在群里说话');
    await bob.sendText(g, 'bob 也说一句');
    await carol.sendText(g, 'carol 来了');
    for (final s in [alice, bob, carol]) {
      await until(
        () => texts(s, g).toSet().containsAll(['alice 在群里说话', 'bob 也说一句', 'carol 来了']),
        '${s.vault.username} 看到群里三条',
      );
    }

    // carol 离线期间 bob 私聊她，重连后补收
    final c2 = (await bob.createDirect('carol'))!;
    await until(() => carol.convById(c2) != null, 'carol 看到新会话');
    await carol.link.close();
    await bob.sendText(c2, '你离线时发的');
    await carol.link.connect();
    await until(() => texts(carol, c2).contains('你离线时发的'), 'carol 补收');

    // 本机密钥库：存盘再读回，会话状态还在，能继续解密新消息
    final store = VaultStore.forTest(File('${tmp.path}/bob2.bin'), randomBytes(32));
    await store.save(bob.vault);
    final reloaded = (await store.load())!;
    expect(reloaded.username, 'bob');
    expect(reloaded.client.sessions.has('alice', alice.vault.deviceId), isTrue);
    expect(texts(ChatService(reloaded, store), conv), containsAll(['你好 bob', '收到']));

    for (final s in [alice, bob, carol]) {
      await s.shutdown();
    }
  });
}
