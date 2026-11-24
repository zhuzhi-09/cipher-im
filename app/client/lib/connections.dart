/// 连接记忆：记住登录过的「服务器 + 用户名」，下次在登录页点一下就能填好
///
/// 退出账号不会清掉这里（这正是它的用途），要忘掉就在登录页上删。
/// 密码默认不记；只有用户勾了「记住密码」才存，和其他内容一起放在系统密钥库里
/// （Windows 凭据保护 DPAPI / 安卓 Keystore），不写进普通文件。
library;

import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class SavedConnection {
  SavedConnection({
    required this.server,
    required this.username,
    this.displayName = '',
    this.password,
    required this.lastUsed,
  });

  /// 服务器根地址，例如 https://im.example.com/
  final String server;
  final String username;
  final String displayName;

  /// 只有勾了「记住密码」才有
  final String? password;
  final DateTime lastUsed;

  bool get hasPassword => password != null;
  String get host => Uri.tryParse(server)?.host ?? server;

  bool sameAs(String server, String username) =>
      this.server == server && this.username.toLowerCase() == username.toLowerCase();

  Map<String, dynamic> toJson() => {
    'server': server,
    'username': username,
    if (displayName.isNotEmpty) 'displayName': displayName,
    if (password != null) 'password': password,
    'lastUsed': lastUsed.millisecondsSinceEpoch,
  };

  static SavedConnection fromJson(Map<String, dynamic> j) => SavedConnection(
    server: j['server'] as String,
    username: j['username'] as String,
    displayName: (j['displayName'] as String?) ?? '',
    password: j['password'] as String?,
    lastUsed: DateTime.fromMillisecondsSinceEpoch((j['lastUsed'] as num?)?.toInt() ?? 0),
  );
}

/// 存储后端：正式运行用系统密钥库，测试用内存
abstract class SecretBox {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class _SecureBox implements SecretBox {
  const _SecureBox();
  static const _s = FlutterSecureStorage();
  @override
  Future<String?> read(String key) => _s.read(key: key);
  @override
  Future<void> write(String key, String value) => _s.write(key: key, value: value);
  @override
  Future<void> delete(String key) => _s.delete(key: key);
}

class MemoryBox implements SecretBox {
  final data = <String, String>{};
  @override
  Future<String?> read(String key) async => data[key];
  @override
  Future<void> write(String key, String value) async => data[key] = value;
  @override
  Future<void> delete(String key) async => data.remove(key);
}

class ConnectionStore {
  ConnectionStore([SecretBox? box]) : _box = box ?? const _SecureBox();

  static const _key = 'cipherim.connections';
  static const maxEntries = 10;

  final SecretBox _box;

  /// 最近用过的在前；读坏了就当没有，不影响登录
  Future<List<SavedConnection>> list() async {
    try {
      final s = await _box.read(_key);
      if (s == null) return [];
      final items = (jsonDecode(s) as List)
          .map((e) => SavedConnection.fromJson((e as Map).cast<String, dynamic>()))
          .toList();
      items.sort((a, b) => b.lastUsed.compareTo(a.lastUsed));
      return items;
    } catch (_) {
      return [];
    }
  }

  /// 登录 / 注册成功后调用。password 为 null 表示不记密码（之前记过的也会删掉）
  Future<void> remember({
    required String server,
    required String username,
    String displayName = '',
    String? password,
    DateTime? now,
  }) async {
    final items = (await list()).where((c) => !c.sameAs(server, username)).toList();
    items.insert(
      0,
      SavedConnection(
        server: server,
        username: username,
        displayName: displayName,
        password: password,
        lastUsed: now ?? DateTime.now(),
      ),
    );
    await _write(items.take(maxEntries).toList());
  }

  Future<void> forget(String server, String username) async {
    await _write((await list()).where((c) => !c.sameAs(server, username)).toList());
  }

  Future<void> _write(List<SavedConnection> items) async {
    if (items.isEmpty) {
      await _box.delete(_key);
    } else {
      await _box.write(_key, jsonEncode(items.map((c) => c.toJson()).toList()));
    }
  }
}
