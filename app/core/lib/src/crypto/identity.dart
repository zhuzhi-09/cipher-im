/// 身份密钥与预密钥（对应 Web 端 identity.ts）
///  - IK_sig：Ed25519 长期签名密钥；IK_dh：X25519 长期 DH 密钥（由签名种子确定派生）
///  - SPK：由 IK_sig 签名的中期 X25519 密钥；OPK：一次性 X25519 密钥池
library;

import 'primitives.dart';
import 'random.dart';

final spkDomain = utf8Bytes('CipherIM-SPK-v1');

class Identity {
  Identity({required this.sigSeed, required this.dhPriv, required this.ikSigPub, required this.ikDhPub});
  final Bytes sigSeed;
  final Bytes dhPriv;
  final Bytes ikSigPub;
  final Bytes ikDhPub;

  Map<String, dynamic> toJson() => {
    'sigSeed': toB64(sigSeed),
    'dhPriv': toB64(dhPriv),
    'ikSigPub': toB64(ikSigPub),
    'ikDhPub': toB64(ikDhPub),
  };

  factory Identity.fromJson(Map<String, dynamic> j) => Identity(
    sigSeed: fromB64(j['sigSeed']),
    dhPriv: fromB64(j['dhPriv']),
    ikSigPub: fromB64(j['ikSigPub']),
    ikDhPub: fromB64(j['ikDhPub']),
  );
}

class PreKeyPair {
  PreKeyPair({required this.id, required this.priv, required this.pub});
  final String id;
  final Bytes priv;
  final Bytes pub;

  Map<String, dynamic> toJson() => {'id': id, 'priv': toB64(priv), 'pub': toB64(pub)};
  factory PreKeyPair.fromJson(Map<String, dynamic> j) =>
      PreKeyPair(id: j['id'], priv: fromB64(j['priv']), pub: fromB64(j['pub']));
}

class SpkPair extends PreKeyPair {
  SpkPair({required super.id, required super.priv, required super.pub, required this.sig});
  final Bytes sig;

  @override
  Map<String, dynamic> toJson() => {...super.toJson(), 'sig': toB64(sig)};
  factory SpkPair.fromJson(Map<String, dynamic> j) =>
      SpkPair(id: j['id'], priv: fromB64(j['priv']), pub: fromB64(j['pub']), sig: fromB64(j['sig']));
}

class DeviceKeys {
  DeviceKeys({required this.identity, required this.spk, required this.opks});
  final Identity identity;
  final SpkPair spk;
  List<PreKeyPair> opks;

  Map<String, dynamic> toJson() => {
    'identity': identity.toJson(),
    'spk': spk.toJson(),
    'opks': opks.map((o) => o.toJson()).toList(),
  };

  factory DeviceKeys.fromJson(Map<String, dynamic> j) => DeviceKeys(
    identity: Identity.fromJson(j['identity']),
    spk: SpkPair.fromJson(j['spk']),
    opks: (j['opks'] as List).map((o) => PreKeyPair.fromJson(o)).toList(),
  );
}

/// 服务端分发的公开预密钥包（字段与线协议一致）
class PublicBundle {
  PublicBundle({
    required this.ikSigPub,
    required this.ikDhPub,
    required this.spkId,
    required this.spkPub,
    required this.spkSig,
    required this.opks,
  });
  final String ikSigPub;
  final String ikDhPub;
  final String spkId;
  final String spkPub;
  final String spkSig;
  final List<({String id, String pub})> opks;

  Map<String, dynamic> toJson() => {
    'ikSigPub': ikSigPub,
    'ikDhPub': ikDhPub,
    'spkId': spkId,
    'spkPub': spkPub,
    'spkSig': spkSig,
    'opks': opks.map((o) => {'id': o.id, 'pub': o.pub}).toList(),
  };

  factory PublicBundle.fromJson(Map<String, dynamic> j) => PublicBundle(
    ikSigPub: j['ikSigPub'],
    ikDhPub: j['ikDhPub'],
    spkId: j['spkId'],
    spkPub: j['spkPub'],
    spkSig: j['spkSig'],
    opks: [for (final o in (j['opks'] as List? ?? const [])) (id: o['id'] as String, pub: o['pub'] as String)],
  );
}

/// 从 Ed25519 种子确定派生 X25519 私钥
Bytes deriveDhPrivate(Bytes seed) => sha256(concat([seed, utf8Bytes('CipherIM-dh-derive-v1')]));

Future<Identity> createIdentity() async {
  final sigSeed = randomBytes(32);
  final dhPriv = deriveDhPrivate(sigSeed);
  return Identity(
    sigSeed: sigSeed,
    dhPriv: dhPriv,
    ikSigPub: await sigPub(sigSeed),
    ikDhPub: await dhPubFromPriv(dhPriv),
  );
}

Future<SpkPair> createSpk(Identity identity) async {
  // 顺序与 Web 端一致：先生成密钥对，再生成 id
  final kp = await genDh();
  final id = toB64(randomBytes(6));
  return SpkPair(id: id, priv: kp.priv, pub: kp.pub, sig: await sign(identity.sigSeed, concat([spkDomain, kp.pub])));
}

Future<List<PreKeyPair>> createOpks(int n) async {
  final out = <PreKeyPair>[];
  for (var i = 0; i < n; i++) {
    final kp = await genDh();
    out.add(PreKeyPair(id: toB64(randomBytes(6)), priv: kp.priv, pub: kp.pub));
  }
  return out;
}

Future<DeviceKeys> createDeviceKeys([int opkN = 24]) async {
  final identity = await createIdentity();
  final spk = await createSpk(identity);
  final opks = await createOpks(opkN);
  return DeviceKeys(identity: identity, spk: spk, opks: opks);
}

PublicBundle publicBundleOf(DeviceKeys k) => PublicBundle(
  ikSigPub: toB64(k.identity.ikSigPub),
  ikDhPub: toB64(k.identity.ikDhPub),
  spkId: k.spk.id,
  spkPub: toB64(k.spk.pub),
  spkSig: toB64(k.spk.sig),
  opks: [for (final o in k.opks) (id: o.id, pub: toB64(o.pub))],
);

Future<bool> verifyBundle(PublicBundle b) async {
  try {
    return await verify(fromB64(b.ikSigPub), concat([spkDomain, fromB64(b.spkPub)]), fromB64(b.spkSig));
  } catch (_) {
    return false;
  }
}
