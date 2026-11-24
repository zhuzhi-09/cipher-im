/// 本机密钥库：身份密钥、会话状态、群密钥、本地明文记录，整体加密后存成一个文件
///
/// 和 Web 端不同：原生客户端要开机常驻、在托盘里收消息，不能每次启动都让人输口令。
/// 所以这里用一把随机生成的本机密钥（KEK）加密，KEK 交给系统的安全存储保管
/// （Windows 是 DPAPI，安卓是 Keystore），只有本机当前用户能取出来。
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cipher_core/cipher_core.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';

/// 本地明文记录里的一条消息（只在本机，随密钥库一起加密落盘）
class LocalMsg {
  LocalMsg({
    required this.id,
    required this.conv,
    required this.fromUser,
    required this.fromDevice,
    required this.createdAt,
    required this.payload,
    required this.mine,
    this.sending = false,
    this.failed,
  });

  /// 服务端消息号；还没确认的本地消息是负数
  int id;
  final int conv;
  final String fromUser;
  final String fromDevice;
  int createdAt;
  final Payload payload;

  /// 自己账号发的（不论哪台设备）
  final bool mine;
  bool sending;
  String? failed;

  String get type => payload['t'] as String? ?? '';

  Map<String, dynamic> toJson() => {
    'id': id,
    'from': {'user': fromUser, 'device': fromDevice},
    'createdAt': createdAt,
    'payload': payload,
    'mine': mine,
  };

  factory LocalMsg.fromJson(int conv, Map<String, dynamic> j) => LocalMsg(
    id: (j['id'] as num).toInt(),
    conv: conv,
    fromUser: j['from']['user'] as String,
    fromDevice: j['from']['device'] as String,
    createdAt: (j['createdAt'] as num).toInt(),
    payload: Map<String, dynamic>.from(j['payload'] as Map),
    mine: j['mine'] == true,
  );
}

class Vault {
  Vault({
    required this.server,
    required this.username,
    required this.displayName,
    required this.deviceId,
    required this.token,
    required this.client,
    this.roamPub,
    this.roamPriv,
    Map<String, int>? reads,
    Map<String, String>? contacts,
    Map<String, List<LocalMsg>>? log,
    Map<String, dynamic>? prefs,
  }) : reads = reads ?? {},
       contacts = contacts ?? {},
       log = log ?? {},
       prefs = prefs ?? {};

  /// 服务器根地址（账号和服务器绑在一起，换服务器 = 换账号）
  final String server;
  final String username;
  String displayName;
  final String deviceId;
  String token;
  final CryptoClient client;
  String? roamPub;
  String? roamPriv;
  final Map<String, int> reads;
  final Map<String, String> contacts;
  final Map<String, List<LocalMsg>> log;
  final Map<String, dynamic> prefs;

  DeviceKeys get keys => client.keys;

  bool get notifyPreview => prefs['notifyPreview'] != false;
  set notifyPreview(bool v) => prefs['notifyPreview'] = v;

  /// 每个会话本地最多留多少条明文
  static const logLimit = 500;

  Map<String, dynamic> toJson() => {
    'v': 1,
    'server': server,
    'username': username,
    'displayName': displayName,
    'deviceId': deviceId,
    'token': token,
    'keys': keys.toJson(),
    'sessions': client.sessions.toJson(),
    'ownSenderKeys': client.ownSenderKeys.map((k, v) => MapEntry(k, v.toJson())),
    'peerSenderKeys': client.peerSenderKeys.map((k, v) => MapEntry(k, v.toJson())),
    'roam': roamPub == null ? null : {'pub': roamPub, 'priv': roamPriv},
    'reads': reads,
    'contacts': contacts,
    'log': log.map((k, v) => MapEntry(k, v.map((m) => m.toJson()).toList())),
    'prefs': prefs,
  };

  factory Vault.fromJson(Map<String, dynamic> j) {
    final username = j['username'] as String;
    final deviceId = j['deviceId'] as String;
    final client = CryptoClient(username, deviceId, DeviceKeys.fromJson(j['keys'] as Map<String, dynamic>));
    client.sessions.loadJson(Map<String, dynamic>.from(j['sessions'] as Map));
    (j['ownSenderKeys'] as Map).forEach((k, v) => client.ownSenderKeys[k as String] = SenderKeyState.fromJson(v));
    (j['peerSenderKeys'] as Map).forEach((k, v) => client.peerSenderKeys[k as String] = SenderKeyState.fromJson(v));
    final roam = j['roam'] as Map?;
    return Vault(
      server: j['server'] as String,
      username: username,
      displayName: j['displayName'] as String,
      deviceId: deviceId,
      token: j['token'] as String,
      client: client,
      roamPub: roam?['pub'] as String?,
      roamPriv: roam?['priv'] as String?,
      reads: Map<String, int>.from(j['reads'] as Map? ?? const {}),
      contacts: Map<String, String>.from(j['contacts'] as Map? ?? const {}),
      log: (j['log'] as Map? ?? const {}).map(
        (k, v) => MapEntry(
          k as String,
          (v as List).map((m) => LocalMsg.fromJson(int.parse(k), Map<String, dynamic>.from(m as Map))).toList(),
        ),
      ),
      prefs: Map<String, dynamic>.from(j['prefs'] as Map? ?? const {}),
    );
  }
}

/// 设备号：d- 加 10 位小写字母数字（和 Web 端同一格式）
String generateDeviceId() {
  final s = toB64(randomBytes(15)).replaceAll(RegExp(r'[+/=]'), '').toLowerCase();
  return 'd-${s.substring(0, 10)}'; // 15 字节 → 20 个字符，去掉符号后仍远多于 10 位
}

/// 密钥库文件读写。写入先写临时文件再改名，断电也不会留下半个文件
class VaultStore {
  VaultStore._(this._file, this._storage);

  /// 测试用：不碰系统安全存储，直接用给定的本机密钥
  VaultStore.forTest(this._file, Uint8List kek) : _storage = null, _kek = kek;

  static const _kekName = 'cipherim.vault.kek';
  static final _aad = utf8Bytes('CipherIM-native-vault-v1');

  final File _file;
  final FlutterSecureStorage? _storage;
  Uint8List? _kek;
  Future<void> _writing = Future.value();

  static Future<VaultStore> open() async {
    final dir = await getApplicationSupportDirectory();
    await dir.create(recursive: true);
    return VaultStore._(File('${dir.path}${Platform.pathSeparator}vault.bin'), const FlutterSecureStorage());
  }

  Future<Uint8List> _getKek({required bool create}) async {
    if (_kek != null) return _kek!;
    final storage = _storage!;
    final s = await storage.read(key: _kekName);
    if (s != null) return _kek = fromB64(s);
    if (!create) throw StateError('本机密钥丢失');
    final k = randomBytes(32);
    await storage.write(key: _kekName, value: toB64(k));
    return _kek = k;
  }

  /// 读出已有账号；没有或打不开时返回 null
  Future<Vault?> load() async {
    if (!await _file.exists()) return null;
    final kek = await _getKek(create: false);
    final pt = await aeadOpenRandom(kek, await _file.readAsBytes(), _aad);
    return Vault.fromJson(jsonDecode(fromUtf8(pt)) as Map<String, dynamic>);
  }

  /// 落盘：多次调用按顺序排队写
  Future<void> save(Vault v) {
    final text = jsonEncode(v.toJson());
    return _writing = _writing.then((_) async {
      final kek = await _getKek(create: true);
      final ct = await aeadSealRandom(kek, utf8Bytes(text), _aad);
      final tmp = File('${_file.path}.tmp');
      await tmp.writeAsBytes(ct, flush: true);
      await tmp.rename(_file.path);
    });
  }

  /// 退出账号：删除密钥库和本机密钥（本机的消息记录和会话状态一起消失）
  Future<void> wipe() async {
    await _writing;
    if (await _file.exists()) await _file.delete();
    await _storage?.delete(key: _kekName);
    _kek = null;
  }
}
