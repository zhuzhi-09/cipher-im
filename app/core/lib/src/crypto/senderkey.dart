/// 群组发送者密钥（对应 Web 端 senderkey.ts）
library;

import 'dart:typed_data';

import 'primitives.dart';
import 'random.dart';

const maxChainAdvance = 1024;

class SenderKeyState {
  SenderKeyState({
    required this.groupId,
    required this.ownerUser,
    required this.ownerDevice,
    required this.keyId,
    required this.chainKey,
    required this.iteration,
    this.initChainKey,
    this.initIteration,
  });
  final String groupId;
  final String ownerUser;
  final String ownerDevice;
  final String keyId;
  String chainKey; // b64
  int iteration;

  /// 自己的密钥：创建时的链状态，分发时永远发这个（见 Web 端同名字段的说明）
  final String? initChainKey;
  final int? initIteration;

  Map<String, dynamic> toJson() => {
    'groupId': groupId,
    'ownerUser': ownerUser,
    'ownerDevice': ownerDevice,
    'keyId': keyId,
    'chainKey': chainKey,
    'iteration': iteration,
    if (initChainKey != null) 'initChainKey': initChainKey,
    if (initIteration != null) 'initIteration': initIteration,
  };

  factory SenderKeyState.fromJson(Map<String, dynamic> j) => SenderKeyState(
    groupId: j['groupId'],
    ownerUser: j['ownerUser'],
    ownerDevice: j['ownerDevice'],
    keyId: j['keyId'],
    chainKey: j['chainKey'],
    iteration: (j['iteration'] as num).toInt(),
    initChainKey: j['initChainKey'],
    initIteration: (j['initIteration'] as num?)?.toInt(),
  );
}

Bytes _groupAad(String groupId, String ownerUser, String ownerDevice, String keyId, int iteration) => concat([
  utf8Bytes('CipherIM-GRP-v1'),
  utf8Bytes(groupId),
  Uint8List(1),
  utf8Bytes(ownerUser),
  Uint8List(1),
  utf8Bytes(ownerDevice),
  Uint8List(1),
  utf8Bytes(keyId),
  u32be(iteration),
]);

SenderKeyState createSenderKey(String groupId, String ownerUser, String ownerDevice) {
  final keyId = toB64(randomBytes(8));
  final chainKey = toB64(randomBytes(32));
  return SenderKeyState(
    groupId: groupId,
    ownerUser: ownerUser,
    ownerDevice: ownerDevice,
    keyId: keyId,
    chainKey: chainKey,
    iteration: 0,
    initChainKey: chainKey,
    initIteration: 0,
  );
}

({Bytes chainKey, Bytes mk}) _ratchetChain(Bytes chainKey) =>
    (chainKey: hmacSha256(chainKey, Uint8List.fromList([2])), mk: hmacSha256(chainKey, Uint8List.fromList([1])));

Future<({int iteration, Bytes ct})> senderKeyEncrypt(SenderKeyState st, Bytes plaintext) async {
  final iteration = st.iteration;
  final r = _ratchetChain(fromB64(st.chainKey));
  st.chainKey = toB64(r.chainKey);
  st.iteration = iteration + 1;
  final ct = await aeadSeal(r.mk, plaintext, _groupAad(st.groupId, st.ownerUser, st.ownerDevice, st.keyId, iteration));
  return (iteration: iteration, ct: ct);
}

/// 分发载荷（skdm 的 dist 字段）：发创建时的初始状态
Map<String, dynamic> senderKeyDistribution(SenderKeyState st) => {
  'groupId': st.groupId,
  'ownerUser': st.ownerUser,
  'ownerDevice': st.ownerDevice,
  'keyId': st.keyId,
  'chainKey': st.initChainKey ?? st.chainKey,
  'iteration': st.initIteration ?? st.iteration,
};

SenderKeyState senderKeyFromDistribution(Map<String, dynamic> d) => SenderKeyState(
  groupId: d['groupId'],
  ownerUser: d['ownerUser'],
  ownerDevice: d['ownerDevice'],
  keyId: d['keyId'],
  chainKey: d['chainKey'],
  iteration: (d['iteration'] as num).toInt(),
);

Future<Bytes> senderKeyDecrypt(SenderKeyState st, String keyId, int iteration, Bytes ct) async {
  if (st.keyId != keyId) throw CryptoException('发送者密钥已轮换，需要重新分发');
  if (iteration > st.iteration + maxChainAdvance) throw CryptoException('消息序号跳跃过大，拒绝处理');
  if (iteration < st.iteration) throw CryptoException('群消息序号已过期（v1 不支持群内乱序补齐）');

  var ck = fromB64(st.chainKey);
  Bytes mk = Uint8List(0);
  for (var i = st.iteration; i <= iteration; i++) {
    final r = _ratchetChain(ck);
    ck = r.chainKey;
    mk = r.mk;
  }
  // 先解密成功再推进链：伪造的密文（例如别的群成员冒充 owner、把序号填得很大）不能把链推坏
  final pt = await aeadOpen(mk, ct, _groupAad(st.groupId, st.ownerUser, st.ownerDevice, st.keyId, iteration));
  st.chainKey = toB64(ck);
  st.iteration = iteration + 1;
  return pt;
}
