/// 会话管理（对应 Web 端 session.ts，逐行移植）
///  - 同一对端设备最多保留 3 条链路（双方同时发起时会有多条）
///  - 解密按「当前链路优先，其余按存放顺序」逐条尝试，失败回滚，成功的设为当前
///  - 收到对端任何消息前，发出的每条都用预密钥信封
library;

import 'dart:convert';

import '../protocol/wire.dart';
import 'identity.dart';
import 'primitives.dart';
import 'ratchet.dart';
import 'x3dh.dart';

const maxSessionsPerPeer = 3;

/// 明文载荷：JSON 对象，至少有字符串字段 t（text / file / skdm / system）
typedef Payload = Map<String, dynamic>;

Bytes encodePayload(Payload p) => utf8Bytes(jsonEncode(p));

Payload decodePayload(Bytes b) {
  try {
    final parsed = jsonDecode(fromUtf8(b));
    if (parsed is Map<String, dynamic> && parsed['t'] is String) return parsed;
  } catch (_) {}
  throw CryptoException('载荷解析失败');
}

class PendingPrekey {
  PendingPrekey({required this.ekPub, required this.spkId, required this.opkId});
  final String ekPub;
  final String spkId;
  final String? opkId;

  Map<String, dynamic> toJson() => {'ekPub': ekPub, 'spkId': spkId, 'opkId': opkId};
  factory PendingPrekey.fromJson(Map<String, dynamic> j) =>
      PendingPrekey(ekPub: j['ekPub'], spkId: j['spkId'], opkId: j['opkId']);
}

class SessionRecord {
  SessionRecord({
    required this.id,
    required this.peerUser,
    required this.peerDevice,
    required this.peerIkDhPub,
    required this.state,
    required this.pendingPrekey,
  });
  final String id; // 链路 id = 首个棘轮公钥
  final String peerUser;
  final String peerDevice;
  String peerIkDhPub;
  RatchetState state;
  PendingPrekey? pendingPrekey;

  Map<String, dynamic> toJson() => {
    'id': id,
    'peerUser': peerUser,
    'peerDevice': peerDevice,
    'peerIkDhPub': peerIkDhPub,
    'state': state.toJson(),
    'pendingPrekey': pendingPrekey?.toJson(),
  };
  factory SessionRecord.fromJson(Map<String, dynamic> j) => SessionRecord(
    id: j['id'],
    peerUser: j['peerUser'],
    peerDevice: j['peerDevice'],
    peerIkDhPub: j['peerIkDhPub'],
    state: RatchetState.fromJson(j['state']),
    pendingPrekey: j['pendingPrekey'] == null ? null : PendingPrekey.fromJson(j['pendingPrekey']),
  );
}

class PeerState {
  PeerState();
  final List<SessionRecord> records = [];
  String? current;
  final Map<String, int> lastUsed = {};

  Map<String, dynamic> toJson() => {
    'records': records.map((r) => r.toJson()).toList(),
    'current': current,
    'lastUsed': lastUsed,
  };
  factory PeerState.fromJson(Map<String, dynamic> j) {
    final p = PeerState()..current = j['current'];
    p.records.addAll((j['records'] as List).map((r) => SessionRecord.fromJson(r)));
    p.lastUsed.addAll(Map<String, num>.from(j['lastUsed'] as Map? ?? const {}).map((k, v) => MapEntry(k, v.toInt())));
    return p;
  }
}

class DecryptResult {
  DecryptResult({required this.payload, required this.created, required this.usedOpk, required this.peerIkSigPub});
  final Payload payload;
  final bool created;
  final String? usedOpk;
  final String? peerIkSigPub;
}

int _now() => DateTime.now().millisecondsSinceEpoch;

class SessionManager {
  SessionManager(this.keys);
  final DeviceKeys keys;
  final Map<String, PeerState> peers = {};

  static String key(String user, String device) => '$user/$device';

  PeerState _peer(String user, String device) => peers.putIfAbsent(key(user, device), PeerState.new);

  bool has(String user, String device) => (peers[key(user, device)]?.records.isNotEmpty) ?? false;

  /// 用对端预密钥包新建发起方链路
  Future<SessionRecord> establish(String user, String device, PublicBundle bundle) async {
    if (!await verifyBundle(bundle)) throw CryptoException('对端预密钥包签名无效');
    final x = await x3dhInitiate(keys.identity, bundle);
    final state = await initRatchetAlice(x.sk, fromB64(bundle.spkPub), x.ad);
    final rec = SessionRecord(
      id: state.dhsPub,
      peerUser: user,
      peerDevice: device,
      peerIkDhPub: bundle.ikDhPub,
      state: state,
      pendingPrekey: PendingPrekey(ekPub: toB64(x.ekPub), spkId: x.spkId, opkId: x.opkId),
    );
    final p = _peer(user, device);
    p.records.add(rec);
    p.current = rec.id;
    p.lastUsed[rec.id] = _now();
    _gc(p);
    return rec;
  }

  void _gc(PeerState p) {
    while (p.records.length > maxSessionsPerPeer) {
      var victim = -1;
      var oldest = 1 << 62;
      for (var i = 0; i < p.records.length; i++) {
        final r = p.records[i];
        if (r.id == p.current) continue;
        final t = p.lastUsed[r.id] ?? 0;
        if (t < oldest) {
          oldest = t;
          victim = i;
        }
      }
      if (victim < 0) break;
      p.lastUsed.remove(p.records[victim].id);
      p.records.removeAt(victim);
    }
  }

  Future<WireBody> encrypt(String user, String device, Payload payload) async {
    final p = _peer(user, device);
    if (p.records.isEmpty) throw CryptoException('会话不存在，需要先取得预密钥包');
    final rec = p.records.firstWhere((r) => r.id == p.current, orElse: () => p.records.last);

    final r = await ratchetEncrypt(rec.state, encodePayload(payload));
    p.lastUsed[rec.id] = _now();

    final pk = rec.pendingPrekey;
    if (pk != null) {
      return PreKeyBody(
        ikSigPub: toB64(keys.identity.ikSigPub),
        ikDhPub: toB64(keys.identity.ikDhPub),
        ekPub: pk.ekPub,
        spkId: pk.spkId,
        opkId: pk.opkId,
        header: r.header,
        ct: toB64(r.ct),
      );
    }
    return MsgBody(header: r.header, ct: toB64(r.ct));
  }

  void _confirmPeer(String user, String device) {
    final p = peers[key(user, device)];
    if (p == null) return;
    for (final r in p.records) {
      r.pendingPrekey = null;
    }
  }

  Future<DecryptResult> decrypt(WireBody body, String fromUser, String fromDevice) async {
    switch (body) {
      case GroupBody():
        throw CryptoException('群组密文不走本方法');
      case PreKeyBody():
        return _decryptPreKey(body, fromUser, fromDevice);
      case MsgBody():
        break;
    }

    final p = _peer(fromUser, fromDevice);
    if (p.records.isEmpty) throw CryptoException('没有与该设备的会话，无法解密');

    final order = [...p.records.where((r) => r.id == p.current), ...p.records.where((r) => r.id != p.current)];

    Object? lastErr;
    for (final rec in order) {
      final snapshot = rec.state.copy();
      try {
        final pt = await ratchetDecrypt(rec.state, body.header, fromB64(body.ct));
        p.current = rec.id;
        p.lastUsed[rec.id] = _now();
        _confirmPeer(fromUser, fromDevice);
        return DecryptResult(payload: decodePayload(pt), created: false, usedOpk: null, peerIkSigPub: null);
      } catch (e) {
        rec.state.restore(snapshot);
        lastErr = e;
      }
    }
    throw CryptoException('无法解密：${lastErr ?? '未知原因'}');
  }

  Future<DecryptResult> _decryptPreKey(PreKeyBody body, String fromUser, String fromDevice) async {
    final k = keys;
    final p = _peer(fromUser, fromDevice);

    // 同一 baseKey 的链路已存在：先在现有链路上解，失败再重建
    final existing = p.records.where((r) => r.id == body.header.dh).firstOrNull;
    if (existing != null) {
      final snapshot = existing.state.copy();
      try {
        final pt = await ratchetDecrypt(existing.state, body.header, fromB64(body.ct));
        p.current = existing.id;
        p.lastUsed[existing.id] = _now();
        _confirmPeer(fromUser, fromDevice);
        return DecryptResult(
          payload: decodePayload(pt),
          created: false,
          usedOpk: body.opkId,
          peerIkSigPub: body.ikSigPub,
        );
      } catch (_) {
        existing.state.restore(snapshot);
      }
    }

    if (body.spkId != k.spk.id) throw CryptoException('签名预密钥已失效，请让对端重新获取你的预密钥包');
    final opk = body.opkId == null ? null : k.opks.where((o) => o.id == body.opkId).firstOrNull;
    if (body.opkId != null && opk == null) throw CryptoException('一次性预密钥已被消耗，请让对端重新获取');

    final x = await x3dhRespond(
      selfDhPriv: k.identity.dhPriv,
      selfIkDhPub: k.identity.ikDhPub,
      spkPriv: k.spk.priv,
      opkPriv: opk?.priv,
      initiatorIkDhPub: fromB64(body.ikDhPub),
      initiatorEkPub: fromB64(body.ekPub),
    );
    final state = initRatchetBob(x.sk, k.spk.priv, k.spk.pub, x.ad);

    var rec = existing;
    final created = rec == null;
    if (rec == null) {
      rec = SessionRecord(
        id: body.header.dh,
        peerUser: fromUser,
        peerDevice: fromDevice,
        peerIkDhPub: body.ikDhPub,
        state: state,
        pendingPrekey: null,
      );
      p.records.add(rec);
    } else {
      rec.state = state;
      rec.peerIkDhPub = body.ikDhPub;
    }

    // 新建的链路解密失败要整条撤掉，不能留下一条坏链路
    final Bytes pt;
    try {
      pt = await ratchetDecrypt(rec.state, body.header, fromB64(body.ct));
    } catch (e) {
      if (created) p.records.remove(rec);
      rethrow;
    }
    p.current = rec.id;
    p.lastUsed[rec.id] = _now();
    _confirmPeer(fromUser, fromDevice);
    _gc(p);
    return DecryptResult(
      payload: decodePayload(pt),
      created: created,
      usedOpk: body.opkId,
      peerIkSigPub: body.ikSigPub,
    );
  }

  int opkCount() => keys.opks.length;

  void consumeOpk(String id) => keys.opks = keys.opks.where((o) => o.id != id).toList();

  Map<String, dynamic> toJson() => peers.map((k, v) => MapEntry(k, v.toJson()));
  void loadJson(Map<String, dynamic> j) {
    peers.clear();
    j.forEach((k, v) => peers[k] = PeerState.fromJson(v));
  }
}
