package com.shuati.bao;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import android.app.Notification;

/**
 * 前台保活服务（第二期）：AI 长任务（批量解题 / 导入兜底 / 转范式）进行时拉起，
 * 作用有三：① 前台+通知 → 进程不被系统当后台杀；② PARTIAL_WAKE_LOCK → 锁屏后 CPU 继续；
 * ③ 通知栏实时进度 → 用户随时可看可停。
 * 任务结束时必须调 stop()（JS 侧 finally 保证），通知随之消失、唤醒锁释放。
 */
public class KeepAliveService extends Service {

    private static final String CHANNEL_ID = "task_progress";
    private static final int NOTI_ID = 42;
    /** 最近一次进度文案（startForeground 时机晚于 start 时兜底显示用） */
    private static volatile String lastText = "";

    private PowerManager.WakeLock wakeLock;

    /* ---- 静态入口：JS 桥（主线程调用） ---- */
    public static void start(Context c, String text) {
        lastText = text == null ? "" : text;
        Intent i = new Intent(c, KeepAliveService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
        else c.startService(i);
    }

    /** 进度更新：服务活着时刷新通知；通知管理器直接 notify，不经过服务实例（轻量、锁屏可用） */
    public static void update(Context c, String text) {
        if (text != null) lastText = text;
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTI_ID, build(c, lastText));
        } catch (Exception ignored) {
            // 通知权限被拒等场景：保活不受影响，仅无可见进度
        }
    }

    public static void stop(Context c) {
        lastText = "";
        c.stopService(new Intent(c, KeepAliveService.class));
    }

    private static Notification build(Context c, String text) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "AI 任务进度",
                    NotificationManager.IMPORTANCE_LOW); // 低优先级：无声不弹横幅，只在通知栏常驻
            ch.setDescription("AI 批量解题/导入进行时的后台进度");
            nm.createNotificationChannel(ch);
        }
        // 轻量构建不引入 androidx.core：直接用框架 Notification.Builder；
        // 渠道构造器是 API 26+ 的，低版本走单参构造器（安装时授权，无运行时通知权限）
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(c, CHANNEL_ID)
                : new Notification.Builder(c);
        return b
                .setSmallIcon(R.drawable.ic_fg)
                .setContentTitle("刷题宝 · AI 任务进行中")
                .setContentText(text == null || text.isEmpty() ? "任务进行中，请保持网络畅通" : text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setProgress(0, 0, true)
                .build();
    }

    @Override
    public void onCreate() {
        super.onCreate();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTI_ID, build(this, lastText));
        // 锁屏后 CPU 仍运行：WebView 里的 JS 任务才不会被冻结。
        // acquire(2h) 上限保险：即使 JS 侧异常没调 stop，最多 2 小时自动放弃，杜绝常亮耗电泄漏
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "shuati:ai-task");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(2 * 60 * 60 * 1000L);
        }
        return START_NOT_STICKY; // 进程被强杀不自动重启：任务状态已逐批落库，用户重进点按钮续跑更可靠
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
