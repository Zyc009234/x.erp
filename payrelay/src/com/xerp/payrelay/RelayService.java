package com.xerp.payrelay;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

public class RelayService extends Service {
    private static final String CHANNEL = "xerp-relay";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable beat = new Runnable() {
        @Override public void run() {
            new Thread(() -> {
                try { RelayClient.post(getApplicationContext(), "/api/relay/heartbeat", "heartbeat", 0, ""); }
                catch (Exception ignored) {}
            }).start();
            handler.postDelayed(this, 60000);
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "收款助手", NotificationManager.IMPORTANCE_LOW);
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setContentTitle("x.erp 收款助手运行中")
            .setContentText("正在监听微信/支付宝到账通知")
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setOngoing(true);
        startForeground(1001, b.build());
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        handler.removeCallbacks(beat);
        handler.post(beat);
        return START_STICKY;
    }

    @Override public void onDestroy() {
        handler.removeCallbacks(beat);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    public static void start(Context c) {
        Intent i = new Intent(c, RelayService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
        else c.startService(i);
    }
}
