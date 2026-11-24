/// X3DH 密钥协商（对应 Web 端 x3dh.ts）
///   DH1 = DH(IK_A, SPK_B)  DH2 = DH(EK_A, IK_B)  DH3 = DH(EK_A, SPK_B)  DH4 = DH(EK_A, OPK_B)（可无）
///   SK = HKDF(DH1||DH2||DH3||DH4, salt=0^32, "CipherIM-X3DH-v1")；AD = IK_A_dh || IK_B_dh
library;

import 'dart:typed_data';

import 'identity.dart';
import 'primitives.dart';

final _zeroSalt = Uint8List(32);
const _info = 'CipherIM-X3DH-v1';

class X3dhInitResult {
  X3dhInitResult({
    required this.sk,
    required this.ad,
    required this.ekPriv,
    required this.ekPub,
    required this.spkId,
    required this.opkId,
  });
  final Bytes sk;
  final Bytes ad;
  final Bytes ekPriv;
  final Bytes ekPub;
  final String spkId;
  final String? opkId;
}

Future<X3dhInitResult> x3dhInitiate(Identity self, PublicBundle peer) async {
  if (!await verifyBundle(peer)) throw CryptoException('对端预密钥包签名无效，可能被中间人篡改');
  final spk = fromB64(peer.spkPub);
  final ikDhB = fromB64(peer.ikDhPub);
  final ek = await genDh();

  final dh1 = await dh(self.dhPriv, spk);
  final dh2 = await dh(ek.priv, ikDhB);
  final dh3 = await dh(ek.priv, spk);
  final dh4 = peer.opks.isNotEmpty ? await dh(ek.priv, fromB64(peer.opks.first.pub)) : Uint8List(0);

  return X3dhInitResult(
    sk: hkdf(concat([dh1, dh2, dh3, dh4]), _zeroSalt, _info, 32),
    ad: concat([self.ikDhPub, ikDhB]),
    ekPriv: ek.priv,
    ekPub: ek.pub,
    spkId: peer.spkId,
    opkId: peer.opks.isNotEmpty ? peer.opks.first.id : null,
  );
}

Future<({Bytes sk, Bytes ad})> x3dhRespond({
  required Bytes selfDhPriv,
  required Bytes selfIkDhPub,
  required Bytes spkPriv,
  required Bytes? opkPriv,
  required Bytes initiatorIkDhPub,
  required Bytes initiatorEkPub,
}) async {
  final dh1 = await dh(spkPriv, initiatorIkDhPub);
  final dh2 = await dh(selfDhPriv, initiatorEkPub);
  final dh3 = await dh(spkPriv, initiatorEkPub);
  final dh4 = opkPriv != null ? await dh(opkPriv, initiatorEkPub) : Uint8List(0);
  return (sk: hkdf(concat([dh1, dh2, dh3, dh4]), _zeroSalt, _info, 32), ad: concat([initiatorIkDhPub, selfIkDhPub]));
}
