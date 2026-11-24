library;

import 'package:flutter/material.dart';

import '../update.dart';

/// 发现新版本：可以看更新说明（发布页），或直接用浏览器下载本平台的安装包
Future<void> showUpdateDialog(BuildContext context, UpdateInfo info) {
  return showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      icon: const Icon(Icons.system_update_outlined),
      title: Text('有新版本 ${info.version}'),
      content: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Text(
          info.assetUrl == null
              ? '当前版本 $appVersion。会打开发布页面，自己选安装包下载。'
              : '当前版本 $appVersion。点「下载」会用浏览器下载 ${info.assetName}，下载完安装覆盖即可，聊天记录不受影响。',
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('以后再说')),
        TextButton(
          onPressed: () {
            Navigator.pop(context);
            openUrl(info.pageUrl);
          },
          child: const Text('更新说明'),
        ),
        TextButton(
          onPressed: () {
            Navigator.pop(context);
            openUrl(info.assetUrl ?? info.pageUrl);
          },
          child: const Text('下载'),
        ),
      ],
    ),
  );
}
