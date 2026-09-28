package app.jeff.mobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/** 常驻通知。连接本身在 RelaySocket，回复完成时再弹一条可点的通知。 */
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

    companion object {
        fun show(context: android.content.Context, title: String, body: String, kind: String = "", id: String = "") {
            val channelId = "jeff-note"
            val nm = context.getSystemService(NotificationManager::class.java)
            if (Build.VERSION.SDK_INT >= 26) {
                nm.createNotificationChannel(NotificationChannel(channelId, "回复提醒", NotificationManager.IMPORTANCE_HIGH))
            }
            val openIntent = Intent(context, MainActivity::class.java)
            openIntent.flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            openIntent.putExtra("jeff_note_kind", kind)
            openIntent.putExtra("jeff_note_id", id)
            openIntent.putExtra("jeff_note_title", title)
            val open = android.app.PendingIntent.getActivity(
                context,
                2,
                openIntent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
            )
            val notification = NotificationCompat.Builder(context, channelId)
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentIntent(open)
                .setAutoCancel(true)
                .build()
            nm.notify(2, notification)
        }
    }
}
