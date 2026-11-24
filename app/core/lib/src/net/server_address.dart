/// 服务器地址：客户端不内置任何服务器，必须由用户填写并校验（约定见 docs/CLIENT.md）
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// 客户端支持的服务端协议版本（服务端 /api/health 的 protocol 字段）
const supportedProtocols = {1};

class ServerAddressException implements Exception {
  ServerAddressException(this.message);
  final String message;
  @override
  String toString() => message;
}

const _loopbackHosts = {'localhost', '127.0.0.1', '::1'};

/// 把用户输入规范化成服务器根地址：只填域名时补 https://，去掉末尾的 /。
/// 只有本机地址允许 http://；带路径、查询串、账号密码的地址一律拒绝。
Uri normalizeServerAddress(String input) {
  var s = input.trim();
  if (s.isEmpty) throw ServerAddressException('请填写服务器地址');
  if (!s.contains('://')) s = 'https://$s';
  final Uri u;
  try {
    u = Uri.parse(s);
  } on FormatException {
    throw ServerAddressException('地址格式不对');
  }
  if (u.scheme != 'https' && u.scheme != 'http') throw ServerAddressException('只支持 https:// 地址');
  if (u.host.isEmpty) throw ServerAddressException('地址里没有域名');
  if (u.userInfo.isNotEmpty) throw ServerAddressException('地址里不能带用户名或密码');
  if (u.hasQuery || u.hasFragment) throw ServerAddressException('地址里不能带 ? 或 # 后面的内容');
  if (u.path.isNotEmpty && u.path != '/') throw ServerAddressException('只填服务器地址，不要带路径');
  if (u.scheme == 'http' && !_loopbackHosts.contains(u.host)) {
    throw ServerAddressException('必须使用 https://（只有本机调试地址可以用 http://）');
  }
  return Uri(scheme: u.scheme, host: u.host, port: u.hasPort ? u.port : null);
}

class ServerInfo {
  ServerInfo({required this.base, required this.protocol, required this.retentionDays});
  final Uri base;
  final int protocol;
  final int retentionDays;
}

/// 访问 /api/health，确认对方确实是 Cipher IM 服务器、协议版本对得上
Future<ServerInfo> checkServer(Uri base, {Duration timeout = const Duration(seconds: 10), HttpClient? client}) async {
  final http = client ?? HttpClient();
  http.connectionTimeout = timeout;
  try {
    final req = await http.getUrl(base.replace(path: '/api/health')).timeout(timeout);
    final res = await req.close().timeout(timeout);
    final text = await res.transform(utf8.decoder).join().timeout(timeout);
    if (res.statusCode != 200) throw ServerAddressException('服务器返回了 ${res.statusCode}，不是 Cipher IM 服务器');
    final Object? j;
    try {
      j = jsonDecode(text);
    } on FormatException {
      throw ServerAddressException('这不是 Cipher IM 服务器');
    }
    if (j is! Map || j['service'] != 'cipher-im') throw ServerAddressException('这不是 Cipher IM 服务器');
    final protocol = j['protocol'];
    if (protocol is! int || !supportedProtocols.contains(protocol)) {
      throw ServerAddressException('服务器协议版本（$protocol）和客户端不兼容，请升级客户端或服务器');
    }
    return ServerInfo(base: base, protocol: protocol, retentionDays: (j['retentionDays'] as num?)?.toInt() ?? 14);
  } on ServerAddressException {
    rethrow;
  } on HandshakeException {
    throw ServerAddressException('HTTPS 证书校验失败');
  } on TimeoutException {
    throw ServerAddressException('连接超时');
  } on SocketException catch (e) {
    throw ServerAddressException('连不上服务器：${e.osError?.message ?? e.message}');
  } finally {
    if (client == null) http.close(force: true);
  }
}
