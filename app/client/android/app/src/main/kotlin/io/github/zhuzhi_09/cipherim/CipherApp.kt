package io.github.zhuzhi_09.cipherim

import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.FlutterEngineCache
import io.flutter.embedding.engine.dart.DartExecutor
import io.flutter.plugin.common.MethodChannel

/**
 * 进程一起来就启动 Flutter 引擎并缓存起来，不依赖界面是否打开。
 * 配合 KeepAliveService（前台服务）让进程常驻，聊天连接在后台也一直在线，
 * 不需要谷歌推送；进程被系统杀掉后，前台服务重启时会把引擎和连接一起带回来。
 */
class CipherApp : Application() {
    companion object {
        const val ENGINE_ID = "main"
        const val CHANNEL = "cipherim/android"
    }

    override fun onCreate() {
        super.onCreate()
        val engine = FlutterEngine(this)
        MethodChannel(engine.dartExecutor.binaryMessenger, CHANNEL).setMethodCallHandler { call, result ->
            when (call.method) {
                "startKeepAlive" -> {
                    try {
                        ContextCompat.startForegroundService(this, Intent(this, KeepAliveService::class.java))
                        result.success(true)
                    } catch (e: Exception) {
                        // 安卓 12+ 不允许从后台启动前台服务：等界面打开时再启动
                        result.success(false)
                    }
                }
                "stopKeepAlive" -> {
                    stopService(Intent(this, KeepAliveService::class.java))
                    result.success(true)
                }
                "ignoringBatteryOptimizations" -> {
                    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                    result.success(pm.isIgnoringBatteryOptimizations(packageName))
                }
                "requestIgnoreBatteryOptimizations" -> {
                    try {
                        startActivity(
                            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        )
                        result.success(true)
                    } catch (e: Exception) {
                        // 个别系统没有这个页面：退回到电池优化列表
                        startActivity(
                            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        )
                        result.success(false)
                    }
                }
                "openUrl" -> {
                    val url = call.argument<String>("url")
                    if (url == null || !url.startsWith("https://")) {
                        result.error("bad_url", "只打开 https 链接", null)
                    } else {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        result.success(true)
                    }
                }
                "openFile" -> {
                    // 用系统里能打开这种文件的应用打开（只允许缓存目录下 cipherim-open 里的文件）
                    try {
                        val f = File(call.argument<String>("path")!!)
                        val dir = File(cacheDir, "cipherim-open").canonicalPath
                        if (!f.canonicalPath.startsWith(dir + File.separator)) throw IllegalArgumentException("路径不对")
                        val uri = FileProvider.getUriForFile(this, "$packageName.files", f)
                        val mime = call.argument<String>("mime").takeUnless { it.isNullOrEmpty() } ?: "*/*"
                        val view = Intent(Intent.ACTION_VIEW)
                            .setDataAndType(uri, mime)
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        startActivity(
                            Intent.createChooser(view, "打开方式")
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        )
                        result.success(true)
                    } catch (e: android.content.ActivityNotFoundException) {
                        result.error("no_app", "没有能打开这种文件的应用", null)
                    } catch (e: Exception) {
                        result.error("open_failed", e.message, null)
                    }
                }
                else -> result.notImplemented()
            }
        }
        engine.dartExecutor.executeDartEntrypoint(DartExecutor.DartEntrypoint.createDefault())
        FlutterEngineCache.getInstance().put(ENGINE_ID, engine)
    }
}
