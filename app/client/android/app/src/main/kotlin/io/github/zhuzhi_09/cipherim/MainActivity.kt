package io.github.zhuzhi_09.cipherim

import io.flutter.embedding.android.FlutterActivity

/**
 * 界面只是「挂」在 CipherApp 里常驻的 Flutter 引擎上：
 * 关掉界面（返回键、从最近任务划掉）只销毁这个 Activity，引擎和聊天连接都还在。
 */
class MainActivity : FlutterActivity() {
    override fun getCachedEngineId(): String = CipherApp.ENGINE_ID
}
