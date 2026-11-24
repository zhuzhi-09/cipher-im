/// 实时连接（对应 Web 端 api.ts 的 Link）：WebSocket，首帧认证，断线自动重连
///
/// 原生客户端常驻后台，比网页更依赖这条连接：
///  - 定时 ping，半死的连接（NAT 超时、换网络）能尽快发现并重连
///  - 令牌失效这类致命错误不再重连，交给上层处理（重新登录）
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

enum LinkStatus { connecting, online, offline }

class LinkFatalError {
  LinkFatalError(this.message);
  final String message;
  @override
  String toString() => message;
}

class Link {
  Link({
    required this.base,
    required this.token,
    required this.deviceId,
    this.pingInterval = const Duration(seconds: 25),
    this.maxBackoff = const Duration(seconds: 30),
  });

  final Uri base;
  final String token;
  final String deviceId;
  final Duration pingInterval;
  final Duration maxBackoff;

  WebSocket? _ws;
  LinkStatus _status = LinkStatus.offline;
  bool _closedByUs = false;
  bool _ready = false;
  int _retry = 0;
  Timer? _retryTimer;
  bool _visible = false;
  final List<String> _queue = [];

  final _messages = StreamController<Map<String, dynamic>>.broadcast();
  final _statuses = StreamController<LinkStatus>.broadcast();
  final _fatal = StreamController<LinkFatalError>.broadcast();

  /// 服务端推来的每一条报文（ready / msg / sent / convs / error …）
  Stream<Map<String, dynamic>> get messages => _messages.stream;
  Stream<LinkStatus> get statuses => _statuses.stream;

  /// 令牌失效等致命错误：连接不会再自动重连
  Stream<LinkFatalError> get fatal => _fatal.stream;
  LinkStatus get status => _status;

  Uri get _wsUrl => base.replace(scheme: base.scheme == 'https' ? 'wss' : 'ws', path: '/ws');

  void _setStatus(LinkStatus s) {
    if (_status == s) return;
    _status = s;
    _statuses.add(s);
  }

  Future<void> connect() async {
    _closedByUs = false;
    _retryTimer?.cancel();
    _setStatus(LinkStatus.connecting);
    final WebSocket ws;
    try {
      ws = await WebSocket.connect(_wsUrl.toString()).timeout(const Duration(seconds: 15));
    } catch (_) {
      _scheduleReconnect();
      return;
    }
    if (_closedByUs) {
      await ws.close();
      return;
    }
    _ws = ws;
    _ready = false;
    ws.pingInterval = pingInterval;
    // 令牌放首帧而不是 URL：反代的访问日志会把查询串原样记下来
    ws.add(jsonEncode({'t': 'auth', 'token': token}));
    ws.add(jsonEncode({'t': 'hello', 'device': deviceId}));
    ws.listen((data) => _onFrame(data), onDone: _onClosed, onError: (_) => _onClosed(), cancelOnError: true);
  }

  void _onFrame(Object? data) {
    if (data is! String) return;
    final Map<String, dynamic> m;
    try {
      final parsed = jsonDecode(data);
      if (parsed is! Map<String, dynamic>) return;
      m = parsed;
    } on FormatException {
      return;
    }
    switch (m['t']) {
      case 'ready':
        _retry = 0;
        _ready = true;
        _setStatus(LinkStatus.online);
        _rawSend({'t': 'presence', 'visible': _visible});
        while (_queue.isNotEmpty && _ws != null) {
          _ws!.add(_queue.removeAt(0));
        }
      case 'error':
        final msg = (m['message'] as String?) ?? '';
        if (msg.contains('令牌') || msg.contains('绑定设备') || msg.contains('设备与令牌不匹配')) {
          _closedByUs = true;
          _fatal.add(LinkFatalError(msg));
        }
    }
    _messages.add(m);
  }

  void _onClosed() {
    _ws = null;
    _ready = false;
    _setStatus(LinkStatus.offline);
    if (!_closedByUs) _scheduleReconnect();
  }

  void _scheduleReconnect() {
    _setStatus(LinkStatus.offline);
    if (_closedByUs) return;
    final ms = min(1000 * pow(2, _retry).toInt(), maxBackoff.inMilliseconds);
    _retry = min(_retry + 1, 16);
    _retryTimer?.cancel();
    _retryTimer = Timer(Duration(milliseconds: ms), connect);
  }

  bool _rawSend(Map<String, dynamic> m) {
    final ws = _ws;
    if (ws == null || !_ready) return false;
    ws.add(jsonEncode(m));
    return true;
  }

  /// 发送一条指令；没连上时先排队（最多 50 条），连上后按顺序补发
  void send(Map<String, dynamic> m) {
    if (!_rawSend(m) && _queue.length < 50) _queue.add(jsonEncode(m));
  }

  /// 告诉服务端界面是否在前台：不在前台时服务端会额外走 Web Push（原生客户端一般不订阅，影响不大）
  void setVisible(bool visible) {
    if (_visible == visible) return;
    _visible = visible;
    _rawSend({'t': 'presence', 'visible': visible});
  }

  /// 网络恢复时可以立刻重连，不用等退避计时器
  void reconnectNow() {
    if (_closedByUs || _ws != null) return;
    _retry = 0;
    connect();
  }

  Future<void> close() async {
    _closedByUs = true;
    _retryTimer?.cancel();
    final ws = _ws;
    _ws = null;
    await ws?.close();
    _setStatus(LinkStatus.offline);
  }

  Future<void> dispose() async {
    await close();
    await _messages.close();
    await _statuses.close();
    await _fatal.close();
  }
}
