/// 线格式里的密文信封（对应 Web 端 protocol.ts 的 WireBody）
/// 服务端只经手这一层；字段名和键顺序与 Web 端保持一致。
library;

import '../crypto/ratchet.dart';

sealed class WireBody {
  const WireBody();
  Map<String, dynamic> toJson();

  static WireBody fromJson(Map<String, dynamic> j) => switch (j['kind']) {
    'msg' => MsgBody.fromJson(j),
    'prekey' => PreKeyBody.fromJson(j),
    'group' => GroupBody.fromJson(j),
    final k => throw FormatException('未知信封类型：$k'),
  };
}

class MsgBody extends WireBody {
  const MsgBody({required this.header, required this.ct});
  final RatchetHeader header;
  final String ct;

  @override
  Map<String, dynamic> toJson() => {'kind': 'msg', 'header': header.toJson(), 'ct': ct};
  factory MsgBody.fromJson(Map<String, dynamic> j) =>
      MsgBody(header: RatchetHeader.fromJson(j['header']), ct: j['ct'] as String);
}

class PreKeyBody extends WireBody {
  const PreKeyBody({
    required this.ikSigPub,
    required this.ikDhPub,
    required this.ekPub,
    required this.spkId,
    required this.opkId,
    required this.header,
    required this.ct,
  });
  final String ikSigPub;
  final String ikDhPub;
  final String ekPub;
  final String spkId;
  final String? opkId;
  final RatchetHeader header;
  final String ct;

  @override
  Map<String, dynamic> toJson() => {
    'kind': 'prekey',
    'ikSigPub': ikSigPub,
    'ikDhPub': ikDhPub,
    'ekPub': ekPub,
    'spkId': spkId,
    'opkId': opkId,
    'header': header.toJson(),
    'ct': ct,
  };
  factory PreKeyBody.fromJson(Map<String, dynamic> j) => PreKeyBody(
    ikSigPub: j['ikSigPub'],
    ikDhPub: j['ikDhPub'],
    ekPub: j['ekPub'],
    spkId: j['spkId'],
    opkId: j['opkId'],
    header: RatchetHeader.fromJson(j['header']),
    ct: j['ct'],
  );
}

class GroupBody extends WireBody {
  const GroupBody({
    required this.groupId,
    required this.ownerUser,
    required this.ownerDevice,
    required this.keyId,
    required this.iteration,
    required this.ct,
  });
  final String groupId;
  final String ownerUser;
  final String ownerDevice;
  final String keyId;
  final int iteration;
  final String ct;

  @override
  Map<String, dynamic> toJson() => {
    'kind': 'group',
    'groupId': groupId,
    'ownerUser': ownerUser,
    'ownerDevice': ownerDevice,
    'keyId': keyId,
    'iteration': iteration,
    'ct': ct,
  };
  factory GroupBody.fromJson(Map<String, dynamic> j) => GroupBody(
    groupId: j['groupId'],
    ownerUser: j['ownerUser'],
    ownerDevice: j['ownerDevice'],
    keyId: j['keyId'],
    iteration: (j['iteration'] as num).toInt(),
    ct: j['ct'],
  );
}
