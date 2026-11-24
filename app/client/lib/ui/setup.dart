/// 首次启动：先连服务器（必须自己填，没有默认值），再注册或登录
library;

import 'package:cipher_core/cipher_core.dart';
import 'package:flutter/material.dart';

import '../service.dart';
import '../vault.dart';

class SetupScreen extends StatefulWidget {
  const SetupScreen({super.key, required this.onSignedIn});
  final Future<void> Function(Vault v) onSignedIn;

  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> {
  ServerInfo? _server;

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
                  _ServerStep(onOk: (s) => setState(() => _server = s))
                else
                  _AuthStep(
                    server: _server!,
                    onBack: () => setState(() => _server = null),
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
  const _ServerStep({required this.onOk});
  final void Function(ServerInfo s) onOk;

  @override
  State<_ServerStep> createState() => _ServerStepState();
}

class _ServerStepState extends State<_ServerStep> {
  final _ctl = TextEditingController();
  String? _err;
  bool _busy = false;

  Future<void> _check() async {
    setState(() {
      _busy = true;
      _err = null;
    });
    try {
      final info = await checkServer(normalizeServerAddress(_ctl.text));
      widget.onOk(info);
    } catch (e) {
      setState(() => _err = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('连接服务器', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 12),
        TextField(
          controller: _ctl,
          autofocus: true,
          keyboardType: TextInputType.url,
          decoration: InputDecoration(
            labelText: '服务器地址',
            hintText: '例如 im.example.com',
            border: const OutlineInputBorder(),
            errorText: _err,
            errorMaxLines: 3,
          ),
          onSubmitted: (_) => _busy ? null : _check(),
        ),
        const SizedBox(height: 8),
        Text(
          '填你或朋友部署的 Cipher IM 服务器。只支持 https://，客户端不内置任何服务器。',
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: 16),
        FilledButton(
          onPressed: _busy ? null : _check,
          child: _busy ? const _Spinner() : const Text('连接'),
        ),
      ],
    );
  }
}

class _AuthStep extends StatefulWidget {
  const _AuthStep({required this.server, required this.onBack, required this.onSignedIn});
  final ServerInfo server;
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
