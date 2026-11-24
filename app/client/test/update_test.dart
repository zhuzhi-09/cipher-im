import 'package:cipherim/update.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('版本号比较', () {
    expect(compareVersions('v0.2.0', '0.1.0'), 1);
    expect(compareVersions('0.1.0', 'v0.1.0'), 0);
    expect(compareVersions('0.1.9', '0.1.10'), -1);
    expect(compareVersions('1.0', '0.9.9'), 1);
    expect(compareVersions('v1.2.3-beta', '1.2.3'), 0);
    expect(compareVersions('0.1.0+5', '0.1.0'), 0);
  });

  test('从 releases/latest 的跳转地址取标签', () {
    expect(tagFromLatestRedirect('https://github.com/zhuzhi-09/cipher-im/releases/tag/v0.2.0'), 'v0.2.0');
    expect(tagFromLatestRedirect('https://github.com/zhuzhi-09/cipher-im/releases'), isNull);
  });
}
