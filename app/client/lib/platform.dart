/// 和平台打交道的部分：系统通知、Windows 托盘、开机自启
library;

import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

bool get isDesktop => Platform.isWindows || Platform.isLinux || Platform.isMacOS;

/* ---------------- 通知 ---------------- */

class Notifier {
  final _plugin = FlutterLocalNotificationsPlugin();
  bool _ready = false;

  /// 点了通知：打开对应会话
  void Function(int conv)? onOpen;

  Future<void> init() async {
    if (!(Platform.isWindows || Platform.isAndroid)) return;
    try {
      await _plugin.initialize(
        settings: const InitializationSettings(
          android: AndroidInitializationSettings('@mipmap/ic_launcher'),
          windows: WindowsInitializationSettings(
            appName: 'Cipher IM',
            appUserModelId: 'io.github.zhuzhi09.CipherIM',
            guid: '7f2c3a0e-5b1d-4c8e-9a6f-3d2e1b0c4a57',
          ),
        ),
        onDidReceiveNotificationResponse: (r) {
          final conv = int.tryParse(r.payload ?? '');
          if (conv != null) onOpen?.call(conv);
        },
      );
      _ready = true;
    } catch (e) {
      debugPrint('通知初始化失败：$e');
    }
  }

  /// 安卓 13+ 要用户点允许才能弹通知。必须在界面（Activity）起来以后调：
  /// 安卓上引擎可能比界面先启动（后台服务把进程拉起来时）
  Future<void> requestPermission() async {
    if (!Platform.isAndroid || !_ready) return;
    try {
      await _plugin
          .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
          ?.requestNotificationsPermission();
    } catch (e) {
      debugPrint('申请通知权限失败：$e');
    }
  }

  /// 同一会话的通知用同一个 id，新的盖掉旧的，不会堆一屏
  Future<void> show(int conv, String title, String body) async {
    if (!_ready) return;
    try {
      await _plugin.show(
        id: conv,
        title: title,
        body: body,
        payload: '$conv',
        notificationDetails: const NotificationDetails(
          android: AndroidNotificationDetails(
            'messages',
            '新消息',
            channelDescription: '收到聊天消息时提醒',
            importance: Importance.high,
            priority: Priority.high,
          ),
          windows: WindowsNotificationDetails(),
        ),
      );
    } catch (e) {
      debugPrint('弹通知失败：$e');
    }
  }

  Future<void> clear(int conv) async {
    if (!_ready) return;
    try {
      await _plugin.cancel(id: conv);
    } catch (_) {}
  }
}

/* ---------------- 安卓后台保持连接 ---------------- */

/// 对应 android/.../CipherApp.kt：前台服务让进程常驻，电池优化白名单防止被省电策略断网
class AndroidBackground {
  static const _ch = MethodChannel('cipherim/android');

  static Future<void> start() async {
    if (!Platform.isAndroid) return;
    try {
      await _ch.invokeMethod('startKeepAlive');
    } catch (e) {
      debugPrint('启动后台服务失败：$e');
    }
  }

  static Future<void> stop() async {
    if (!Platform.isAndroid) return;
    try {
      await _ch.invokeMethod('stopKeepAlive');
    } catch (_) {}
  }

  static Future<bool> ignoringBatteryOptimizations() async {
    if (!Platform.isAndroid) return true;
    try {
      return await _ch.invokeMethod<bool>('ignoringBatteryOptimizations') ?? false;
    } catch (_) {
      return false;
    }
  }

  static Future<void> requestIgnoreBatteryOptimizations() async {
    if (!Platform.isAndroid) return;
    try {
      await _ch.invokeMethod('requestIgnoreBatteryOptimizations');
    } catch (_) {}
  }
}

/* ---------------- 窗口与托盘（桌面） ---------------- */

/// 关窗口 = 藏到托盘，连接保持在线；托盘菜单里「退出」才真正退出
class DesktopShell with TrayListener, WindowListener {
  DesktopShell({required this.onFocusChange, required this.onQuit});

  final void Function(bool focused) onFocusChange;
  final Future<void> Function() onQuit;

  Future<void> init({required bool startHidden}) async {
    await windowManager.ensureInitialized();
    await windowManager.setPreventClose(true);
    windowManager.addListener(this);
    await windowManager.waitUntilReadyToShow(
      const WindowOptions(title: 'Cipher IM', minimumSize: Size(380, 480)),
      () async {
        if (startHidden) {
          await windowManager.hide();
        } else {
          await windowManager.show();
          await windowManager.focus();
        }
      },
    );
    trayManager.addListener(this);
    await trayManager.setIcon('assets/tray.ico');
    await trayManager.setToolTip('Cipher IM');
    await trayManager.setContextMenu(
      Menu(
        items: [
          MenuItem(key: 'show', label: '打开 Cipher IM'),
          MenuItem.separator(),
          MenuItem(key: 'quit', label: '退出'),
        ],
      ),
    );
    if (startHidden) onFocusChange(false);
  }

  Future<void> showWindow() async {
    await windowManager.show();
    await windowManager.restore();
    await windowManager.focus();
  }

  /// 有未读时托盘提示里带上数量
  Future<void> setUnread(int n) async {
    try {
      await trayManager.setToolTip(n > 0 ? 'Cipher IM（$n 条未读）' : 'Cipher IM');
    } catch (_) {}
  }

  @override
  void onWindowClose() async {
    await windowManager.hide();
    onFocusChange(false);
  }

  @override
  void onWindowFocus() => onFocusChange(true);

  @override
  void onWindowBlur() => onFocusChange(false);

  @override
  void onWindowMinimize() => onFocusChange(false);

  @override
  void onTrayIconMouseDown() => showWindow();

  @override
  void onTrayIconRightMouseDown() => trayManager.popUpContextMenu();

  @override
  void onTrayMenuItemClick(MenuItem menuItem) async {
    switch (menuItem.key) {
      case 'show':
        await showWindow();
      case 'quit':
        await onQuit();
        await trayManager.destroy();
        await windowManager.setPreventClose(false);
        await windowManager.destroy();
    }
  }
}

/* ---------------- 开机自启（Windows） ---------------- */

class Autostart {
  static const _key = r'HKCU\Software\Microsoft\Windows\CurrentVersion\Run';
  static const _name = 'CipherIM';

  static Future<bool> enabled() async {
    if (!Platform.isWindows) return false;
    final r = await Process.run('reg', ['query', _key, '/v', _name]);
    return r.exitCode == 0;
  }

  /// 开机后直接藏在托盘里，不弹窗口
  static Future<void> set(bool on) async {
    if (!Platform.isWindows) return;
    if (on) {
      await Process.run('reg', ['add', _key, '/v', _name, '/t', 'REG_SZ', '/d', '"${Platform.resolvedExecutable}" --hidden', '/f']);
    } else {
      await Process.run('reg', ['delete', _key, '/v', _name, '/f']);
    }
  }
}
