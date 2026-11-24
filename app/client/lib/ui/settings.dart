/// 设置页：标准 MD3 列表（分组标题 + ListTile / SwitchListTile）
library;

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../platform.dart';
import '../service.dart';
import '../vault.dart';

const sourceUrl = 'https://github.com/zhuzhi-09/cipher-im';

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key, required this.svc, required this.onLogout});
  final ChatService svc;
  final Future<void> Function() onLogout;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  bool? _autostart;

  Vault get v => widget.svc.vault;

  @override
  void initState() {
    super.initState();
    if (Platform.isWindows) {
      Autostart.enabled().then((on) {
        if (mounted) setState(() => _autostart = on);
      });
    }
  }

  void _copy(String label, String value) {
    Clipboard.setData(ClipboardData(text: value));
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已复制$label')));
  }

  Future<void> _logout() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        icon: const Icon(Icons.logout),
        title: const Text('退出账号？'),
        content: const Text('会删除本机的密钥和聊天记录。之后重新登录算作一台新设备，14 天内的记录可以通过漫游补回，更早的就没有了。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('退出')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    Navigator.of(context).popUntil((r) => r.isFirst);
    await widget.onLogout();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final cs = t.colorScheme;
    Widget header(String s) => Padding(
      padding: const EdgeInsets.fromLTRB(16, 24, 16, 8),
      child: Text(s, style: t.textTheme.titleSmall?.copyWith(color: cs.primary)),
    );
    Widget info(IconData icon, String label, String value) => ListTile(
      leading: Icon(icon),
      title: Text(label),
      subtitle: Text(value),
      onLongPress: () => _copy(label, value),
      trailing: IconButton(tooltip: '复制', icon: const Icon(Icons.copy_outlined), onPressed: () => _copy(label, value)),
    );
    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        children: [
          header('账号'),
          info(Icons.badge_outlined, '昵称', v.displayName),
          info(Icons.alternate_email, '用户名', v.username),
          info(Icons.devices_outlined, '本机设备', v.deviceId),
          info(Icons.dns_outlined, '服务器', Uri.parse(v.server).host),
          header('通知'),
          SwitchListTile(
            secondary: const Icon(Icons.notifications_outlined),
            title: const Text('通知里显示消息内容'),
            subtitle: const Text('关掉后只提示「你有新消息」'),
            value: v.notifyPreview,
            onChanged: (on) {
              setState(() => v.notifyPreview = on);
              widget.svc.savePrefs();
            },
          ),
          if (Platform.isWindows)
            SwitchListTile(
              secondary: const Icon(Icons.power_settings_new),
              title: const Text('开机自动启动'),
              subtitle: const Text('启动后藏在托盘里，有消息会弹通知'),
              value: _autostart ?? false,
              onChanged: _autostart == null
                  ? null
                  : (on) async {
                      await Autostart.set(on);
                      final now = await Autostart.enabled();
                      if (mounted) setState(() => _autostart = now);
                    },
            ),
          header('关于'),
          ListTile(
            leading: const Icon(Icons.info_outline),
            title: const Text('Cipher IM'),
            subtitle: const Text('开源 · AGPL-3.0'),
          ),
          info(Icons.code, '源代码', sourceUrl),
          const Divider(height: 32),
          ListTile(
            leading: Icon(Icons.logout, color: cs.error),
            title: Text('退出账号', style: TextStyle(color: cs.error)),
            subtitle: const Text('删除本机的密钥和聊天记录'),
            onTap: _logout,
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}
