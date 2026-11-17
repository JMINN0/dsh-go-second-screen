package com.dsh.overlay;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 悬浮窗服务：把 AI 操作的虚拟屏画面浮在任何 App 上面。
 *
 * ## 为什么是独立 APK
 *
 * 插件跑在 proot 的 Node 里，画不了 Android 窗口。
 * 要浮在别的 App 上，必须有 SYSTEM_ALERT_WINDOW 权限的**安装包**。
 *
 * ## 数据来源
 *
 * 轮询插件推流服务的 HTTP 端点：
 *   http://127.0.0.1:<port>/frame.jpg   画面
 *   http://127.0.0.1:<port>/status      状态（state / aspect / running）
 *
 * ## 设计取舍
 *
 * - **不抢焦点**：FLAG_NOT_FOCUSABLE，用户还能正常打字
 * - **可拖动**：按住拖动，位置记住
 * - **点了缩起来**：单击收起成小球，再点展开（避免挡视线）
 * - **自己会消失**：/status 说 running=false 就自动关掉
 */
public class OverlayService extends Service {
    private static final String TAG = "DshOverlay";
    private static final String CH_ID = "dsh_overlay";
    private static final int CH_NUM = 4201;

    private WindowManager wm;
    private View root;
    private ImageView img;
    private TextView label;
    private Handler ui;
    private volatile boolean running = true;
    private int port = 0;
    private float aspect = 0.5f;
    private boolean collapsed = false;

    private WindowManager.LayoutParams lp;
    private int pollMs = 400;          // 帧轮询（推流本身 2-4fps，400ms 够）
    private long lastOk = 0;

    @Override
    public IBinder onBind(Intent i) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        ui = new Handler(Looper.getMainLooper());
        startForeground(CH_NUM, buildNotification("准备中…"));
    }

    @Override
    public int onStartCommand(Intent it, int flags, int startId) {
        if (it != null) {
            int p = it.getIntExtra("port", 0);
            if (p > 0 && p != port) { port = p; }
        }
        if (root == null) {
            show();
            loop();
        }
        return START_STICKY;
    }

    /** 建悬浮窗。 */
    private void show() {
        if (root != null) return;

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xE6101216);                  // 半透明深色底
        bg.setCornerRadius(dp(10));
        bg.setStroke(dp(1), 0x60FFFFFF);
        box.setBackground(bg);
        box.setPadding(dp(3), dp(3), dp(3), dp(3));

        img = new ImageView(this);
        img.setScaleType(ImageView.ScaleType.FIT_CENTER);
        LinearLayout.LayoutParams ilp =
                new LinearLayout.LayoutParams(dp(150), dp(150));
        box.addView(img, ilp);

        label = new TextView(this);
        label.setTextColor(Color.WHITE);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
        label.setGravity(Gravity.CENTER);
        label.setText("AI 画面");
        LinearLayout.LayoutParams tlp =
                new LinearLayout.LayoutParams(dp(150), LinearLayout.LayoutParams.WRAP_CONTENT);
        box.addView(label, tlp);

        root = box;

        int type = Build.VERSION.SDK_INT >= 26
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;

        lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                type,
                // 不抢焦点（用户还能打字）| 不占状态栏 | 常亮不需要
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                android.graphics.PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = dp(12);
        lp.y = dp(120);

        root.setOnTouchListener(new View.OnTouchListener() {
            float downX, downY;
            int startX, startY;
            boolean moved;
            long downAt;
            @Override public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = e.getRawX(); downY = e.getRawY();
                        startX = lp.x; startY = lp.y;
                        moved = false; downAt = System.currentTimeMillis();
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        int dx = (int)(e.getRawX() - downX);
                        int dy = (int)(e.getRawY() - downY);
                        if (Math.abs(dx) > dp(6) || Math.abs(dy) > dp(6)) moved = true;
                        if (moved) { lp.x = startX + dx; lp.y = startY + dy; wm.updateViewLayout(root, lp); }
                        return true;
                    case MotionEvent.ACTION_UP:
                        // 短按且没拖动 → 收起/展开
                        if (!moved && System.currentTimeMillis() - downAt < 400) toggle();
                        return true;
                }
                return false;
            }
        });

        try {
            wm.addView(root, lp);
            Log.i(TAG, "悬浮窗已添加");
        } catch (Exception e) {
            Log.e(TAG, "加悬浮窗失败: " + e.getMessage());
        }
    }

    /** 收起 / 展开。收起时只留一个小方块，少挡视线。 */
    private void toggle() {
        collapsed = !collapsed;
        if (collapsed) {
            img.setVisibility(View.GONE);
            label.setText("AI");
            label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        } else {
            img.setVisibility(View.VISIBLE);
            applyAspect();
            label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
        }
    }

    /** 按真实比例调整图片高度 —— 横屏游戏要变扁，不然被压成竖条。 */
    private void applyAspect() {
        if (img == null || collapsed) return;
        float a = (aspect > 0.15f && aspect < 8f) ? aspect : 0.5f;
        int w = dp(150);
        int h = Math.max(dp(60), Math.round(w / a));
        if (h > dp(260)) h = dp(260);
        img.setLayoutParams(new LinearLayout.LayoutParams(w, h));
    }

    /** 主循环：抓帧 + 抓状态。 */
    private void loop() {
        if (!running || port <= 0) {
            if (port <= 0) ui.postDelayed(new Runnable() { public void run() { loop(); } }, 500);
            return;
        }
        new Thread(new Runnable() {
            @Override public void run() {
                while (running) {
                    try {
                        String st = http("http://127.0.0.1:" + port + "/status");
                        if (st != null) {
                            boolean run = st.contains("\"running\":true");
                            if (!run) { // 推流停了 → 自己也关
                                ui.post(new Runnable() { public void run() { stopSelf(); } });
                                return;
                            }
                            float a = parseAspect(st);
                            if (a > 0.15f) { aspect = a; ui.post(new Runnable() { public void run() { applyAspect(); } }); }
                            String sname = parseState(st);
                            final String txt = sname;
                            ui.post(new Runnable() { public void run() { if (!collapsed) label.setText(txt); } });
                        }
                        byte[] jpg = httpBytes("http://127.0.0.1:" + port + "/frame.jpg");
                        if (jpg != null && jpg.length > 800) {
                            final Bitmap bm = BitmapFactory.decodeByteArray(jpg, 0, jpg.length);
                            if (bm != null) {
                                lastOk = System.currentTimeMillis();
                                ui.post(new Runnable() { public void run() { if (!collapsed) img.setImageBitmap(bm); } });
                            }
                        }
                    } catch (Throwable t) {
                        // 端口还没起来 / 推流暂停 —— 不算错，下一轮再试
                    }
                    try { Thread.sleep(pollMs); } catch (InterruptedException e) { return; }
                }
            }
        }).start();
    }

    private static float parseAspect(String st) {
        try {
            int i = st.indexOf("\"aspect\":");
            if (i < 0) return 0;
            String rest = st.substring(i + 9).trim();
            int end = 0;
            while (end < rest.length() && "0123456789.-".indexOf(rest.charAt(end)) >= 0) end++;
            return Float.parseFloat(rest.substring(0, end));
        } catch (Throwable t) { return 0; }
    }

    private static String parseState(String st) {
        try {
            int i = st.indexOf("\"state\":\"");
            if (i < 0) return "AI 画面";
            int s = i + 9, e = st.indexOf('"', s);
            String v = st.substring(s, e);
            if ("thinking".equals(v)) return "思考中";
            if ("looking".equals(v)) return "看屏幕";
            if ("acting".equals(v)) return "操作中";
            if ("done".equals(v)) return "已完成";
            if ("error".equals(v)) return "出错";
            return "AI 画面";
        } catch (Throwable t) { return "AI 画面"; }
    }

    private String http(String u) {
        byte[] b = httpBytes(u);
        return b == null ? null : new String(b);
    }

    private byte[] httpBytes(String u) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(u).openConnection();
            c.setConnectTimeout(1200);
            c.setReadTimeout(1500);
            c.setUseCaches(false);
            int code = c.getResponseCode();
            if (code != 200) return null;
            InputStream in = c.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
            return out.toByteArray();
        } catch (Throwable t) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private Notification buildNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CH_ID, "AI 画面", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CH_ID)
                : new Notification.Builder(this);
        b.setContentTitle("AI 画面")
         .setContentText(text)
         .setSmallIcon(android.R.drawable.ic_menu_view)
         .setOngoing(true);
        return b.build();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @Override
    public void onDestroy() {
        running = false;
        try { if (root != null && wm != null) wm.removeView(root); } catch (Throwable t) { }
        root = null;
        super.onDestroy();
    }
}
