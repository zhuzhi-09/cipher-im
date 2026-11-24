/// 检查更新：看 GitHub 上最新的正式版本，比本机新就提示去下载
///
/// 这是客户端除了你自己的服务器之外唯一会访问的外部地址（github.com），
/// 设置里可以关掉自动检查。
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';

/// 版本号由 CI 写入：flutter build ... --dart-define=APP_VERSION=1.2.3
const appVersion = String.fromEnvironment('APP_VERSION', defaultValue: '0.1.0');

const releasesRepo = 'zhuzhi-09/cipher-im';
const releasesPage = 'https://github.com/$releasesRepo/releases';

class UpdateInfo {
  UpdateInfo({required this.version, required this.pageUrl, this.assetUrl, this.assetName});
  final String version;

  /// 发布页（有更新说明）
  final String pageUrl;

  /// 本平台安装包的直链（Windows 的 zip / 安卓的 apk）
  final String? assetUrl;
  final String? assetName;
}

/// 比较 1.2.3 这样的版本号；开头的 v 和 -xxx / +xxx 后缀忽略
int compareVersions(String a, String b) {
  List<int> parts(String v) => v
      .replaceFirst(RegExp(r'^v'), '')
      .split(RegExp(r'[-+]'))
      .first
      .split('.')
      .map((s) => int.tryParse(s) ?? 0)
      .toList();
  final x = parts(a), y = parts(b);
  for (var i = 0; i < 3; i++) {
    final d = (i < x.length ? x[i] : 0) - (i < y.length ? y[i] : 0);
    if (d != 0) return d.sign;
  }
  return 0;
}

/// 本平台的安装包文件名（和 .github/workflows/client.yml 里发布的一致）
String? get platformAssetName =>
    Platform.isAndroid ? 'CipherIM-android.apk' : (Platform.isWindows ? 'CipherIM-windows-x64.zip' : null);

/// 从 /releases/latest 的跳转地址里取出标签；没有正式版时跳到发布列表页，返回 null
String? tagFromLatestRedirect(String location) {
  final m = RegExp(r'/releases/tag/([^/?#]+)').firstMatch(location);
  return m == null ? null : Uri.decodeComponent(m.group(1)!);
}

/// 有比本机新的正式版就返回它，没有返回 null；网络出错抛异常
///
/// 不走 api.github.com（匿名每小时 60 次，教室这类共用出口很容易用光）：
/// github.com/<仓库>/releases/latest 会 302 跳到 /releases/tag/<最新标签>，从跳转地址读版本号
Future<UpdateInfo?> checkForUpdate({String current = appVersion}) async {
  final http = HttpClient()..connectionTimeout = const Duration(seconds: 10);
  try {
    final req = await http.getUrl(Uri.parse('$releasesPage/latest'));
    req.followRedirects = false;
    req.headers.set(HttpHeaders.userAgentHeader, 'CipherIM-client');
    final res = await req.close().timeout(const Duration(seconds: 15));
    await res.drain<void>();
    if (!res.isRedirect) throw HttpException('GitHub 返回 ${res.statusCode}');
    final tag = tagFromLatestRedirect(res.headers.value(HttpHeaders.locationHeader) ?? '');
    if (tag == null || compareVersions(tag, current) <= 0) return null;
    final enc = Uri.encodeComponent(tag);
    final asset = platformAssetName;
    return UpdateInfo(
      version: tag.replaceFirst(RegExp(r'^v'), ''),
      pageUrl: '$releasesPage/tag/$enc',
      assetUrl: asset == null ? null : '$releasesPage/download/$enc/$asset',
      assetName: asset,
    );
  } finally {
    http.close(force: true);
  }
}

/// 用系统浏览器打开链接（下载安装包、打开发布页）
Future<void> openUrl(String url) async {
  if (Platform.isWindows) {
    await Process.start('rundll32', ['url.dll,FileProtocolHandler', url]);
  } else if (Platform.isAndroid) {
    await const MethodChannel('cipherim/android').invokeMethod('openUrl', {'url': url});
  } else if (Platform.isMacOS) {
    await Process.start('open', [url]);
  } else if (Platform.isLinux) {
    await Process.start('xdg-open', [url]);
  }
}
