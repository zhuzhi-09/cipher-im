import 'package:cipherim/connections.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const a = 'https://im.example.com/';
  const b = 'https://chat.example.org/';

  test('默认不记密码，最近用过的排前面', () async {
    final box = MemoryBox();
    final store = ConnectionStore(box);
    await store.remember(server: a, username: 'alice', displayName: 'Alice', now: DateTime(2026, 1, 1));
    await store.remember(server: b, username: 'bob', now: DateTime(2026, 1, 2));

    final items = await store.list();
    expect(items.map((c) => c.username), ['bob', 'alice']);
    expect(items.every((c) => !c.hasPassword), isTrue);
    expect(box.data.values.single, isNot(contains('password')));
    expect(items.last.host, 'im.example.com');
    expect(items.last.displayName, 'Alice');
  });

  test('勾了才记密码；再登录不勾就把旧密码删掉；同一账号不重复', () async {
    final box = MemoryBox();
    final store = ConnectionStore(box);
    await store.remember(server: a, username: 'alice', password: 'secret1', now: DateTime(2026, 1, 1));
    var items = await store.list();
    expect(items.single.password, 'secret1');

    // 用户名大小写不同也算同一个
    await store.remember(server: a, username: 'Alice', now: DateTime(2026, 1, 3));
    items = await store.list();
    expect(items, hasLength(1));
    expect(items.single.hasPassword, isFalse);
    expect(box.data.values.single, isNot(contains('secret1')));

    // 同一用户名在别的服务器是另一条
    await store.remember(server: b, username: 'alice', now: DateTime(2026, 1, 4));
    expect(await store.list(), hasLength(2));
  });

  test('删除和条数上限', () async {
    final box = MemoryBox();
    final store = ConnectionStore(box);
    for (var i = 0; i < ConnectionStore.maxEntries + 3; i++) {
      await store.remember(server: a, username: 'user$i', now: DateTime(2026, 1, 1, 0, i));
    }
    var items = await store.list();
    expect(items, hasLength(ConnectionStore.maxEntries));
    expect(items.first.username, 'user${ConnectionStore.maxEntries + 2}');

    for (final c in items) {
      await store.forget(c.server, c.username);
    }
    expect(await store.list(), isEmpty);
    expect(box.data, isEmpty);
  });

  test('存的内容坏了就当没有', () async {
    final box = MemoryBox()..data['cipherim.connections'] = '{not json';
    expect(await ConnectionStore(box).list(), isEmpty);
  });
}
