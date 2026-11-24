import 'dart:async';
import 'dart:io';

import 'package:dynamic_color/dynamic_color.dart';
import 'package:flutter/material.dart';

import 'platform.dart';
import 'service.dart';
import 'ui/home.dart';
import 'ui/setup.dart';
import 'vault.dart';

Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();
  final store = await VaultStore.open();
  Vault? vault;
  String? loadError;
  try {
    vault = await store.load();
  } catch (e) {
    loadError = '本机密钥库打不开（$e）。可以退出账号后重新登录。';
  }
  final notifier = Notifier();
  await notifier.init();
  runApp(CipherApp(store: store, initial: vault, loadError: loadError, notifier: notifier, startHidden: args.contains('--hidden')));
}

class CipherApp extends StatefulWidget {
  const CipherApp({
    super.key,
    required this.store,
    required this.initial,
    required this.loadError,
    required this.notifier,
    required this.startHidden,
  });

  final VaultStore store;
  final Vault? initial;
  final String? loadError;
  final Notifier notifier;
  final bool startHidden;

  @override
  State<CipherApp> createState() => _CipherAppState();
}

class _CipherAppState extends State<CipherApp> with WidgetsBindingObserver {
  ChatService? _svc;
  DesktopShell? _shell;
  final _navKey = GlobalKey<NavigatorState>();
  String? _loadError;

  @override
  void initState() {
    super.initState();
    _loadError = widget.loadError;
    WidgetsBinding.instance.addObserver(this);
    widget.notifier.onOpen = _openFromNotification;
    if (isDesktop) {
      _shell = DesktopShell(
        onFocusChange: (f) => _svc?.setVisible(f),
        onQuit: () async => _svc?.shutdown(),
      );
      unawaited(_shell!.init(startHidden: widget.startHidden));
    }
    final v = widget.initial;
    if (v != null) _attach(v);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// 手机上切到后台 / 回到前台
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (isDesktop) return;
    _svc?.setVisible(state == AppLifecycleState.resumed);
    if (state == AppLifecycleState.paused) {
      final s = _svc;
      if (s != null) unawaited(widget.store.save(s.vault));
    }
  }

  void _attach(Vault v) {
    final s = ChatService(v, widget.store);
    s.onNotify = (conv, msg, sender) {
      final title = conv.isGroup ? '$sender · ${s.titleOf(conv)}' : sender;
      final body = !v.notifyPreview
          ? '你有新消息'
          : switch (msg.type) {
              'text' => msg.payload['text'] as String? ?? '',
              'file' => '[文件] ${msg.payload['name'] ?? ''}',
              _ => '新消息',
            };
      widget.notifier.show(conv.id, title, body);
    };
    s.addListener(() => _shell?.setUnread(s.totalUnread));
    if (Platform.isWindows && widget.startHidden) s.appVisible = false;
    s.start();
    setState(() => _svc = s);
  }

  Future<void> _onSignedIn(Vault v) async {
    await widget.store.save(v);
    _attach(v);
  }

  Future<void> _logout() async {
    final s = _svc;
    if (s != null) {
      await s.logout();
    } else {
      await widget.store.wipe();
    }
    setState(() {
      _svc = null;
      _loadError = null;
    });
  }

  void _openFromNotification(int conv) {
    _shell?.showWindow();
    final s = _svc;
    if (s == null) return;
    widget.notifier.clear(conv);
    HomeScreen.openConvRequest.value = conv;
  }

  @override
  Widget build(BuildContext context) {
    // 标准 Material 3：有系统动态取色（安卓 12+ 壁纸色、Windows 强调色）就用，没有就用图标上的蓝
    return DynamicColorBuilder(
      builder: (light, dark) => MaterialApp(
        title: 'Cipher IM',
        navigatorKey: _navKey,
        debugShowCheckedModeBanner: false,
        theme: _theme(light, Brightness.light),
        darkTheme: _theme(dark, Brightness.dark),
        home: _home(),
      ),
    );
  }

  static const _brand = Color(0xFF6E9CFF);

  ThemeData _theme(ColorScheme? dynamicScheme, Brightness b) {
    final scheme = dynamicScheme?.harmonized() ?? ColorScheme.fromSeed(seedColor: _brand, brightness: b);
    return ThemeData(
      colorScheme: scheme,
      useMaterial3: true,
      snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating),
    );
  }

  Widget _home() {
    final s = _svc;
    if (s != null) return HomeScreen(svc: s, onLogout: _logout);
    if (_loadError != null) {
      return Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(_loadError!, textAlign: TextAlign.center),
                const SizedBox(height: 16),
                FilledButton(onPressed: _logout, child: const Text('退出账号，重新登录')),
              ],
            ),
          ),
        ),
      );
    }
    return SetupScreen(onSignedIn: _onSignedIn);
  }
}
