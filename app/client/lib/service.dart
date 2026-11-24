/// 聊天服务：一个已登录账号的全部运行状态（对应 Web 端 App.tsx 里的逻辑部分）
///
/// 界面只读这里的状态、调这里的方法；所有加解密都在本机完成，服务端只经手密文。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cipher_core/cipher_core.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import 'media.dart';
import 'vault.dart';

class Member {
  Member(this.user, this.displayName, this.devices);
  final String user;
  final String displayName;
  final List<String> devices;
}

class DeviceSafety {
  DeviceSafety({required this.key, required this.device, required this.safety, required this.state});
  final String key;
  final String device;

  /// 60 位安全码；还没拿到对方身份公钥时为 null
  final String? safety;
  final TrustState state;
}

class Conv {
  Conv({
    required this.id,
    required this.kind,
    required this.name,
    required this.members,
    required this.lastAt,
    required this.unread,
  });

  final int id;
  final String kind; // direct / group
  final String name;
  final List<Member> members;
  int? lastAt;
  int unread;

  bool get isGroup => kind == 'group';

  factory Conv.fromJson(Map<String, dynamic> j) => Conv(
    id: (j['id'] as num).toInt(),
    kind: j['kind'] as String,
    name: j['name'] as String? ?? '',
    members: [
      for (final m in j['members'] as List)
        Member(m['user'] as String, m['displayName'] as String? ?? m['user'] as String, List<String>.from(m['devices'] as List)),
    ],
    lastAt: (j['lastAt'] as num?)?.toInt(),
    unread: (j['unread'] as num?)?.toInt() ?? 0,
  );
}

/// 第一次连服务器、注册、登录：成功后得到一个新的密钥库
class Account {
  /// 注册：本机先生成密钥，服务端只收到公钥包
  static Future<Vault> register({
    required Uri server,
    required String username,
    required String displayName,
    required String password,
    required String invite,
  }) async {
    final api = Api(server);
    try {
      final keys = await createDeviceKeys();
      final deviceId = generateDeviceId();
      final r = await api.register(
        username: username,
        displayName: displayName,
        password: password,
        bundle: registrationBundle(keys, deviceId),
        invite: invite,
      );
      final v = Vault(
        server: server.toString(),
        username: r.username,
        displayName: r.displayName,
        deviceId: r.device,
        token: r.token,
        client: CryptoClient(r.username, r.device, keys),
      );
      // 账号级漫游密钥：私钥用账号口令封起来上传，服务端没有口令解不开
      try {
        final roam = await createRoamKeys();
        final w = await wrapRoamPriv(password, roam.priv);
        await api.roamInit(r.token, pub: toB64(roam.pub), salt: w.salt, sealed: w.sealed);
        v.roamPub = toB64(roam.pub);
        v.roamPriv = toB64(roam.priv);
      } catch (_) {
        // 漫游没开起来只影响跨设备历史，不影响收发
      }
      return v;
    } finally {
      api.close();
    }
  }

  /// 已有账号在本机登录：登记一台新设备（新密钥），用口令解封漫游私钥
  static Future<Vault> login({required Uri server, required String username, required String password}) async {
    final api = Api(server);
    try {
      final l = await api.login(username, password);
      final keys = await createDeviceKeys();
      final dev = await api.addDevice(l.token, registrationBundle(keys, generateDeviceId()));
      final v = Vault(
        server: server.toString(),
        username: username,
        displayName: l.displayName,
        deviceId: dev.device,
        token: dev.token,
        client: CryptoClient(username, dev.device, keys),
      );
      try {
        final k = await api.roamKey(dev.token);
        v.roamPriv = toB64(await unwrapRoamPriv(password, k.salt, k.sealed));
        v.roamPub = k.pub;
      } catch (_) {
        // 账号还没启用漫游，或本机没有漫游权限
      }
      return v;
    } finally {
      api.close();
    }
  }
}

typedef NotifyCallback = void Function(Conv conv, LocalMsg msg, String senderName);

class ChatService extends ChangeNotifier {
  ChatService(this.vault, this._store) : api = Api(Uri.parse(vault.server)) {
    for (final e in vault.log.entries) {
      msgs[int.parse(e.key)] = e.value;
    }
  }

  final Vault vault;
  final VaultStore _store;
  final Api api;
  late final Link link = Link(base: Uri.parse(vault.server), token: vault.token, deviceId: vault.deviceId);

  List<Conv> convs = [];
  final Map<int, List<LocalMsg>> msgs = {};
  final Map<int, Map<String, int>> receipts = {};
  final Map<int, ({String user, DateTime at})> typing = {};
  LinkStatus status = LinkStatus.offline;
  int? activeId;
  bool appVisible = true;

  /// 令牌失效（比如本设备在别处被移除）：需要重新登录
  String? fatalError;

  /// 新消息通知（界面层决定怎么弹）
  NotifyCallback? onNotify;

  final _toasts = StreamController<String>.broadcast();
  Stream<String> get toasts => _toasts.stream;

  final _subs = <StreamSubscription>[];
  Future<void> _events = Future.value();
  Future<void> _crypto = Future.value();
  final _bundleWaiters = <String, Completer<Map<String, PublicBundle>>>{};
  Completer<List<({String username, String displayName})>>? _searchWaiter;
  final _pending = <String, LocalMsg>{};
  final _roamPubs = <String, String>{};
  final _roamPaging = <int, int>{};
  Timer? _saveTimer;
  int _tempSeq = 0;
  DateTime _typingSent = DateTime.fromMillisecondsSinceEpoch(0);

  /* ---------------- 生命周期 ---------------- */

  void start() {
    _subs.add(link.statuses.listen((s) {
      status = s;
      notifyListeners();
    }));
    _subs.add(link.messages.listen((m) => _events = _events.then((_) => _handle(m)).catchError((Object e) {
      debugPrint('处理报文出错：$e');
    })));
    _subs.add(link.fatal.listen((e) {
      fatalError = e.message;
      notifyListeners();
    }));
    link.setVisible(appVisible);
    link.connect();
  }

  /// 退出程序前：断开连接，把最新状态写盘
  Future<void> shutdown() async {
    await _stop();
    await _store.save(vault);
  }

  /// 退出账号：删掉本机密钥库（消息记录和会话状态都在里面）
  Future<void> logout() async {
    await _stop();
    await _store.wipe();
  }

  Future<void> _stop() async {
    _saveTimer?.cancel();
    for (final s in _subs) {
      await s.cancel();
    }
    _subs.clear();
    await link.dispose();
    api.close();
  }

  /// 加解密会改动棘轮状态：同一时间只让一个操作碰它
  Future<T> _locked<T>(Future<T> Function() f) {
    final c = Completer<T>();
    _crypto = _crypto.then((_) async {
      try {
        c.complete(await f());
      } catch (e, st) {
        c.completeError(e, st);
      }
    });
    return c.future;
  }

  void _persistSoon() {
    _saveTimer?.cancel();
    _saveTimer = Timer(const Duration(milliseconds: 250), () => _store.save(vault));
  }

  void _toast(String s) => _toasts.add(s);

  /// 设置项改了：存一下
  void savePrefs() => _persistSoon();

  /* ---------------- 查询 ---------------- */

  Conv? convById(int? id) {
    for (final c in convs) {
      if (c.id == id) return c;
    }
    return null;
  }

  Member? peerOf(Conv c) {
    for (final m in c.members) {
      if (m.user != vault.username) return m;
    }
    return null;
  }

  String titleOf(Conv c) => c.isGroup ? (c.name.isEmpty ? '群聊' : c.name) : (peerOf(c)?.displayName ?? '会话');

  String nameOf(String user) => user == vault.username ? vault.displayName : (vault.contacts[user] ?? user);

  LocalMsg? lastOf(int conv) {
    final l = msgs[conv];
    return (l == null || l.isEmpty) ? null : l.last;
  }

  int get totalUnread => convs.fold(0, (n, c) => n + c.unread);

  /// 有新消息的排前面
  List<Conv> get sortedConvs {
    int at(Conv c) => lastOf(c.id)?.createdAt ?? c.lastAt ?? 0;
    return [...convs]..sort((a, b) => at(b).compareTo(at(a)));
  }

  /* ---------------- 服务端报文 ---------------- */

  void _setConvs(List list) {
    convs = [for (final c in list) Conv.fromJson(Map<String, dynamic>.from(c as Map))];
    for (final c in convs) {
      for (final m in c.members) {
        vault.contacts[m.user] = m.displayName;
      }
      if (c.id == activeId && appVisible) c.unread = 0;
    }
  }

  Future<void> _handle(Map<String, dynamic> m) async {
    switch (m['t']) {
      case 'ready':
        _setConvs(m['convs'] as List);
        final a = activeId;
        if (a != null) _loadHistory(a);
        _persistSoon();
      case 'convs':
        _setConvs(m['convs'] as List);
      case 'msg':
        await _onMsg(Map<String, dynamic>.from(m['msg'] as Map));
      case 'sent':
        final p = _pending.remove(m['clientId']);
        if (p != null) {
          p
            ..id = (m['id'] as num).toInt()
            ..createdAt = (m['createdAt'] as num).toInt()
            ..sending = false;
          _sortConv(p.conv);
          _persistSoon();
        }
      case 'history':
        final conv = (m['conv'] as num).toInt();
        final have = {for (final x in msgs[conv] ?? const <LocalMsg>[]) x.id};
        for (final w in m['msgs'] as List) {
          final wm = Map<String, dynamic>.from(w as Map);
          if (have.contains((wm['id'] as num).toInt())) continue;
          final lm = await _decryptWire(wm);
          if (lm != null) _add(lm);
        }
        _persistSoon();
      case 'roamHistory':
        await _onRoam(m);
      case 'bundles':
        final user = m['user'] as String;
        final map = <String, PublicBundle>{
          for (final b in m['bundles'] as List)
            bundleKey(user, b['device'] as String): PublicBundle.fromJson(Map<String, dynamic>.from(b['bundle'] as Map)),
        };
        map.forEach((k, b) => _learnIdentity(k, b.ikSigPub));
        _bundleWaiters.remove(user)?.complete(map);
      case 'users':
        _searchWaiter?.complete([
          for (final u in m['users'] as List) (username: u['username'] as String, displayName: u['displayName'] as String),
        ]);
        _searchWaiter = null;
      case 'receipt':
        final conv = (m['conv'] as num).toInt();
        final r = receipts.putIfAbsent(conv, () => {});
        final user = m['user'] as String;
        final upto = (m['upto'] as num).toInt();
        if (upto > (r[user] ?? 0)) r[user] = upto;
      case 'typing':
        final conv = (m['conv'] as num).toInt();
        typing[conv] = (user: m['user'] as String, at: DateTime.now());
        Timer(const Duration(milliseconds: 4200), () {
          final t = typing[conv];
          if (t != null && DateTime.now().difference(t.at).inMilliseconds >= 4000) {
            typing.remove(conv);
            notifyListeners();
          }
        });
      case 'memberChange':
        // 成员变了：轮换自己的群密钥并重新分发，退群的人从此解不开新消息
        final conv = (m['conv'] as num).toInt();
        link.send({'t': 'convs'});
        if (convById(conv)?.isGroup ?? false) {
          await _locked(() async => vault.client.rotateOwnSenderKey('$conv'));
          // 等新的成员列表回来再分发
          Timer(const Duration(milliseconds: 800), () => _distributeOwnKey(conv).catchError((_) {}));
        }
      case 'error':
        _toast(m['message'] as String? ?? '出错了');
    }
    notifyListeners();
  }

  Future<LocalMsg?> _decryptWire(Map<String, dynamic> wm) async {
    final from = Map<String, dynamic>.from(wm['from'] as Map);
    final user = from['user'] as String;
    final device = from['device'] as String;
    Payload payload;
    try {
      final body = WireBody.fromJson(Map<String, dynamic>.from(wm['body'] as Map));
      payload = await _locked(() async {
        if (body is GroupBody) return vault.client.decryptGroup(body);
        final r = await vault.client.decryptFrom(user, device, body);
        // 首条（预密钥）消息里带着对方的身份公钥
        if (r.peerIkSigPub != null) _learnIdentity(bundleKey(user, device), r.peerIkSigPub!);
        return r.payload;
      });
    } catch (e) {
      payload = {'t': 'system', 'text': '无法解密：$e'};
    }
    if (payload['t'] == 'skdm') {
      _persistSoon(); // 群密钥分发：不显示，但收下的密钥要落盘
      return null;
    }
    return LocalMsg(
      id: (wm['id'] as num).toInt(),
      conv: (wm['conv'] as num).toInt(),
      fromUser: user,
      fromDevice: device,
      createdAt: (wm['createdAt'] as num).toInt(),
      payload: payload,
      mine: user == vault.username,
    );
  }

  Future<void> _onMsg(Map<String, dynamic> wm) async {
    final lm = await _decryptWire(wm);
    if (lm == null) return;
    if (!_add(lm)) return;
    _persistSoon();
    final c = convById(lm.conv);
    if (c == null) {
      link.send({'t': 'convs'});
      return;
    }
    c.lastAt = lm.createdAt;
    final looking = appVisible && activeId == lm.conv;
    if (looking) {
      markRead(lm.conv, lm.id);
    } else if (!lm.mine) {
      c.unread += 1;
    }
    if (!lm.mine && !looking && lm.type != 'system') onNotify?.call(c, lm, nameOf(lm.fromUser));
  }

  Future<void> _onRoam(Map<String, dynamic> m) async {
    final conv = (m['conv'] as num).toInt();
    final items = m['msgs'] as List;
    final priv = vault.roamPriv;
    if (priv == null) return;
    final have = {for (final x in msgs[conv] ?? const <LocalMsg>[]) x.id};
    var added = false;
    for (final it in items) {
      final id = (it['id'] as num).toInt();
      if (have.contains(id)) continue;
      try {
        final pt = await openRoam(fromB64(priv), it['eph'] as String, it['ct'] as String);
        final payload = Map<String, dynamic>.from(jsonDecode(fromUtf8(pt)) as Map);
        final from = it['from'] as Map;
        added |= _add(
          LocalMsg(
            id: id,
            conv: conv,
            fromUser: from['user'] as String,
            fromDevice: from['device'] as String,
            createdAt: (it['createdAt'] as num).toInt(),
            payload: payload,
            mine: from['user'] == vault.username,
          ),
        );
      } catch (_) {
        // 这条副本不是给本账号的，或已损坏
      }
    }
    if (added) _persistSoon();
    // 还有更早的就继续往前翻，最多 3 页
    final round = (_roamPaging[conv] ?? 0) + 1;
    if (round < 3 && items.length >= 80) {
      _roamPaging[conv] = round;
      final minId = items.map((x) => (x['id'] as num).toInt()).reduce((a, b) => a < b ? a : b);
      link.send({'t': 'roamHistory', 'conv': conv, 'beforeId': minId, 'limit': 80});
    }
  }

  /// 按消息号插入本地记录；已有同号的返回 false
  bool _add(LocalMsg m) {
    final list = msgs.putIfAbsent(m.conv, () => vault.log['${m.conv}'] = []);
    if (m.id > 0 && list.any((x) => x.id == m.id)) return false;
    list.add(m);
    _sortConv(m.conv);
    return true;
  }

  void _sortConv(int conv) {
    final list = msgs[conv];
    if (list == null) return;
    // 还没确认的本地消息（负号）排在最后
    list.sort((a, b) {
      if (a.id < 0 || b.id < 0) {
        if (a.id < 0 && b.id < 0) return b.id.compareTo(a.id);
        return a.id < 0 ? 1 : -1;
      }
      return a.id.compareTo(b.id);
    });
    if (list.length > Vault.logLimit) list.removeRange(0, list.length - Vault.logLimit);
  }

  void _loadHistory(int conv) => link.send({'t': 'history', 'conv': conv, 'limit': 80});

  /* ---------------- 公钥包、搜索 ---------------- */

  Future<Map<String, PublicBundle>> _bundlesOf(String user) {
    final existing = _bundleWaiters[user];
    if (existing != null) return existing.future;
    final c = Completer<Map<String, PublicBundle>>();
    _bundleWaiters[user] = c;
    link.send({'t': 'bundle', 'user': user});
    Timer(const Duration(seconds: 8), () {
      if (_bundleWaiters[user] == c) {
        _bundleWaiters.remove(user);
        c.complete({});
      }
    });
    return c.future;
  }

  /* ---------------- 安全码 ---------------- */

  /// 记下对方设备的身份公钥；核对过的设备换了密钥就标成「已变更」
  void _learnIdentity(String key, String ikSigPub) {
    if (vault.idkeys[key] == ikSigPub) return;
    vault.idkeys[key] = ikSigPub;
    final r = vault.trust[key];
    if (r != null && !r.changed && r.safety != _safetyWith(ikSigPub)) {
      vault.trust[key] = TrustRecord(safety: r.safety, changed: true, at: r.at);
    }
    _persistSoon();
    notifyListeners();
  }

  String _safetyWith(String peerIkSigPub) => safetyNumber(vault.keys.identity.ikSigPub, fromB64(peerIkSigPub));

  /// 某个用户每台设备的安全码；还没拿到身份公钥的设备 safety 为 null
  List<DeviceSafety> safetyOf(String user, {Iterable<String> devices = const []}) {
    final prefix = '$user/';
    final ids = <String>{
      ...devices,
      for (final k in vault.idkeys.keys)
        if (k.startsWith(prefix)) k.substring(prefix.length),
    };
    return [
      for (final d in ids.toList()..sort())
        () {
          final key = bundleKey(user, d);
          final pub = vault.idkeys[key];
          final sn = pub == null ? null : _safetyWith(pub);
          return DeviceSafety(
            key: key,
            device: d,
            safety: sn,
            state: sn == null ? TrustState.unverified : TrustRecord.evaluate(sn, vault.trust[key]),
          );
        }(),
    ];
  }

  /// 有设备的安全码在核对之后变了
  bool trustChanged(String user) => safetyOf(user).any((s) => s.state == TrustState.changed);

  /// 向服务器要对方的身份公钥（会消耗对方每台设备一枚一次性预密钥，只在用户点了才做）
  Future<void> fetchIdentities(String user) => _bundlesOf(user);

  void markVerified(DeviceSafety s) {
    if (s.safety == null) return;
    vault.trust[s.key] = TrustRecord(safety: s.safety!, changed: false, at: DateTime.now().millisecondsSinceEpoch);
    _persistSoon();
    notifyListeners();
  }

  void untrust(DeviceSafety s) {
    vault.trust.remove(s.key);
    _persistSoon();
    notifyListeners();
  }

  /// 只给还没有会话的设备取预密钥包（取一次就消耗对方一枚一次性预密钥）
  Future<Map<String, PublicBundle>> _bundlesFor(List<Target> targets) async {
    final need = {
      for (final t in targets)
        if (!vault.client.sessions.has(t.user, t.device)) t.user,
    };
    final out = <String, PublicBundle>{};
    for (final u in need) {
      out.addAll(await _bundlesOf(u));
    }
    return out;
  }

  Future<List<({String username, String displayName})>> searchUsers(String q) {
    _searchWaiter?.complete(const []);
    final c = _searchWaiter = Completer();
    link.send({'t': 'searchUsers', 'q': q});
    return c.future.timeout(const Duration(seconds: 8), onTimeout: () => const []);
  }

  /* ---------------- 会话操作 ---------------- */

  Future<int?> _waitConv(bool Function(Conv) pred) async {
    for (var i = 0; i < 80; i++) {
      for (final c in convs) {
        if (pred(c)) return c.id;
      }
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    return null;
  }

  Future<int?> createDirect(String peer) {
    link.send({'t': 'createDirect', 'peer': peer});
    return _waitConv((c) => !c.isGroup && c.members.any((m) => m.user == peer));
  }

  Future<int?> createGroup(String name, List<String> members) {
    final before = {for (final c in convs) c.id};
    link.send({'t': 'createGroup', 'name': name, 'members': members});
    return _waitConv((c) => c.isGroup && !before.contains(c.id) && c.name == name);
  }

  void openConv(int? id) {
    activeId = id;
    if (id == null) {
      notifyListeners();
      return;
    }
    if ((msgs[id] ?? const []).isEmpty) _loadHistory(id);
    _roamPaging[id] = 0;
    _pullRoam(id);
    final last = lastOf(id);
    if (last != null && last.id > 0) markRead(id, last.id);
    final c = convById(id);
    if (c != null) {
      c.unread = 0;
      if (c.isGroup && !vault.client.ownSenderKeys.containsKey('$id') && c.members.any((m) => m.user != vault.username)) {
        _distributeOwnKey(id).catchError((_) {});
      }
    }
    notifyListeners();
  }

  void _pullRoam(int conv) {
    if (vault.roamPriv == null) return;
    final ids = [for (final x in msgs[conv] ?? const <LocalMsg>[]) if (x.id > 0) x.id];
    final oldest = ids.isEmpty ? null : ids.reduce((a, b) => a < b ? a : b);
    link.send({'t': 'roamHistory', 'conv': conv, 'beforeId': ?oldest, 'limit': 80});
  }

  void markRead(int conv, int upto) {
    final cur = vault.reads['$conv'] ?? 0;
    convById(conv)?.unread = 0;
    if (upto <= cur) return;
    vault.reads['$conv'] = upto;
    link.send({'t': 'receipt', 'conv': conv, 'upto': upto});
    _persistSoon();
  }

  /// 窗口前台/后台切换
  void setVisible(bool visible) {
    if (appVisible == visible) return;
    appVisible = visible;
    link.setVisible(visible);
    final a = activeId;
    if (visible && a != null) {
      final last = lastOf(a);
      if (last != null && last.id > 0) markRead(a, last.id);
    }
    notifyListeners();
  }

  void sendTyping(int conv) {
    final now = DateTime.now();
    if (now.difference(_typingSent).inMilliseconds < 1800) return;
    _typingSent = now;
    link.send({'t': 'typing', 'conv': conv});
  }

  /* ---------------- 发消息 ---------------- */

  Future<void> sendText(int conv, String text) => _sendPayload(conv, {'t': 'text', 'text': text});

  Future<void> _sendPayload(int convId, Payload payload) async {
    final c = convById(convId);
    if (c == null) return;
    final clientId = '${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}-${++_tempSeq}';
    final local = LocalMsg(
      id: -(DateTime.now().millisecondsSinceEpoch * 100 + _tempSeq % 100),
      conv: convId,
      fromUser: vault.username,
      fromDevice: vault.deviceId,
      createdAt: DateTime.now().millisecondsSinceEpoch,
      payload: payload,
      mine: true,
      sending: true,
    );
    _add(local);
    notifyListeners();
    try {
      final users = [for (final m in c.members) m.user];
      if (!c.isGroup) {
        final other = peerOf(c);
        if (other == null) throw StateError('会话缺少对端');
        final targets = [for (final d in other.devices) (user: other.user, device: d)];
        final bundles = await _bundlesFor(targets);
        final r = await _locked(() => vault.client.encryptToDevices(targets, bundles, payload));
        if (r.bodies.isEmpty) throw StateError('对方没有可用设备（预密钥包获取失败）');
        final hist = await _buildHist(payload, users);
        _pending[clientId] = local;
        link.send({
          't': 'send',
          'conv': convId,
          'bodies': [for (final b in r.bodies) b.toJson()],
          'hist': hist,
          'clientId': clientId,
        });
      } else {
        if (!vault.client.ownSenderKeys.containsKey('$convId')) await _distributeOwnKey(convId);
        final body = await _locked(() => vault.client.encryptGroup('$convId', payload));
        final hist = await _buildHist(payload, users);
        _pending[clientId] = local;
        link.send({'t': 'sendGroup', 'conv': convId, 'body': body.toJson(), 'hist': hist, 'clientId': clientId});
      }
      _persistSoon();
    } catch (e) {
      local
        ..sending = false
        ..failed = '$e';
      _toast('发送失败：$e');
    }
    notifyListeners();
  }

  /// 把自己的群密钥逐设备加密发给群里其他人
  Future<void> _distributeOwnKey(int convId) async {
    final c = convById(convId);
    if (c == null) return;
    final targets = [
      for (final m in c.members)
        if (m.user != vault.username)
          for (final d in m.devices) (user: m.user, device: d),
    ];
    final bundles = await _bundlesFor(targets);
    final r = await _locked(() => vault.client.buildSenderKeyDistribution('$convId', targets, bundles));
    if (r.bodies.isNotEmpty) {
      link.send({
        't': 'send',
        'conv': convId,
        'bodies': [for (final b in r.bodies) b.toJson()],
      });
    }
    _persistSoon();
  }

  /// 每个相关账号一份历史副本（用对方账号的漫游公钥封），换设备后能补回 14 天内的记录
  Future<List<Map<String, String>>> _buildHist(Payload payload, List<String> users) async {
    if (vault.roamPub == null) return const [];
    _roamPubs[vault.username] = vault.roamPub!;
    for (final u in users) {
      if (_roamPubs.containsKey(u)) continue;
      try {
        _roamPubs[u] = await api.roamPub(vault.token, u);
      } catch (_) {
        // 对方没开漫游：少一份副本而已
      }
    }
    final plain = utf8Bytes(jsonEncode(payload));
    final out = <Map<String, String>>[];
    for (final u in users) {
      final pub = _roamPubs[u];
      if (pub == null) continue;
      try {
        final s = await sealForRoam(fromB64(pub), plain);
        out.add({'user': u, 'eph': s.eph, 'ct': s.ct});
      } catch (_) {}
    }
    return out;
  }

  /* ---------------- 文件 ---------------- */

  /// 单个文件上限，和服务端 MAX_BLOB 一致
  static const maxFileBytes = 30 * 1024 * 1024;

  /// 正在上传的文件数（聊天页显示进度条）
  final uploading = <int, int>{};

  /// 发文件：本机用随机密钥加密 → 上传密文 → 把密钥放进端到端加密的消息里发出去
  /// （和 Web 端同一格式，两边互通）
  Future<void> sendFile(int convId, {required String name, required Uint8List bytes, String mime = ''}) async {
    if (bytes.length > maxFileBytes) throw StateError('单个文件上限 30MB');
    final type = mime.isNotEmpty ? mime : mimeFromName(name);
    uploading[convId] = (uploading[convId] ?? 0) + 1;
    notifyListeners();
    try {
      final key = randomBytes(32);
      final ct = await aeadSeal(key, bytes, utf8Bytes('blob'));
      final up = await api.putBlob(vault.token, ct, type);
      // 自己发的直接放进缓存，不用再下载
      await _cacheWrite(up.id, ct);
      await _sendPayload(convId, {
        't': 'file',
        'blobId': up.id,
        'name': name,
        'size': bytes.length,
        'mime': type,
        'key': toB64(key),
      });
    } finally {
      final n = (uploading[convId] ?? 1) - 1;
      if (n <= 0) {
        uploading.remove(convId);
      } else {
        uploading[convId] = n;
      }
      notifyListeners();
    }
  }

  /// 附件缓存：只存密文（密钥在本机密钥库里），所以缓存目录里没有明文。
  /// 好处是服务器 14 天清掉之后，看过的图片在本机仍然能打开。
  Directory? _cacheDir;

  @visibleForTesting
  set blobCacheDir(Directory d) => _cacheDir = d;

  Future<Directory> _blobCache() async {
    if (_cacheDir != null) return _cacheDir!;
    final base = await getApplicationSupportDirectory();
    return _cacheDir = await Directory('${base.path}${Platform.pathSeparator}blobs').create(recursive: true);
  }

  File _cacheFile(Directory d, String id) => File('${d.path}${Platform.pathSeparator}${id.replaceAll(RegExp(r'[^0-9a-zA-Z]'), '')}');

  Future<void> _cacheWrite(String id, Uint8List ct) async {
    try {
      final f = _cacheFile(await _blobCache(), id);
      final tmp = File('${f.path}.part');
      await tmp.writeAsBytes(ct, flush: true);
      await tmp.rename(f.path);
    } catch (_) {
      // 缓存写不进去只是下次要重新下载
    }
  }

  final _decrypting = <String, Future<Uint8List>>{};

  /// 取附件明文（先看本机缓存，没有再下载），解密只在内存里
  Future<Uint8List> fileBytes(Payload p) {
    final id = p['blobId'] as String;
    return _decrypting[id] ??= () async {
      try {
        File? f;
        try {
          f = _cacheFile(await _blobCache(), id);
        } catch (_) {}
        Uint8List ct;
        if (f != null && await f.exists()) {
          ct = await f.readAsBytes();
        } else {
          ct = await api.getBlob(vault.token, id);
          await _cacheWrite(id, ct);
        }
        return Uint8List.fromList(await aeadOpen(fromB64(p['key'] as String), ct, utf8Bytes('blob')));
      } finally {
        // 明文不常驻内存，界面那边自己留着要显示的那份
        unawaited(Future<void>.delayed(const Duration(seconds: 1), () => _decrypting.remove(id)));
      }
    }();
  }

  /// 下载并解密附件，存进「下载」文件夹，返回保存路径
  Future<String> saveFile(Payload p) async {
    final pt = await fileBytes(p);
    final dir = await getDownloadsDirectory() ?? await getApplicationDocumentsDirectory();
    final f = await _uniqueFile(dir, p['name'] as String? ?? 'file');
    await f.writeAsBytes(pt);
    return f.path;
  }

  /// 解密到临时目录，给系统里的其他软件打开用（打开后的文件由那个软件处理）
  Future<String> exportForOpen(Payload p) async {
    final pt = await fileBytes(p);
    final base = await getTemporaryDirectory();
    final dir = await Directory('${base.path}${Platform.pathSeparator}cipherim-open').create(recursive: true);
    final f = await _uniqueFile(dir, p['name'] as String? ?? 'file');
    await f.writeAsBytes(pt);
    return f.path;
  }

  /// 清掉上次给外部软件打开留下的临时明文
  static Future<void> cleanOpenedFiles() async {
    try {
      final base = await getTemporaryDirectory();
      final dir = Directory('${base.path}${Platform.pathSeparator}cipherim-open');
      if (await dir.exists()) await dir.delete(recursive: true);
    } catch (_) {}
  }

  static Future<File> _uniqueFile(Directory dir, String name) async {
    final safe = name.replaceAll(RegExp(r'[\\/:*?"<>|\x00-\x1f]'), '_');
    var f = File('${dir.path}${Platform.pathSeparator}$safe');
    for (var i = 1; await f.exists(); i++) {
      final dot = safe.lastIndexOf('.');
      final n = dot > 0 ? '${safe.substring(0, dot)} ($i)${safe.substring(dot)}' : '$safe ($i)';
      f = File('${dir.path}${Platform.pathSeparator}$n');
    }
    return f;
  }
}
