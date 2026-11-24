/// 安全码与短指纹（对应 Web 端 fingerprint.ts）
library;

import 'primitives.dart';

/// 60 位安全码：对排序后的双方 IK_sig 做两轮域分离哈希，各取 30 字节渲染成 6 组 5 位数字
String safetyNumber(Bytes ikSigA, Bytes ikSigB) {
  final aHex = toHex(ikSigA);
  final bHex = toHex(ikSigB);
  final aFirst = aHex.compareTo(bHex) < 0;
  final first = aFirst ? ikSigA : ikSigB;
  final second = aFirst ? ikSigB : ikSigA;

  final digits = StringBuffer();
  for (final round in const ['v1', 'v2']) {
    final digest = sha256(concat([utf8Bytes('CipherIM-SafetyNumber-$round'), first, second]));
    for (var i = 0; i < 30; i += 5) {
      var v = 0;
      for (var j = 0; j < 5; j++) {
        v = v * 256 + digest[i + j];
      }
      digits.write((v % 100000).toString().padLeft(5, '0'));
    }
  }
  return digits.toString();
}

List<String> formatSafetyNumber(String s) => [
  for (var i = 0; i < s.length; i += 5) s.substring(i, i + 5 > s.length ? s.length : i + 5),
];

String shortFingerprint(Bytes ikSig) => toHex(sha256(ikSig).sublist(0, 4)).toUpperCase();
