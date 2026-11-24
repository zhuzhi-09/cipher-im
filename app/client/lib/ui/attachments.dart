/// 附件：选文件发送、对话里的文件气泡、应用内预览
///
///  - 图片：两端都在对话里直接显示缩略图
///  - 安卓：点开在应用内看（图片可缩放，视频 / 音频能播放，文本直接显示），其他类型交给系统选应用
///  - 桌面：点开交给系统默认程序
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cipher_core/cipher_core.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

import '../media.dart';
import '../service.dart';
import '../vault.dart';

bool get _inAppPreview => Platform.isAndroid || Platform.isIOS;

/* ---------------- 发送 ---------------- */

Future<void> pickAndSendFiles(BuildContext context, ChatService svc, int convId, {bool imagesOnly = false}) async {
  final messenger = ScaffoldMessenger.of(context);
  final List<XFile> files;
  try {
    files = imagesOnly
        ? await openFiles(
            acceptedTypeGroups: const [
              XTypeGroup(
                label: '图片',
                extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'],
                mimeTypes: ['image/*'],
                uniformTypeIdentifiers: ['public.image'],
              ),
            ],
          )
        : await openFiles();
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text('选文件失败：$e')));
    return;
  }
  for (final f in files) {
    await sendLocalFile(messenger, svc, convId, f);
  }
}

/// 桌面拖进来的文件、选择器选的文件都走这里
Future<void> sendLocalFile(ScaffoldMessengerState messenger, ChatService svc, int convId, XFile f) async {
  try {
    final size = await f.length();
    if (size > ChatService.maxFileBytes) {
      messenger.showSnackBar(SnackBar(content: Text('${f.name} 超过 30MB，发不了')));
      return;
    }
    final bytes = await f.readAsBytes();
    await svc.sendFile(convId, name: f.name, bytes: bytes, mime: f.mimeType ?? '');
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text('${f.name} 发送失败：$e')));
  }
}

/* ---------------- 对话里的附件 ---------------- */

class FileContent extends StatelessWidget {
  const FileContent({super.key, required this.svc, required this.msg, required this.fg});
  final ChatService svc;
  final LocalMsg msg;
  final Color fg;

  Payload get p => msg.payload;
  String get name => p['name'] as String? ?? '文件';
  MediaKind get kind => mediaKindOf(p['mime'] as String?, name);

  @override
  Widget build(BuildContext context) {
    if (kind == MediaKind.image) return _ImageThumb(svc: svc, payload: p, onTap: () => openAttachment(context, svc, p));
    final t = Theme.of(context);
    final icon = switch (kind) {
      MediaKind.video => Icons.movie_outlined,
      MediaKind.audio => Icons.audiotrack_outlined,
      MediaKind.text => Icons.article_outlined,
      _ => Icons.description_outlined,
    };
    return InkWell(
      onTap: () => openAttachment(context, svc, p),
      onLongPress: () => showAttachmentMenu(context, svc, p),
      onSecondaryTap: () => showAttachmentMenu(context, svc, p),
      borderRadius: BorderRadius.circular(12),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, color: fg),
          const SizedBox(width: 12),
          Flexible(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(name, overflow: TextOverflow.ellipsis, style: t.textTheme.bodyLarge?.copyWith(color: fg)),
                Text(
                  '${fileSizeText((p['size'] as num?)?.toInt() ?? 0)} · ${_inAppPreview && kind != MediaKind.other ? '点击预览' : '点击打开'}',
                  style: t.textTheme.bodySmall?.copyWith(color: fg.withValues(alpha: 0.75)),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ImageThumb extends StatefulWidget {
  const _ImageThumb({required this.svc, required this.payload, required this.onTap});
  final ChatService svc;
  final Payload payload;
  final VoidCallback onTap;

  @override
  State<_ImageThumb> createState() => _ImageThumbState();
}

class _ImageThumbState extends State<_ImageThumb> {
  Uint8List? _bytes;
  Object? _err;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _err = null);
    try {
      final b = await widget.svc.fileBytes(widget.payload);
      if (mounted) setState(() => _bytes = b);
    } catch (e) {
      if (mounted) setState(() => _err = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final dpr = MediaQuery.devicePixelRatioOf(context);
    Widget box(Widget child) => SizedBox(width: 220, height: 160, child: Center(child: child));
    final Widget child;
    if (_bytes != null) {
      child = ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 280, maxHeight: 320, minWidth: 80, minHeight: 60),
        child: Image.memory(
          _bytes!,
          fit: BoxFit.contain,
          cacheWidth: (280 * dpr).round(),
          gaplessPlayback: true,
          errorBuilder: (_, _, _) => box(const Icon(Icons.broken_image_outlined)),
        ),
      );
    } else if (_err != null) {
      child = box(
        TextButton.icon(onPressed: _load, icon: const Icon(Icons.refresh), label: const Text('图片加载失败，重试')),
      );
    } else {
      child = box(const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2)));
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(14),
      child: Material(
        color: cs.surfaceContainerHighest,
        child: InkWell(
          onTap: _bytes == null ? null : widget.onTap,
          onLongPress: () => showAttachmentMenu(context, widget.svc, widget.payload),
          onSecondaryTap: () => showAttachmentMenu(context, widget.svc, widget.payload),
          child: child,
        ),
      ),
    );
  }
}

/// 点附件：安卓能预览的在应用内看，其余交给系统
Future<void> openAttachment(BuildContext context, ChatService svc, Payload p) async {
  final name = p['name'] as String? ?? '文件';
  final kind = mediaKindOf(p['mime'] as String?, name);
  if (_inAppPreview && kind != MediaKind.other) {
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => MediaViewer(svc: svc, payload: p)));
    return;
  }
  await _openExternally(context, svc, p);
}

Future<void> _openExternally(BuildContext context, ChatService svc, Payload p) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    final path = await svc.exportForOpen(p);
    await openWithSystem(path, (p['mime'] as String?) ?? '');
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text(_fileError(e))));
  }
}

Future<void> _save(BuildContext context, ChatService svc, Payload p) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    final path = await svc.saveFile(p);
    messenger.showSnackBar(SnackBar(content: Text('已保存到 $path')));
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text(_fileError(e))));
  }
}

String _fileError(Object e) =>
    e is ApiException && e.status == 404 ? '文件已过期（服务器只保留 14 天）' : '文件打不开：$e';

Future<void> showAttachmentMenu(BuildContext context, ChatService svc, Payload p) async {
  final choice = await showModalBottomSheet<String>(
    context: context,
    showDragHandle: true,
    builder: (context) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListTile(
            leading: const Icon(Icons.open_in_new),
            title: Text(Platform.isAndroid ? '用其他应用打开' : '用默认程序打开'),
            onTap: () => Navigator.pop(context, 'open'),
          ),
          ListTile(
            leading: const Icon(Icons.download_outlined),
            title: const Text('保存到「下载」'),
            onTap: () => Navigator.pop(context, 'save'),
          ),
        ],
      ),
    ),
  );
  if (!context.mounted) return;
  if (choice == 'open') {
    await _openExternally(context, svc, p);
  } else if (choice == 'save') {
    await _save(context, svc, p);
  }
}

String fileSizeText(int n) {
  if (n < 1024) return '$n B';
  if (n < 1024 * 1024) return '${(n / 1024).toStringAsFixed(1)} KB';
  return '${(n / 1024 / 1024).toStringAsFixed(1)} MB';
}

/* ---------------- 应用内预览（安卓） ---------------- */

class MediaViewer extends StatefulWidget {
  const MediaViewer({super.key, required this.svc, required this.payload});
  final ChatService svc;
  final Payload payload;

  @override
  State<MediaViewer> createState() => _MediaViewerState();
}

class _MediaViewerState extends State<MediaViewer> {
  Uint8List? _bytes;
  VideoPlayerController? _player;
  Object? _err;

  Payload get p => widget.payload;
  String get name => p['name'] as String? ?? '文件';
  MediaKind get kind => mediaKindOf(p['mime'] as String?, name);

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      if (kind == MediaKind.video || kind == MediaKind.audio) {
        // 播放器要读文件：解密到临时目录（退出应用下次启动会清掉）
        final path = await widget.svc.exportForOpen(p);
        final c = VideoPlayerController.file(File(path));
        await c.initialize();
        c.addListener(() {
          if (mounted) setState(() {});
        });
        if (!mounted) {
          await c.dispose();
          return;
        }
        setState(() => _player = c);
        await c.play();
      } else {
        final b = await widget.svc.fileBytes(p);
        if (mounted) setState(() => _bytes = b);
      }
    } catch (e) {
      if (mounted) setState(() => _err = e);
    }
  }

  @override
  void dispose() {
    _player?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final dark = kind == MediaKind.image || kind == MediaKind.video;
    final scheme = Theme.of(context).colorScheme;
    return Theme(
      data: dark ? ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: scheme.primary, brightness: Brightness.dark), fontFamily: Theme.of(context).textTheme.bodyMedium?.fontFamily) : Theme.of(context),
      child: Scaffold(
        backgroundColor: dark ? Colors.black : null,
        appBar: AppBar(
          backgroundColor: dark ? Colors.black : null,
          title: Text(name, overflow: TextOverflow.ellipsis),
          actions: [
            IconButton(
              tooltip: '保存到「下载」',
              icon: const Icon(Icons.download_outlined),
              onPressed: () => _save(context, widget.svc, p),
            ),
            IconButton(
              tooltip: '用其他应用打开',
              icon: const Icon(Icons.open_in_new),
              onPressed: () => _openExternally(context, widget.svc, p),
            ),
          ],
        ),
        body: SafeArea(child: _body(context)),
      ),
    );
  }

  Widget _body(BuildContext context) {
    final t = Theme.of(context);
    if (_err != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(_fileError(_err!), textAlign: TextAlign.center),
        ),
      );
    }
    switch (kind) {
      case MediaKind.image:
        if (_bytes == null) return const Center(child: CircularProgressIndicator());
        return InteractiveViewer(
          maxScale: 8,
          child: Center(child: Image.memory(_bytes!, fit: BoxFit.contain)),
        );
      case MediaKind.video:
      case MediaKind.audio:
        final c = _player;
        if (c == null) return const Center(child: CircularProgressIndicator());
        final v = c.value;
        return Column(
          children: [
            Expanded(
              child: Center(
                child: kind == MediaKind.video && v.size.width > 0
                    ? GestureDetector(
                        onTap: () => v.isPlaying ? c.pause() : c.play(),
                        child: AspectRatio(aspectRatio: v.aspectRatio, child: VideoPlayer(c)),
                      )
                    : Icon(Icons.audiotrack, size: 96, color: t.colorScheme.primary),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 0, 16, 16),
              child: Row(
                children: [
                  IconButton(
                    iconSize: 32,
                    icon: Icon(v.isPlaying ? Icons.pause : Icons.play_arrow),
                    onPressed: () => v.isPlaying ? c.pause() : c.play(),
                  ),
                  Text(_dur(v.position)),
                  Expanded(
                    child: Slider(
                      value: v.position.inMilliseconds.clamp(0, v.duration.inMilliseconds).toDouble(),
                      max: v.duration.inMilliseconds <= 0 ? 1 : v.duration.inMilliseconds.toDouble(),
                      onChanged: (x) => c.seekTo(Duration(milliseconds: x.round())),
                    ),
                  ),
                  Text(_dur(v.duration)),
                ],
              ),
            ),
          ],
        );
      case MediaKind.text:
        if (_bytes == null) return const Center(child: CircularProgressIndicator());
        final shown = _bytes!.length > 512 * 1024 ? Uint8List.sublistView(_bytes!, 0, 512 * 1024) : _bytes!;
        return SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: SelectableText(
            utf8.decode(shown, allowMalformed: true) + (shown.length < _bytes!.length ? '\n\n…（只显示前 512 KB）' : ''),
            style: t.textTheme.bodyMedium?.copyWith(fontFamily: 'monospace'),
          ),
        );
      case MediaKind.other:
        return const SizedBox.shrink();
    }
  }
}

String _dur(Duration d) {
  final s = d.inSeconds;
  final h = s ~/ 3600, m = (s % 3600) ~/ 60, sec = s % 60;
  String two(int x) => x.toString().padLeft(2, '0');
  return h > 0 ? '$h:${two(m)}:${two(sec)}' : '${two(m)}:${two(sec)}';
}
