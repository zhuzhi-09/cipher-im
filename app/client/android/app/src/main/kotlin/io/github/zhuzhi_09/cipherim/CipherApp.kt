package io.github.zhuzhi_09.cipherim

import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
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
                else -> result.notImplemented()
            }
        }
        engine.dartExecutor.executeDartEntrypoint(DartExecutor.DartEntrypoint.createDefault())
        FlutterEngineCache.getInstance().put(ENGINE_ID, engine)
    }
}
