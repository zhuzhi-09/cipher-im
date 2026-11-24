/// 附件类型判断：哪些能在对话里直接显示、哪些能在应用内预览
library;

import 'dart:io';

import 'package:flutter/services.dart';

/// 用系统里关联的软件打开本地文件（Windows：默认程序；安卓：选择打开方式）
Future<void> openWithSystem(String path, String mime) async {
  if (Platform.isWindows) {
    // explorer 打开文件 = 双击它，用默认程序
    await Process.start('explorer', [path]);
  } else if (Platform.isAndroid) {
    try {
      await const MethodChannel('cipherim/android').invokeMethod('openFile', {'path': path, 'mime': mime});
    } on PlatformException catch (e) {
      throw StateError(e.message ?? '打不开');
    }
  } else if (Platform.isMacOS) {
    await Process.start('open', [path]);
  } else if (Platform.isLinux) {
    await Process.start('xdg-open', [path]);
  }
}

const _ext = <String, String>{
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'png': 'image/png',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'bmp': 'image/bmp',
  'heic': 'image/heic',
  'mp4': 'video/mp4',
  'mov': 'video/quicktime',
  'webm': 'video/webm',
  'mkv': 'video/x-matroska',
  '3gp': 'video/3gpp',
  'mp3': 'audio/mpeg',
  'm4a': 'audio/mp4',
  'aac': 'audio/aac',
  'ogg': 'audio/ogg',
  'opus': 'audio/opus',
  'wav': 'audio/wav',
  'flac': 'audio/flac',
  'txt': 'text/plain',
  'md': 'text/markdown',
  'log': 'text/plain',
  'csv': 'text/csv',
  'json': 'application/json',
  'pdf': 'application/pdf',
  'zip': 'application/zip',
  'apk': 'application/vnd.android.package-archive',
};

String _extOf(String name) {
  final dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
}

/// 按扩展名猜 MIME（选文件的接口不一定给类型）
String mimeFromName(String name) => _ext[_extOf(name)] ?? 'application/octet-stream';

enum MediaKind { image, video, audio, text, other }

/// 看 MIME，没有就看扩展名
MediaKind mediaKindOf(String? mime, String name) {
  final m = (mime == null || mime.isEmpty || mime == 'application/octet-stream') ? mimeFromName(name) : mime;
  // Flutter 自带解码器能显示的图片；HEIC 不行，当普通文件
  if (const {'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'}.contains(m)) return MediaKind.image;
  if (m.startsWith('video/')) return MediaKind.video;
  if (m.startsWith('audio/')) return MediaKind.audio;
  if (m.startsWith('text/') || m == 'application/json') return MediaKind.text;
  return MediaKind.other;
}
