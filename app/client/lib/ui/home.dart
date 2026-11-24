/// 主界面：会话列表 + 聊天，按标准 Material 3 组件来
///  - 宽屏（≥ 840，MD3 的 expanded 窗口）两栏；窄屏点会话进下一页
///  - 主操作「新聊天」用 FAB，次要操作收进顶栏溢出菜单
library;

import 'dart:async';

import 'package:cipher_core/cipher_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../platform.dart';
import '../service.dart';
import '../vault.dart';
import 'settings.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.svc, required this.onLogout});
  final ChatService svc;
  final Future<void> Function() onLogout;

  /// 点通知时要打开的会话
  static final openConvRequest = ValueNotifier<int?>(null);

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  ChatService get svc => widget.svc;
  StreamSubscription<String>? _toastSub;
  bool _narrow = false;

  @override
  void initState() {
    super.initState();
    _toastSub = svc.toasts.listen((t) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(t)));
    });
    HomeScreen.openConvRequest.addListener(_onOpenRequest);
  }

  @override
  void dispose() {
    _toastSub?.cancel();
    HomeScreen.openConvRequest.removeListener(_onOpenRequest);
    super.dispose();
  }

  void _onOpenRequest() {
    final id = HomeScreen.openConvRequest.value;
    if (id == null) return;
    HomeScreen.openConvRequest.value = null;
    _open(id);
  }

  void _open(int id) {
    if (_narrow) {
      final nav = Navigator.of(context);
      nav.popUntil((r) => r.isFirst);
      svc.openConv(id);
      nav.push(MaterialPageRoute<void>(builder: (_) => _ChatPage(svc: svc, convId: id))).then((_) {
        if (svc.activeId == id) svc.openConv(null);
      });
    } else {
      svc.openConv(id);
    }
  }

  Future<void> _newChat() async {
    final peer = await Navigator.of(context).push<String>(
      MaterialPageRoute(fullscreenDialog: true, builder: (_) => _NewChatPage(svc: svc)),
    );
    if (peer == null) return;
    final id = await svc.createDirect(peer);
    if (id != null) _open(id);
  }

  Future<void> _newGroup() async {
    final r = await showDialog<(String, List<String>)>(context: context, builder: (_) => const _NewGroupDialog());
    if (r == null) return;
    final id = await svc.createGroup(r.$1, r.$2);
    if (id != null) _open(id);
  }

  void _settings() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => SettingsPage(svc: svc, onLogout: widget.onLogout)),
    );
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: svc,
      builder: (context, _) => LayoutBuilder(
        builder: (context, box) {
          _narrow = box.maxWidth < 840;
          final list = _ConvList(svc: svc, onOpen: _open, onNewChat: _newChat, onNewGroup: _newGroup, onSettings: _settings);
          if (_narrow) return list;
          final active = svc.activeId;
          return Row(
            children: [
              SizedBox(width: 360, child: list),
              const VerticalDivider(width: 1, thickness: 1),
              Expanded(
                child: active == null || svc.convById(active) == null
                    ? const _EmptyPane()
                    : _ChatPage(key: ValueKey(active), svc: svc, convId: active, embedded: true),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _EmptyPane extends StatelessWidget {
  const _EmptyPane();

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.lock_outline, size: 48, color: t.colorScheme.outline),
            const SizedBox(height: 16),
            Text('选一个会话开始聊天', style: t.textTheme.titleMedium),
            const SizedBox(height: 4),
            Text('消息只在你和对方的设备上解密', style: t.textTheme.bodyMedium?.copyWith(color: t.colorScheme.onSurfaceVariant)),
          ],
        ),
      ),
    );
  }
}

/* ---------------- 会话列表 ---------------- */

class _ConvList extends StatelessWidget {
  const _ConvList({
    required this.svc,
    required this.onOpen,
    required this.onNewChat,
    required this.onNewGroup,
    required this.onSettings,
  });
  final ChatService svc;
  final void Function(int) onOpen;
  final VoidCallback onNewChat;
  final VoidCallback onNewGroup;
  final VoidCallback onSettings;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final cs = t.colorScheme;
    final convs = svc.sortedConvs;
    final (statusText, statusColor) = switch (svc.status) {
      LinkStatus.online => ('在线', cs.primary),
      LinkStatus.connecting => ('连接中…', cs.tertiary),
      LinkStatus.offline => ('离线，正在重连', cs.error),
    };
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(svc.vault.displayName),
            Row(
              children: [
                Icon(Icons.circle, size: 8, color: statusColor),
                const SizedBox(width: 6),
                Text(statusText, style: t.textTheme.labelMedium?.copyWith(color: cs.onSurfaceVariant)),
              ],
            ),
          ],
        ),
        actions: [
          MenuAnchor(
            builder: (context, ctl, _) => IconButton(
              tooltip: '更多',
              icon: const Icon(Icons.more_vert),
              onPressed: () => ctl.isOpen ? ctl.close() : ctl.open(),
            ),
            menuChildren: [
              MenuItemButton(leadingIcon: const Icon(Icons.group_add_outlined), onPressed: onNewGroup, child: const Text('新建群聊')),
              MenuItemButton(leadingIcon: const Icon(Icons.settings_outlined), onPressed: onSettings, child: const Text('设置')),
            ],
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: onNewChat,
        icon: const Icon(Icons.edit_outlined),
        label: const Text('新聊天'),
      ),
      body: Column(
        children: [
          if (svc.fatalError != null)
            MaterialBanner(
              leading: Icon(Icons.error_outline, color: cs.error),
              content: Text('本设备的登录已失效：${svc.fatalError}'),
              actions: [TextButton(onPressed: onSettings, child: const Text('去设置'))],
            ),
          Expanded(
            child: convs.isEmpty
                ? Center(
                    child: Text(
                      svc.status == LinkStatus.online ? '还没有会话，点「新聊天」开始' : '正在连接服务器…',
                      style: t.textTheme.bodyMedium?.copyWith(color: cs.onSurfaceVariant),
                    ),
                  )
                : ListView.builder(
                    padding: const EdgeInsets.only(bottom: 88), // 给 FAB 留位置
                    itemCount: convs.length,
                    itemBuilder: (context, i) {
                      final c = convs[i];
                      final last = svc.lastOf(c.id);
                      final title = svc.titleOf(c);
                      final unread = c.id == svc.activeId ? 0 : c.unread;
                      return ListTile(
                        selected: c.id == svc.activeId,
                        selectedTileColor: cs.secondaryContainer,
                        selectedColor: cs.onSecondaryContainer,
                        leading: CircleAvatar(
                          child: c.isGroup ? const Icon(Icons.group_outlined) : Text(title.characters.first),
                        ),
                        title: Text(
                          title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: unread > 0 ? const TextStyle(fontWeight: FontWeight.w600) : null,
                        ),
                        subtitle: Text(
                          last == null ? (c.isGroup ? '${c.members.length} 位成员' : '') : _preview(svc, c, last),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        trailing: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            if (last != null) Text(_time(last.createdAt), style: t.textTheme.labelSmall),
                            if (unread > 0) ...[
                              const SizedBox(height: 4),
                              Badge(label: Text(unread > 99 ? '99+' : '$unread')),
                            ],
                          ],
                        ),
                        onTap: () => onOpen(c.id),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}

String _preview(ChatService svc, Conv c, LocalMsg m) {
  final body = switch (m.type) {
    'text' => m.payload['text'] as String? ?? '',
    'file' => '[文件] ${m.payload['name'] ?? ''}',
    _ => m.payload['text'] as String? ?? '',
  };
  if (!c.isGroup) return body;
  return '${m.mine ? '我' : svc.nameOf(m.fromUser)}：$body';
}

String _time(int ms) {
  final t = DateTime.fromMillisecondsSinceEpoch(ms);
  final now = DateTime.now();
  String two(int n) => n.toString().padLeft(2, '0');
  if (t.year == now.year && t.month == now.month && t.day == now.day) return '${two(t.hour)}:${two(t.minute)}';
  if (t.year == now.year) return '${t.month}/${t.day}';
  return '${t.year}/${t.month}/${t.day}';
}

/* ---------------- 聊天 ---------------- */

class _ChatPage extends StatefulWidget {
  const _ChatPage({super.key, required this.svc, required this.convId, this.embedded = false});
  final ChatService svc;
  final int convId;
  final bool embedded;

  @override
  State<_ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<_ChatPage> {
  final _draft = TextEditingController();
  final _focus = FocusNode();

  ChatService get svc => widget.svc;

  @override
  void initState() {
    super.initState();
    _focus.onKeyEvent = (node, e) {
      // 桌面：回车发送，Shift+回车换行；手机上回车照常换行
      if (isDesktop &&
          e is KeyDownEvent &&
          (e.logicalKey == LogicalKeyboardKey.enter || e.logicalKey == LogicalKeyboardKey.numpadEnter) &&
          !HardwareKeyboard.instance.isShiftPressed) {
        _send();
        return KeyEventResult.handled;
      }
      return KeyEventResult.ignored;
    };
  }

  @override
  void dispose() {
    _draft.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _send() {
    final text = _draft.text.trim();
    if (text.isEmpty) return;
    _draft.clear();
    svc.sendText(widget.convId, text);
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final cs = t.colorScheme;
    return ListenableBuilder(
      listenable: svc,
      builder: (context, _) {
        final c = svc.convById(widget.convId);
        if (c == null) return const Scaffold(body: Center(child: Text('会话不存在')));
        final list = svc.msgs[c.id] ?? const <LocalMsg>[];
        final typing = svc.typing[c.id];
        final peer = c.isGroup ? null : svc.peerOf(c);
        final peerRead = peer == null ? 0 : (svc.receipts[c.id]?[peer.user] ?? 0);
        final title = svc.titleOf(c);
        return Scaffold(
          appBar: AppBar(
            automaticallyImplyLeading: !widget.embedded,
            titleSpacing: widget.embedded ? null : 0,
            title: Row(
              children: [
                CircleAvatar(
                  radius: 18,
                  child: c.isGroup ? const Icon(Icons.group_outlined, size: 20) : Text(title.characters.first),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(title, overflow: TextOverflow.ellipsis),
                      Text(
                        typing != null
                            ? '${svc.nameOf(typing.user)} 正在输入…'
                            : c.isGroup
                            ? '${c.members.length} 位成员 · 端到端加密'
                            : '@${peer?.user ?? ''} · 端到端加密',
                        style: t.textTheme.labelMedium?.copyWith(color: cs.onSurfaceVariant),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            actions: [
              if (c.isGroup)
                IconButton(
                  tooltip: '成员',
                  icon: const Icon(Icons.people_outline),
                  onPressed: () => showModalBottomSheet<void>(
                    context: context,
                    showDragHandle: true,
                    builder: (_) => _MembersSheet(svc: svc, conv: c),
                  ),
                ),
            ],
          ),
          body: Column(
            children: [
              Expanded(
                child: list.isEmpty
                    ? Center(
                        child: Text('还没有消息', style: t.textTheme.bodyMedium?.copyWith(color: cs.onSurfaceVariant)),
                      )
                    : ListView.builder(
                        reverse: true,
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                        itemCount: list.length,
                        itemBuilder: (context, i) {
                          final m = list[list.length - 1 - i];
                          final prev = i + 1 < list.length ? list[list.length - 2 - i] : null;
                          return _Bubble(
                            svc: svc,
                            msg: m,
                            showSender: c.isGroup && !m.mine && prev?.fromUser != m.fromUser,
                            read: !c.isGroup && m.mine && m.id > 0 && m.id <= peerRead,
                          );
                        },
                      ),
              ),
              SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 12, 12),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _draft,
                          focusNode: _focus,
                          autofocus: isDesktop,
                          minLines: 1,
                          maxLines: 6,
                          keyboardType: TextInputType.multiline,
                          decoration: InputDecoration(
                            hintText: isDesktop ? '输入消息，回车发送，Shift+回车换行' : '输入消息',
                            filled: true,
                            fillColor: cs.surfaceContainerHigh,
                            contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                            border: OutlineInputBorder(borderRadius: BorderRadius.circular(28), borderSide: BorderSide.none),
                          ),
                          onChanged: (s) {
                            if (s.isNotEmpty) svc.sendTyping(c.id);
                          },
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton.filled(
                        tooltip: '发送',
                        onPressed: _send,
                        icon: const Icon(Icons.send),
                        style: IconButton.styleFrom(minimumSize: const Size(48, 48)),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.svc, required this.msg, required this.showSender, required this.read});
  final ChatService svc;
  final LocalMsg msg;
  final bool showSender;
  final bool read;

  Future<void> _save(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final path = await svc.saveFile(msg.payload);
      messenger.showSnackBar(SnackBar(content: Text('已保存到 $path')));
    } catch (_) {
      messenger.showSnackBar(const SnackBar(content: Text('文件解密失败或已过期（服务器只保留 14 天）')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final cs = t.colorScheme;
    if (msg.type == 'system') {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Center(
          child: Text(
            msg.payload['text'] as String? ?? '',
            textAlign: TextAlign.center,
            style: t.textTheme.labelSmall?.copyWith(color: cs.onSurfaceVariant),
          ),
        ),
      );
    }
    final mine = msg.mine;
    final fg = mine ? cs.onPrimaryContainer : cs.onSurface;
    final Widget content = switch (msg.type) {
      'text' => SelectableText(msg.payload['text'] as String? ?? '', style: t.textTheme.bodyLarge?.copyWith(color: fg)),
      'file' => InkWell(
        onTap: () => _save(context),
        borderRadius: BorderRadius.circular(12),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.description_outlined, color: fg),
            const SizedBox(width: 12),
            Flexible(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    msg.payload['name'] as String? ?? '文件',
                    overflow: TextOverflow.ellipsis,
                    style: t.textTheme.bodyLarge?.copyWith(color: fg),
                  ),
                  Text(
                    '${_size((msg.payload['size'] as num?)?.toInt() ?? 0)} · 点击保存',
                    style: t.textTheme.bodySmall?.copyWith(color: fg.withValues(alpha: 0.75)),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
      _ => Text('[暂不支持的消息：${msg.type}]', style: TextStyle(color: fg)),
    };
    const r = Radius.circular(20);
    const tail = Radius.circular(4);
    final status = msg.failed != null
        ? Icon(Icons.error_outline, size: 14, color: cs.error)
        : msg.sending
        ? Icon(Icons.schedule, size: 14, color: cs.onSurfaceVariant)
        : null;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Column(
        crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        children: [
          if (showSender)
            Padding(
              padding: const EdgeInsets.only(left: 12, top: 8, bottom: 4),
              child: Text(svc.nameOf(msg.fromUser), style: t.textTheme.labelMedium?.copyWith(color: cs.primary)),
            ),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              decoration: BoxDecoration(
                color: mine ? cs.primaryContainer : cs.surfaceContainerHigh,
                borderRadius: BorderRadius.only(
                  topLeft: r,
                  topRight: r,
                  bottomLeft: mine ? r : tail,
                  bottomRight: mine ? tail : r,
                ),
              ),
              child: content,
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 4, 8, 6),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                ?status,
                if (status != null) const SizedBox(width: 4),
                Text(
                  [_time(msg.createdAt), if (read) '已读', if (msg.failed != null) '发送失败'].join(' · '),
                  style: t.textTheme.labelSmall?.copyWith(
                    color: msg.failed != null ? cs.error : cs.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

String _size(int n) {
  if (n < 1024) return '$n B';
  if (n < 1024 * 1024) return '${(n / 1024).toStringAsFixed(1)} KB';
  return '${(n / 1024 / 1024).toStringAsFixed(1)} MB';
}

/* ---------------- 新聊天、新群聊、成员 ---------------- */

class _NewChatPage extends StatefulWidget {
  const _NewChatPage({required this.svc});
  final ChatService svc;

  @override
  State<_NewChatPage> createState() => _NewChatPageState();
}

class _NewChatPageState extends State<_NewChatPage> {
  List<({String username, String displayName})> _res = const [];
  bool _busy = false;
  bool _searched = false;
  Timer? _debounce;

  void _search(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () async {
      if (q.trim().isEmpty) {
        setState(() {
          _res = const [];
          _searched = false;
        });
        return;
      }
      setState(() => _busy = true);
      final r = await widget.svc.searchUsers(q.trim());
      if (!mounted) return;
      setState(() {
        _busy = false;
        _searched = true;
        _res = r.where((u) => u.username != widget.svc.vault.username).toList();
      });
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('新聊天')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            child: SearchBar(
              autoFocus: true,
              hintText: '搜索用户名或昵称',
              leading: const Icon(Icons.search),
              elevation: const WidgetStatePropertyAll(0),
              onChanged: _search,
            ),
          ),
          if (_busy) const LinearProgressIndicator(),
          Expanded(
            child: _searched && _res.isEmpty && !_busy
                ? Center(child: Text('没找到这个用户', style: t.textTheme.bodyMedium))
                : ListView(
                    children: [
                      for (final u in _res)
                        ListTile(
                          leading: CircleAvatar(child: Text(u.displayName.characters.first)),
                          title: Text(u.displayName),
                          subtitle: Text('@${u.username}'),
                          onTap: () => Navigator.pop(context, u.username),
                        ),
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}

class _NewGroupDialog extends StatefulWidget {
  const _NewGroupDialog();

  @override
  State<_NewGroupDialog> createState() => _NewGroupDialogState();
}

class _NewGroupDialogState extends State<_NewGroupDialog> {
  final _name = TextEditingController();
  final _members = TextEditingController();
  String? _err;

  void _ok() {
    final name = _name.text.trim();
    final members = _members.text.split(RegExp(r'[\s,，]+')).where((s) => s.isNotEmpty).toList();
    if (name.isEmpty || members.isEmpty) {
      setState(() => _err = name.isEmpty ? '填一个群名' : '至少加一位成员');
      return;
    }
    Navigator.pop(context, (name, members));
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      icon: const Icon(Icons.group_add_outlined),
      title: const Text('新建群聊'),
      content: SizedBox(
        width: 360,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: _name,
              autofocus: true,
              decoration: const InputDecoration(labelText: '群名', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _members,
              decoration: InputDecoration(
                labelText: '成员用户名',
                helperText: '多个用逗号或空格隔开',
                errorText: _err,
                border: const OutlineInputBorder(),
              ),
              onSubmitted: (_) => _ok(),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        TextButton(onPressed: _ok, child: const Text('创建')),
      ],
    );
  }
}

class _MembersSheet extends StatelessWidget {
  const _MembersSheet({required this.svc, required this.conv});
  final ChatService svc;
  final Conv conv;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return SafeArea(
      child: ListView(
        shrinkWrap: true,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
            child: Text('${svc.titleOf(conv)} · ${conv.members.length} 位成员', style: t.textTheme.titleMedium),
          ),
          for (final m in conv.members)
            ListTile(
              leading: CircleAvatar(child: Text(m.displayName.characters.first)),
              title: Text(m.user == svc.vault.username ? '${m.displayName}（我）' : m.displayName),
              subtitle: Text('@${m.user} · ${m.devices.length} 台设备'),
            ),
        ],
      ),
    );
  }
}
