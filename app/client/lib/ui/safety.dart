/// 核对安全码：和对方当面或通过可信渠道逐组念一遍，一致就标「已验证」
///
/// 和 Web 端同一算法，所以网页端和客户端互相核对也对得上。
/// 对方每台设备一串（每台设备的身份密钥不同）。
library;

import 'package:cipher_core/cipher_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../service.dart';
import '../vault.dart';

class SafetyPage extends StatefulWidget {
  const SafetyPage({super.key, required this.svc, required this.member});
  final ChatService svc;
  final Member member;

  @override
  State<SafetyPage> createState() => _SafetyPageState();
}

class _SafetyPageState extends State<SafetyPage> {
  bool _fetching = false;

  ChatService get svc => widget.svc;

  Future<void> _fetch() async {
    setState(() => _fetching = true);
    try {
      await svc.fetchIdentities(widget.member.user);
    } finally {
      if (mounted) setState(() => _fetching = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final cs = t.colorScheme;
    final m = widget.member;
    return Scaffold(
      appBar: AppBar(title: Text('安全码 · ${m.displayName}')),
      body: ListenableBuilder(
        listenable: svc,
        builder: (context, _) {
          final rows = svc.safetyOf(m.user, devices: m.devices);
          final missing = rows.any((r) => r.safety == null);
          return ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
            children: [
              Text(
                '和对方当面或通过可信渠道（电话、见面）逐组念一遍，两边一致就点「标记已验证」。'
                '之后对方换了设备或密钥，这里会变成「已变更」，聊天页也会提醒。',
                style: t.textTheme.bodyMedium?.copyWith(color: cs.onSurfaceVariant),
              ),
              const SizedBox(height: 8),
              Text(
                '本机身份指纹 ${shortFingerprint(svc.vault.keys.identity.ikSigPub)}',
                style: t.textTheme.labelMedium?.copyWith(color: cs.onSurfaceVariant),
              ),
              const SizedBox(height: 16),
              if (rows.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 24),
                  child: Center(child: Text('对方还没有登记设备')),
                ),
              for (final r in rows) _DeviceCard(svc: svc, row: r),
              if (missing) ...[
                const SizedBox(height: 8),
                Text(
                  '有设备还没拿到身份公钥。互相发过消息就会自动拿到；也可以现在向服务器要一次'
                  '（会用掉对方每台设备一枚一次性预密钥）。',
                  style: t.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                ),
                const SizedBox(height: 8),
                Align(
                  alignment: Alignment.centerLeft,
                  child: FilledButton.tonalIcon(
                    onPressed: _fetching ? null : _fetch,
                    icon: _fetching
                        ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Icon(Icons.download_outlined),
                    label: const Text('获取对方公钥'),
                  ),
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _DeviceCard extends StatelessWidget {
  const _DeviceCard({required this.svc, required this.row});
  final ChatService svc;
  final DeviceSafety row;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final cs = t.colorScheme;
    final r = row;
    final (label, color, icon) = switch (r.state) {
      TrustState.verified => ('已验证', cs.primary, Icons.verified_user),
      TrustState.changed => ('已变更', cs.error, Icons.gpp_maybe),
      TrustState.unverified => ('未核对', cs.onSurfaceVariant, Icons.shield_outlined),
    };
    final groups = r.safety == null ? const <String>[] : formatSafetyNumber(r.safety!);
    return Card.outlined(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.devices_outlined, size: 18, color: cs.onSurfaceVariant),
                const SizedBox(width: 8),
                Expanded(child: Text(r.device, style: t.textTheme.titleSmall)),
                Chip(
                  avatar: Icon(icon, size: 16, color: color),
                  label: Text(label, style: TextStyle(color: color)),
                  visualDensity: VisualDensity.compact,
                ),
              ],
            ),
            if (r.state == TrustState.changed)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  '这台设备的密钥和你上次核对时不一样了。可能是对方重装或换了设备，也可能有人冒名。请重新核对。',
                  style: t.textTheme.bodySmall?.copyWith(color: cs.error),
                ),
              ),
            const SizedBox(height: 12),
            if (r.safety == null)
              Text('还没拿到这台设备的身份公钥', style: t.textTheme.bodyMedium?.copyWith(color: cs.onSurfaceVariant))
            else
              GestureDetector(
                onLongPress: () {
                  Clipboard.setData(ClipboardData(text: groups.join(' ')));
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已复制安全码')));
                },
                child: Wrap(
                  spacing: 16,
                  runSpacing: 8,
                  children: [
                    for (final g in groups)
                      Text(
                        g,
                        style: t.textTheme.titleMedium?.copyWith(
                          fontFamily: 'monospace',
                          fontFeatures: const [FontFeature.tabularFigures()],
                          letterSpacing: 1.5,
                        ),
                      ),
                  ],
                ),
              ),
            if (r.safety != null) ...[
              const SizedBox(height: 12),
              Align(
                alignment: Alignment.centerRight,
                child: r.state == TrustState.verified
                    ? TextButton(onPressed: () => svc.untrust(r), child: const Text('取消信任'))
                    : FilledButton(onPressed: () => svc.markVerified(r), child: const Text('标记已验证')),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
