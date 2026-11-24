/// 服务端 HTTP 接口（对应 Web 端 api.ts 的 http 部分）
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import '../crypto/identity.dart';

class ApiException implements Exception {
  ApiException(this.status, this.message);
  final int status;
  final String message;
  @override
  String toString() => message;
}

/// 注册 / 登录时上传的公开预密钥包：PublicBundle 加上设备号
Map<String, dynamic> registrationBundle(DeviceKeys keys, String deviceId) => {
  ...publicBundleOf(keys).toJson(),
  'device': deviceId,
};

class Api {
  Api(this.base, {HttpClient? client, this.timeout = const Duration(seconds: 20)}) : _http = client ?? HttpClient();

  final Uri base;
  final Duration timeout;
  final HttpClient _http;

  void close() => _http.close(force: true);

  Future<Map<String, dynamic>> _call(
    String method,
    String path, {
    Object? body,
    String? token,
    Map<String, String>? query,
  }) async {
    try {
      final req = await _http.openUrl(method, base.replace(path: path, queryParameters: query)).timeout(timeout);
      if (token != null) req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      if (body != null) {
        req.headers.contentType = ContentType.json;
        req.add(utf8.encode(jsonEncode(body)));
      }
      final res = await req.close().timeout(timeout);
      final text = await res.transform(utf8.decoder).join().timeout(timeout);
      Map<String, dynamic> j = const {};
      try {
        final parsed = jsonDecode(text);
        if (parsed is Map<String, dynamic>) j = parsed;
      } on FormatException {
        // 非 JSON 响应（比如反代返回的 502 页面）
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw ApiException(res.statusCode, (j['error'] as String?) ?? '请求失败（${res.statusCode}）');
      }
      return j;
    } on TimeoutException {
      throw ApiException(0, '请求超时');
    } on SocketException catch (e) {
      throw ApiException(0, '网络错误：${e.osError?.message ?? e.message}');
    }
  }

  /* ---- 账号 ---- */

  Future<({String token, String username, String displayName, String device})> register({
    required String username,
    required String displayName,
    required String password,
    required Map<String, dynamic> bundle,
    required String invite,
  }) async {
    final j = await _call(
      'POST',
      '/api/register',
      body: {
        'username': username,
        'displayName': displayName,
        'password': password,
        'bundle': bundle,
        'invite': invite,
      },
    );
    final u = j['user'] as Map<String, dynamic>;
    return (
      token: j['token'] as String,
      username: u['username'] as String,
      displayName: u['displayName'] as String,
      device: j['device'] as String,
    );
  }

  /// 登录拿到的是「账号级」临时令牌，必须再用 [addDevice] 登记本机密钥，换成绑定设备的令牌
  Future<({String token, String displayName, List<String> devices})> login(String username, String password) async {
    final j = await _call('POST', '/api/login', body: {'username': username, 'password': password});
    return (
      token: j['token'] as String,
      displayName: (j['user'] as Map)['displayName'] as String,
      devices: List<String>.from(j['devices'] as List? ?? const []),
    );
  }

  Future<({String token, String device, int opkStock})> addDevice(String token, Map<String, dynamic> bundle) async {
    final j = await _call('POST', '/api/device', body: {'bundle': bundle}, token: token);
    return (token: j['token'] as String, device: j['device'] as String, opkStock: (j['opkStock'] as num).toInt());
  }

  Future<int> topUpOpks(String token, Map<String, dynamic> bundle) async {
    final j = await _call('POST', '/api/opk', body: {'bundle': bundle}, token: token);
    return (j['opkStock'] as num).toInt();
  }

  /* ---- 跨设备漫游 ---- */

  Future<void> roamInit(String token, {required String pub, required String salt, required String sealed}) =>
      _call('POST', '/api/roam/init', body: {'pub': pub, 'salt': salt, 'sealed': sealed}, token: token);

  Future<({String pub, String salt, String sealed})> roamKey(String token) async {
    final j = await _call('GET', '/api/roam/key', token: token);
    return (pub: j['pub'] as String, salt: j['salt'] as String, sealed: j['sealed'] as String);
  }

  Future<List<({String device, int addedAt})>> roamDevices(String token) async {
    final j = await _call('GET', '/api/roam/devices', token: token);
    return [
      for (final d in j['devices'] as List) (device: d['device'] as String, addedAt: (d['added_at'] as num).toInt()),
    ];
  }

  Future<bool> roamRevoke(String token, String device) async {
    final j = await _call('POST', '/api/roam/revoke', body: {'device': device}, token: token);
    return j['revoked'] == true;
  }

  Future<String> roamPub(String token, String user) async {
    final j = await _call('GET', '/api/roam/pub', token: token, query: {'user': user});
    return j['pub'] as String;
  }

  /* ---- 文件密文 ---- */

  Future<({String id, int size})> putBlob(String token, Uint8List ciphertext, String mime) async {
    try {
      final req = await _http.openUrl('PUT', base.replace(path: '/api/blob')).timeout(timeout);
      req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      req.headers.set('x-file-mime', mime.isEmpty ? 'application/octet-stream' : mime);
      req.contentLength = ciphertext.length;
      req.add(ciphertext);
      final res = await req.close();
      final j = jsonDecode(await res.transform(utf8.decoder).join()) as Map<String, dynamic>;
      if (res.statusCode != 200) throw ApiException(res.statusCode, (j['error'] as String?) ?? '上传失败');
      return (id: j['id'] as String, size: (j['size'] as num).toInt());
    } on SocketException catch (e) {
      throw ApiException(0, '网络错误：${e.osError?.message ?? e.message}');
    }
  }

  Future<Uint8List> getBlob(String token, String id) async {
    try {
      final req = await _http.openUrl('GET', base.replace(path: '/api/blob/$id')).timeout(timeout);
      req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      final res = await req.close();
      final b = BytesBuilder(copy: false);
      await for (final chunk in res) {
        b.add(chunk);
      }
      if (res.statusCode != 200) throw ApiException(res.statusCode, '文件下载失败');
      return b.toBytes();
    } on SocketException catch (e) {
      throw ApiException(0, '网络错误：${e.osError?.message ?? e.message}');
    }
  }
}
