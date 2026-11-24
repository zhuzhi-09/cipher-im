package io.github.zhuzhi_09.cipherim

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * 前台服务：只负责让进程不被系统回收（聊天连接本身在 Flutter 引擎里）。
 * 状态栏会常驻一条低优先级通知，这是安卓对前台服务的硬性要求。
 */
class KeepAliveService : Service() {
    companion object {
        private const val CHANNEL_ID = "keepalive"
        private const val NOTIFICATION_ID = 1
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "后台连接", NotificationManager.IMPORTANCE_MIN)
            ch.description = "保持和服务器的连接，才能在后台收到新消息"
            ch.setShowBadge(false)
            nm.createNotificationChannel(ch)
        }
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Cipher IM 正在后台运行")
            .setContentText("保持连接以接收新消息")
            .setContentIntent(open)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, n, type)
        // 被系统杀掉后自动重启：进程重启时 CipherApp 会重新拉起引擎和连接
        return START_STICKY
    }
}
