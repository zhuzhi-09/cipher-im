/// 加密客户端（对应 Web 端 client.ts）：会话（双棘轮）+ 群组（发送者密钥）
library;

import 'dart:convert';

import '../protocol/wire.dart';
import 'identity.dart';
import 'primitives.dart';
import 'senderkey.dart';
import 'session.dart';

typedef Target = ({String user, String device});

class EncryptedFor {
  EncryptedFor({required this.user, required this.device, required this.body});
  final String user;
  final String device;
  final WireBody body;

  Map<String, dynamic> toJson() => {'user': user, 'device': device, 'body': body.toJson()};
}

String bundleKey(String user, String device) => '$user/$device';
String senderKeyMapKey(String groupId, String user, String device) => '$groupId|$user|$device';

class CryptoClient {
  CryptoClient(this.username, this.deviceId, this.keys) : sessions = SessionManager(keys);

  final String username;
  final String deviceId;
  final DeviceKeys keys;
  final SessionManager sessions;
  final Map<String, SenderKeyState> ownSenderKeys = {};
  final Map<String, SenderKeyState> peerSenderKeys = {};

  /// 对一批目标设备加密同一条载荷。没有会话又缺预密钥包的设备跳过
  Future<({List<EncryptedFor> bodies, List<Target> skipped})> encryptToDevices(
    List<Target> targets,
    Map<String, PublicBundle> bundles,
    Payload payload,
  ) async {
    final bodies = <EncryptedFor>[];
    final skipped = <Target>[];
    for (final t in targets) {
      if (t.user == username && t.device == deviceId) continue; // 不给自己发
      if (!sessions.has(t.user, t.device)) {
        final b = bundles[bundleKey(t.user, t.device)];
        if (b == null) {
          skipped.add(t);
          continue;
        }
        await sessions.establish(t.user, t.device, b);
      }
      bodies.add(EncryptedFor(user: t.user, device: t.device, body: await sessions.encrypt(t.user, t.device, payload)));
    }
    return (bodies: bodies, skipped: skipped);
  }

  Future<DecryptResult> decryptFrom(String user, String device, WireBody body) async {
    final r = await sessions.decrypt(body, user, device);
    if (r.payload['t'] == 'skdm') {
      final d = Map<String, dynamic>.from(r.payload['dist'] as Map);
      final k = senderKeyMapKey(d['groupId'], d['ownerUser'], d['ownerDevice']);
      final cur = peerSenderKeys[k];
      // 同一把密钥被重复分发时，不要把已经往前推的链倒回去
      if (cur == null || cur.keyId != d['keyId'] || cur.iteration < (d['iteration'] as num).toInt()) {
        peerSenderKeys[k] = senderKeyFromDistribution(d);
      }
    }
    final opk = r.usedOpk;
    if (opk != null) sessions.consumeOpk(opk);
    return r;
  }

  /* ---------------- 群组 ---------------- */

  SenderKeyState ensureOwnSenderKey(String groupId) =>
      ownSenderKeys.putIfAbsent(groupId, () => createSenderKey(groupId, username, deviceId));

  /// 成员变动时轮换：丢掉旧链，下次发消息或分发时自动生成新密钥
  void rotateOwnSenderKey(String groupId) => ownSenderKeys.remove(groupId);

  Future<GroupBody> encryptGroup(String groupId, Payload payload) async {
    final st = ensureOwnSenderKey(groupId);
    final r = await senderKeyEncrypt(st, utf8Bytes(jsonEncode(payload)));
    return GroupBody(
      groupId: groupId,
      ownerUser: username,
      ownerDevice: deviceId,
      keyId: st.keyId,
      iteration: r.iteration,
      ct: toB64(r.ct),
    );
  }

  Future<Payload> decryptGroup(GroupBody body) async {
    final st = peerSenderKeys[senderKeyMapKey(body.groupId, body.ownerUser, body.ownerDevice)];
    if (st == null) throw CryptoException('还没有收到该发送者的群密钥，无法解密');
    final pt = await senderKeyDecrypt(st, body.keyId, body.iteration, fromB64(body.ct));
    return jsonDecode(fromUtf8(pt)) as Payload;
  }

  /// 把自己的群密钥分发出去：逐设备加密一份 skdm 载荷
  Future<({List<EncryptedFor> bodies, List<Target> skipped})> buildSenderKeyDistribution(
    String groupId,
    List<Target> targets,
    Map<String, PublicBundle> bundles,
  ) {
    final st = ensureOwnSenderKey(groupId);
    return encryptToDevices(targets, bundles, {'t': 'skdm', 'dist': senderKeyDistribution(st)});
  }

  bool hasPeerSenderKey(String groupId, String user, String device) =>
      peerSenderKeys.containsKey(senderKeyMapKey(groupId, user, device));
}
