# Cipher IM 原生客户端

Flutter 写的 Windows / 安卓客户端，和 Web 端共用服务端与线协议，能互发消息。加密逻辑在 [`../core`](../core)（与 Web 端逐字节兼容）。约定见 [`docs/CLIENT.md`](../../docs/CLIENT.md)。

## 现在能做什么

- 首次启动填服务器地址（没有默认值，必须是 https://），校验确实是 Cipher IM 服务器
- 注册（需要邀请码）、在本机登录已有账号（登记为一台新设备）
- 单聊、群聊、已读回执、「正在输入」、离线消息补收、14 天内的漫游历史
- 收文件（解密后存进「下载」文件夹）
- 界面：标准 Material 3（安卓 12+ 跟随壁纸取色，Windows 跟随系统强调色，取不到时用品牌蓝），宽屏两栏、窄屏单栏
- Windows：关窗口藏到托盘，连接保持在线；收到消息在本机解密后弹系统通知；可设开机自启（启动后直接进托盘）
- 安卓：前台服务让进程常驻，关掉界面（返回键、从最近任务划掉）也一直在线、收到消息弹通知，不依赖谷歌推送；设置里可以申请「不受电池优化限制」。Flutter 引擎在 `CipherApp` 里随进程启动并缓存，界面只是挂在上面

- 检查更新：每天最多一次看 GitHub 上最新的正式版（访问 github.com/…/releases/latest，不走有频率限制的 API），有新版提示并能直接下载本平台安装包；设置里可以关掉自动检查或手动检查

还没做：发文件、安全码核对、群成员管理、Windows 安装程序。

## 本机密钥库

和 Web 端不同，客户端不在每次启动时要口令：密钥库用一把随机的本机密钥加密，这把密钥交给系统安全存储保管（Windows DPAPI / 安卓 Keystore），只有本机当前系统用户能取出。退出账号会把密钥库和这把密钥一起删掉。

## 构建

发新版：改 `pubspec.yaml` 的 `version`，打 `v1.2.3` 这样的标签推上去，Actions 会把版本号写进安装包并发 Release（客户端的检查更新就是看它）。

推到 `main` 时 GitHub Actions（[`.github/workflows/client.yml`](../../.github/workflows/client.yml)）会跑测试并打出 Windows zip 和安卓 APK；推 `v*` 标签会发 Release。

本地构建：

```bash
flutter pub get
flutter build windows --release   # 需要 Visual Studio 的 C++ 桌面开发组件
flutter build apk --release
```

插件构建要建符号链接：Windows 需打开「开发者模式」，项目不能放在网络共享盘上。

联测（会起一个本地服务端，需要先在仓库根目录 `bash scripts/build.sh`）：

```bash
flutter test
```

## 安卓签名

正式签名密钥**不进仓库**。本地构建放 `android/key.properties`（`storeFile`、`storePassword`、`keyAlias`、`keyPassword`）；CI 用仓库 Secrets：`ANDROID_KEYSTORE_BASE64`、`ANDROID_STORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`。都没有时用调试签名，只适合自己测试——之后换成正式签名，已装的调试版要先卸载才能装。

## 图标

`python tool/make_icon.py` 重新生成 `windows/runner/resources/app_icon.ico` 和 `assets/` 里的图标（只用标准库）。
