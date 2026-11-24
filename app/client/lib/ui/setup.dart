/// 首次启动：先连服务器（必须自己填，没有默认值），再注册或登录
///
/// 登录过的「服务器 + 用户名」会记在「最近连接」里，点一下就能填好；
/// 密码只有勾了「记住密码」才记。
library;

import 'package:cipher_core/cipher_core.dart';
import 'package:flutter/material.dart';

import '../connections.dart';
import '../service.dart';
import '../vault.dart';

class SetupScreen extends StatefulWidget {
  const SetupScreen({super.key, required this.onSignedIn, required this.connections});
  final Future<void> Function(Vault v) onSignedIn;
  final ConnectionStore connections;

  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> {
  ServerInfo? _server;

  /// 从「最近连接」点进来时带上用户名（和记住的密码）
  SavedConnection? _prefill;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 400),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Image.asset('assets/icon.png', width: 64, height: 64),
                const SizedBox(height: 12),
                Text('Cipher IM', textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall),
                const SizedBox(height: 4),
                Text(
                  '端到端加密聊天 · 连接你自己部署的服务器',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant),
                ),
                const SizedBox(height: 28),
                if (_server == null)
                  _ServerStep(
                    connections: widget.connections,
                    onOk: (s, saved) => setState(() {
                      _server = s;
                      _prefill = saved;
                    }),
                  )
                else
                  _AuthStep(
                    server: _server!,
                    prefill: _prefill,
                    connections: widget.connections,
                    onBack: () => setState(() {
                      _server = null;
                      _prefill = null;
                    }),
                    onSignedIn: widget.onSignedIn,
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ServerStep extends StatefulWidget {
  const _ServerStep({required this.onOk, required this.connections});
  final void Function(ServerInfo s, SavedConnection? saved) onOk;
  final ConnectionStore connections;

  @override
  State<_ServerStep> createState() => _ServerStepState();
}

class _ServerStepState extends State<_ServerStep> {
  final _ctl = TextEditingController();
  String? _err;
  bool _busy = false;
  List<SavedConnection> _saved = [];

  /// 正在连的那条最近连接（显示转圈用）
  SavedConnection? _picking;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final items = await widget.connections.list();
    if (mounted) setState(() => _saved = items);
  }

  Future<void> _check({SavedConnection? saved}) async {
    setState(() {
      _busy = true;
      _picking = saved;
      _err = null;
    });
    try {
      final info = await checkServer(saved != null ? Uri.parse(saved.server) : normalizeServerAddress(_ctl.text));
      widget.onOk(info, saved);
    } catch (e) {
      if (mounted) setState(() => _err = saved == null ? '$e' : '连不上 ${saved.host}：$e');
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _picking = null;
        });
      }
    }
  }

  Future<void> _forget(SavedConnection c) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('删除这条连接记录？'),
        content: Text(
          '${c.username} @ ${c.host}\n'
          '${c.hasPassword ? '记住的密码也会一起删掉。' : ''}只删本机的记录，不影响账号。',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('删除')),
        ],
      ),
    );
    if (ok != true) return;
    await widget.connections.forget(c.server, c.username);
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_saved.isNotEmpty) ...[
          Text('最近连接', style: t.textTheme.titleMedium),
          const SizedBox(height: 8),
          Card.outlined(
            margin: EdgeInsets.zero,
            clipBehavior: Clip.antiAlias,
            child: Column(
              children: [
                for (final c in _saved)
                  ListTile(
                    leading: CircleAvatar(
                      child: Text((c.displayName.isEmpty ? c.username : c.displayName).characters.first.toUpperCase()),
                    ),
                    title: Text(
                      c.displayName.isEmpty || c.displayName == c.username
                          ? c.username
                          : '${c.displayName}（${c.username}）',
                      overflow: TextOverflow.ellipsis,
                    ),
                    subtitle: Text(c.hasPassword ? '${c.host} · 已记住密码' : c.host, overflow: TextOverflow.ellipsis),
                    enabled: !_busy,
                    onTap: () => _check(saved: c),
                    trailing: identical(_picking, c)
                        ? const _Spinner()
                        : IconButton(
                            tooltip: '删除记录',
                            icon: const Icon(Icons.close),
                            onPressed: _busy ? null : () => _forget(c),
                          ),
                  ),
              ],
            ),
          ),
          if (_err != null && _ctl.text.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_err!, style: TextStyle(color: t.colorScheme.error)),
            ),
          const SizedBox(height: 24),
          Text('其他服务器', style: t.textTheme.titleMedium),
        ] else
          Text('连接服务器', style: t.textTheme.titleMedium),
        const SizedBox(height: 12),
        TextField(
          controller: _ctl,
          autofocus: _saved.isEmpty,
          keyboardType: TextInputType.url,
          decoration: InputDecoration(
            labelText: '服务器地址',
            hintText: '例如 im.example.com',
            border: const OutlineInputBorder(),
            errorText: _saved.isNotEmpty && _ctl.text.isEmpty ? null : _err,
            errorMaxLines: 3,
          ),
          onSubmitted: (_) => _busy ? null : _check(),
        ),
        const SizedBox(height: 8),
        Text(
          '填你或朋友部署的 Cipher IM 服务器。只支持 https://，客户端不内置任何服务器。',
          style: t.textTheme.bodySmall,
        ),
        const SizedBox(height: 16),
        FilledButton(
          onPressed: _busy ? null : _check,
          child: _busy && _picking == null ? const _Spinner() : const Text('连接'),
        ),
      ],
    );
  }
}

class _AuthStep extends StatefulWidget {
  const _AuthStep({
    required this.server,
    required this.onBack,
    required this.onSignedIn,
    required this.connections,
    this.prefill,
  });
  final ServerInfo server;
  final SavedConnection? prefill;
  final ConnectionStore connections;
  final VoidCallback onBack;
  final Future<void> Function(Vault v) onSignedIn;

  @override
  State<_AuthStep> createState() => _AuthStepState();
}

class _AuthStepState extends State<_AuthStep> {
  bool _register = false;
  bool _busy = false;
  String? _err;
  final _user = TextEditingController();
  final _name = TextEditingController();
  final _pw = TextEditingController();
  final _pw2 = TextEditingController();
  final _invite = TextEditingController();

  /// 默认不记密码；之前记过的，这次默认接着记
  bool _rememberPw = false;

  @override
  void initState() {
    super.initState();
    final p = widget.prefill;
    if (p != null) {
      _user.text = p.username;
      if (p.password != null) {
        _pw.text = p.password!;
        _rememberPw = true;
      }
    }
  }

  Future<void> _submit() async {
    final user = _user.text.trim();
    final pw = _pw.text;
    String? err;
    if (!RegExp(r'^[a-zA-Z0-9_-]{3,24}$').hasMatch(user)) err = '用户名是 3–24 位字母、数字、_ 或 -';
    if (err == null && pw.length < 6) err = '密码至少 6 位';
    if (err == null && _register && pw != _pw2.text) err = '两次输入的密码不一样';
    if (err == null && _register && _invite.text.trim().isEmpty) err = '请填写邀请码';
    if (err != null) {
      setState(() => _err = err);
      return;
    }
    setState(() {
      _busy = true;
      _err = null;
    });
    try {
      final v = _register
          ? await Account.register(
              server: widget.server.base,
              username: user,
              displayName: _name.text.trim().isEmpty ? user : _name.text.trim(),
              password: pw,
              invite: _invite.text.trim(),
            )
          : await Account.login(server: widget.server.base, username: user, password: pw);
      // 记连接失败不挡登录
      try {
        await widget.connections.remember(
          server: widget.server.base.toString(),
          username: v.username,
          displayName: v.displayName,
          password: _rememberPw ? pw : null,
        );
      } catch (_) {}
      await widget.onSignedIn(v);
    } catch (e) {
      if (mounted) setState(() => _err = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    Widget field(TextEditingController c, String label, {bool obscure = false, String? hint}) => Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextField(
        controller: c,
        obscureText: obscure,
        decoration: InputDecoration(labelText: label, hintText: hint, border: const OutlineInputBorder()),
        onSubmitted: (_) => _busy ? null : _submit(),
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            const Icon(Icons.dns_outlined, size: 18),
            const SizedBox(width: 6),
            Expanded(child: Text(widget.server.base.host, overflow: TextOverflow.ellipsis)),
            TextButton(onPressed: _busy ? null : widget.onBack, child: const Text('换服务器')),
          ],
        ),
        const SizedBox(height: 8),
        SegmentedButton<bool>(
          segments: const [
            ButtonSegment(value: false, label: Text('登录')),
            ButtonSegment(value: true, label: Text('注册')),
          ],
          selected: {_register},
          onSelectionChanged: (s) => setState(() {
            _register = s.first;
            _err = null;
          }),
        ),
        const SizedBox(height: 16),
        field(_user, '用户名'),
        if (_register) field(_name, '昵称', hint: '别人看到的名字，可不填'),
        field(_pw, '密码', obscure: true),
        if (_register) field(_pw2, '再输一次密码', obscure: true),
        if (_register) field(_invite, '邀请码', hint: '向服务器管理员要'),
        CheckboxListTile(
          value: _rememberPw,
          onChanged: _busy ? null : (on) => setState(() => _rememberPw = on ?? false),
          title: const Text('记住密码'),
          subtitle: const Text('存在本机系统密钥库里。不勾的话只记服务器和用户名'),
          controlAffinity: ListTileControlAffinity.leading,
          contentPadding: EdgeInsets.zero,
          dense: true,
        ),
        const SizedBox(height: 4),
        if (_err != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Text(_err!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          ),
        FilledButton(
          onPressed: _busy ? null : _submit,
          child: _busy ? const _Spinner() : Text(_register ? '注册' : '登录'),
        ),
        const SizedBox(height: 12),
        Text(
          _register
              ? '密钥在本机生成，服务器只拿到公钥。'
              : '在本机登录会登记为一台新设备。本机看不到登录前其他设备上的旧消息，14 天内的记录会通过漫游补回来。',
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
    );
  }
}

class _Spinner extends StatelessWidget {
  const _Spinner();
  @override
  Widget build(BuildContext context) =>
      const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2));
}
