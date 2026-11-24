import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as c;

/// 所有随机数都从这里取：生产用系统安全随机数，测试时换成确定性流以便逐字节对照。
abstract class RandomSource {
  Uint8List bytes(int n);
}

class SecureRandomSource implements RandomSource {
  final Random _r = Random.secure();

  @override
  Uint8List bytes(int n) {
    final out = Uint8List(n);
    for (var i = 0; i < n; i++) {
      out[i] = _r.nextInt(256);
    }
    return out;
  }
}

/// 测试数据用的确定性随机数，规格见 spec/vectors/README.md：
/// block(i) = SHA-256(utf8("CipherIM-test-rng-v1|" + label) || u32be(i))，流式按顺序取字节。
class TestRandomSource implements RandomSource {
  TestRandomSource(String label) {
    reset(label);
  }

  late Uint8List _prefix;
  int _counter = 0;
  Uint8List _pool = Uint8List(0);

  void reset(String label) {
    _prefix = Uint8List.fromList(utf8.encode('CipherIM-test-rng-v1|$label'));
    _counter = 0;
    _pool = Uint8List(0);
  }

  Uint8List _nextBlock() {
    final buf = Uint8List(_prefix.length + 4)..setAll(0, _prefix);
    ByteData.sublistView(buf).setUint32(_prefix.length, _counter);
    _counter++;
    return Uint8List.fromList(c.sha256.convert(buf).bytes);
  }

  @override
  Uint8List bytes(int n) {
    final out = Uint8List(n);
    var off = 0;
    while (off < n) {
      if (_pool.isEmpty) _pool = _nextBlock();
      final take = min(_pool.length, n - off);
      out.setRange(off, off + take, _pool);
      _pool = Uint8List.sublistView(_pool, take);
      off += take;
    }
    return out;
  }
}

/// 全局随机数来源。只有测试可以替换它。
RandomSource cryptoRandom = SecureRandomSource();

Uint8List randomBytes(int n) => cryptoRandom.bytes(n);
