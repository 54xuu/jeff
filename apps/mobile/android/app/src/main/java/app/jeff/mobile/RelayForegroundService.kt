package app.jeff.mobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/** 〇期只证明进程能在后台活着。一期再在这里维持到中转站的连接。 */
class RelayForegroundService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val channelId = "jeff-relay"
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(channelId, "远程连接", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        val notification = NotificationCompat.Builder(this, channelId)
            .setContentTitle("Jeff")
            .setContentText("正在保持远程连接")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build()
        startForeground(1, notification)
        return START_STICKY
    }
}
