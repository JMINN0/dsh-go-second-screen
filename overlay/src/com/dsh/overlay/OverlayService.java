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
    private Bitmap reuseBmp = null;   // 复用位图，减少 GC

    // **用户可自定义大小**（需求：能拖拽改大小，且不影响里面的 AI 操作）
    //
    // 为什么改大小不影响 AI：AI 操作的是**虚拟屏**（720×1592 不变），
    // 悬浮窗只是把画面缩放着显示。改的只是显示尺寸，不碰虚拟屏。
    private boolean hidden = false;   // 用户点了隐藏
    private boolean looping = false;  // loop 线程是否在跑（避免重复启动）
    private int portRetries = 0;      // 无端口时的重试计数（防无限自投递）
    private int userW = 0;            // 0 = 用默认值
    private int userH = 0;

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
        // **从持久化恢复端口。**
        // 服务被系统杀掉后重启（或点通知恢复）时 Intent 里没有 port，
        // 原来就直接 port=0 → 永远连不上，变成一个空窗口僵尸。
        if (port <= 0) {
            try {
                android.content.SharedPreferences sp =
                        getSharedPreferences("dsh_overlay", 0);
                port = sp.getInt("port", 0);
            } catch (Throwable t) { /* ignore */ }
        }
        if (it != null) {
            int p = it.getIntExtra("port", 0);
            if (p > 0 && p != port) {
                port = p;
                try {
                    getSharedPreferences("dsh_overlay", 0).edit().putInt("port", p).apply();
                } catch (Throwable t) { /* ignore */ }
            }
            if (it.getBooleanExtra("unhide", false)) { unhide(); }
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

        // **顶部工具条**：一个「✕」隐藏按钮 + 一个「—」收起按钮
        // 用户提的「还不能隐藏？」—— 现在能了。
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        TextView hideBtn = new TextView(this);
        hideBtn.setText("✕");
        hideBtn.setTextColor(0xCCFFFFFF);
        hideBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        hideBtn.setPadding(dp(8), 0, dp(8), 0);
        hideBtn.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                // 隐藏窗口但**不退出服务** —— 通知里点一下就能叫回来
                if (root != null) { root.setVisibility(View.GONE); root.setTag("hidden"); }
                hidden = true;
                postNotification("已隐藏，点这里恢复");
            }
        });
        bar.addView(hideBtn);
        TextView foldBtn = new TextView(this);
        foldBtn.setText("—");
        foldBtn.setTextColor(0xCCFFFFFF);
        foldBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        foldBtn.setPadding(dp(8), 0, dp(8), 0);
        foldBtn.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { toggle(); }
        });
        bar.addView(foldBtn);
        box.addView(bar, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        img = new ImageView(this);
        // **FIT_CENTER + adjustViewBounds + WRAP_CONTENT = 窗口紧贴画面。**
        // 原来用固定 150dp×150dp 的框，FIT_CENTER 把图缩在里面，四周全是留白，
        // 用户看到的就是「一个很大的背景框包着一小块画面」（用户截图报的问题）。
        img.setScaleType(ImageView.ScaleType.FIT_CENTER);
        img.setAdjustViewBounds(true);
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        box.addView(img, ilp);

        label = new TextView(this);
        label.setTextColor(Color.WHITE);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
        label.setGravity(Gravity.CENTER);
        label.setText("AI 画面");
        // **宽度必须是 WRAP_CONTENT，不能固定 150dp。**
        // 原来固定 150dp，即使画面缩小了，这一行照样把整个窗口撑到 150dp 宽，
        // 用户看到的「大黑边框」就是这个（用户截图报的问题）。
        LinearLayout.LayoutParams tlp =
                new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT);
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

        // **右下角缩放手柄**：拖动它改大小，不碰画面本身
        final View handle = new View(this);
        GradientDrawable hbg = new GradientDrawable();
        hbg.setColor(0x88FFFFFF);
        hbg.setCornerRadius(dp(4));
        handle.setBackground(hbg);
        LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(dp(18), dp(18));
        hlp.gravity = Gravity.END;
        box.addView(handle, hlp);
        handle.setOnTouchListener(new View.OnTouchListener() {
            float downX, downY;
            int startW, startH;
            @Override public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = e.getRawX(); downY = e.getRawY();
                        startW = img.getWidth() > 0 ? img.getWidth() : dp(150);
                        startH = img.getHeight() > 0 ? img.getHeight() : dp(150);
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        int nw = Math.max(dp(80), startW + (int)(e.getRawX() - downX));
                        int nh = Math.max(dp(60), startH + (int)(e.getRawY() - downY));
                        userW = nw; userH = nh;
                        appliedAspect = -1f;   // 强制按新宽度重算
                        applyAspect();
                        return true;
                    case MotionEvent.ACTION_UP:
                        return true;
                }
                return false;
            }
        });

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
            appliedAspect = -1f;    // 强制重算
            applyAspect();
            label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
        }
    }

    private float appliedAspect = -1f;

    /**
     * 按真实比例调整图片高度 —— 横屏游戏要变扁，不然被压成竖条。
     *
     * **只在比例真的变了才改布局。** 原来每 400ms 无条件 setLayoutParams，
     * 等于每轮一次完整 measure/layout，纯白烧（子代理审代码发现的）。
     */
    /**
     * 按真实比例设定显示尺寸。
     *
     * **不再写死宽高**：用 maxWidth/maxHeight 给上限，让 ImageView 自己按
     * adjustViewBounds 算出实际大小。这样画面有多大窗口就多大，没有多余留白。
     */
    private void applyAspect() {
        if (img == null || collapsed) return;
        float a = (aspect > 0.15f && aspect < 8f) ? aspect : 0.5f;
        if (Math.abs(a - appliedAspect) < 0.005f) return;
        appliedAspect = a;

        // **用精确尺寸，不用 maxWidth/maxHeight。**
        // maxWidth+adjustViewBounds 在某些比例下仍会 letterbox（用户报的「黑边」）；
        // 直接算好宽高等比设置，画面必然填满，一个像素都不剩。
        int screenW = getResources().getDisplayMetrics().widthPixels;
        int screenH = getResources().getDisplayMetrics().heightPixels;

        int w;
        int h;
        if (userW > 0) {
            // 用户拖过 → 听用户的宽度，高等比算
            w = userW;
            h = Math.max(dp(60), Math.round(w / a));
        } else {
            // **默认占屏宽 62%**（原来写死 150dp，横屏内容 2.21 时只有 68dp 高，一条细带）
            w = Math.round(screenW * 0.62f);
            h = Math.round(w / a);
            // 太高的（竖屏内容）限制在屏高 55% 以内，别挡整个屏幕
            int maxH = Math.round(screenH * 0.55f);
            if (h > maxH) { h = maxH; w = Math.round(h * a); }
        }
        // 宽度也别超过屏宽 92%
        int capW = Math.round(screenW * 0.92f);
        if (w > capW) { w = capW; h = Math.round(w / a); }

        img.setLayoutParams(new LinearLayout.LayoutParams(w, h));
        img.setAdjustViewBounds(false);
        img.setScaleType(ImageView.ScaleType.FIT_XY);
        img.requestLayout();
    }

    /** 主循环：抓帧 + 抓状态。 */
    private void loop() {
        // **先判 running**：服务销毁后不能再自投递，否则 Handler 拿着已销毁的
        // Service 无限 500ms 跑，是永久泄漏（对抗审查发现的）。
        if (!running) return;
        if (port <= 0) {
            // 没端口：最多重试 30 次（15 秒），之后放弃，不再无限自投递
            if (portRetries++ < 30) {
                ui.postDelayed(new Runnable() { public void run() { loop(); } }, 500);
            }
            return;
        }
        new Thread(new Runnable() {
            @Override public void run() {
                // **先试 MJPEG 长连接**：一有新帧立刻推，没有轮询拍频。
                // 连不上（老版本服务端 / 端口变了）就退回轮询。
                while (running) {
                    if (port <= 0) { sleep(500); continue; }
                    if (readMjpeg()) {
                        // 流断了（服务端重启/端口变），等一会儿重连
                        sleep(800);
                    } else {
                        // MJPEG 不通，走一次轮询再重试
                        pollOnce();
                        sleep(600);
                    }
                }
            }
        }).start();
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { }
    }

    /** 读一次状态，更新 aspect / state / 是否还在跑。 */
    private boolean pollStatus() {
        try {
            String st = http("http://127.0.0.1:" + port + "/status");
            if (st == null) return false;
            if (!st.contains("\"running\":true")) {
                ui.post(new Runnable() { public void run() { stopSelf(); } });
                return false;
            }
            final float a = parseAspect(st);
            if (a > 0.15f) { aspect = a; ui.post(new Runnable() { public void run() { applyAspect(); } }); }
            final String txt = parseState(st);
            ui.post(new Runnable() { public void run() { if (!collapsed) label.setText(txt); } });
            return true;
        } catch (Throwable t) { return false; }
    }

    /** 旧的轮询路径（MJPEG 不通时兜底）。 */
    private void pollOnce() {
        pollStatus();
        try {
            byte[] jpg = httpBytes("http://127.0.0.1:" + port + "/frame.jpg");
            if (jpg != null && jpg.length > 800) showJpeg(jpg);
        } catch (Throwable t) { }
    }

    /**
     * **MJPEG 长连接**。
     *
     * 协议：`multipart/x-mixed-replace; boundary=--dshframe`
     * 每帧：
     *   --dshframe\r\n
     *   Content-Type: image/jpeg\r\n
     *   Content-Length: N\r\n
     *   \r\n
     *   <N 字节 JPEG>
     *   \r\n
     *
     * 返回 true = 曾经连上过（说明服务端支持），false = 完全不通。
     */
    private boolean readMjpeg() {
        HttpURLConnection c = null;
        boolean everConnected = false;
        try {
            URL u = new URL("http://127.0.0.1:" + port + "/stream.mjpg");
            c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(1500);
            c.setReadTimeout(8000);       // 长连接：等帧可以久一点
            c.setUseCaches(false);
            c.setRequestProperty("Accept", "multipart/x-mixed-replace");
            int code = c.getResponseCode();
            if (code != 200) return false;
            everConnected = true;

            java.io.InputStream in = c.getInputStream();
            java.io.BufferedInputStream bis = new java.io.BufferedInputStream(in, 32768);

            // 每次读一个完整 multipart 段
            while (running) {
                // **隐藏时直接断开**：原来点 ✕ 只是把窗口设 GONE，
                // 解码和传输照跑，用户以为关了其实照样发热耗电。
                if (hidden) break;
                byte[] jpg = readOnePart(bis);
                if (jpg == null) break;          // 流结束
                if (jpg.length > 800) showJpeg(jpg);
                // **每 2 秒同步一次状态**。
                // 原来这里只写了 lastStatusAt 却从不调用 pollStatus，
                // 结果 aspect 永远不更新、状态文案冻在「AI 画面」、
                // applyAspect() 的 setMaxWidth 那半边根本没机会跑。
                long nowTs = System.currentTimeMillis();
                if (nowTs - lastStatusAt > 2000) {
                    lastStatusAt = nowTs;
                    if (!pollStatus()) return everConnected;   // 推流没了 → 让外层收工
                }
            }
        } catch (Throwable t) {
            // 断了
        } finally {
            if (c != null) try { c.disconnect(); } catch (Throwable ignore) { }
            lastStatusAt = 0;
        }
        return everConnected;
    }

    private long lastStatusAt = 0;

    /**
     * 从 multipart 流里读出一段 JPEG。
     *
     * 手写解析：找 boundary → 读 header 找 Content-Length → 按长度读 body。
     * 没有现成库，这样最省事也最稳（不依赖流里的换行细节）。
     */
    private byte[] readOnePart(java.io.BufferedInputStream in) {
        try {
            // 跳到下一段开头
            StringBuilder line = new StringBuilder();
            int prev = -1, cur;
            boolean inPart = false;
            // 先找到 boundary 行
            while (true) {
                cur = in.read();
                if (cur < 0) return null;
                if (cur == '\n') {
                    String L = line.toString().trim();
                    if (L.startsWith("--dshframe")) { inPart = true; line.setLength(0); break; }
                    line.setLength(0);
                } else if (cur != '\r') {
                    line.append((char) cur);
                    if (line.length() > 100) line.setLength(0);
                }
            }
            if (!inPart) return null;
            // 再读可能紧跟的第二个 boundary 行（有的实现会多一行）
            // 读 header 直到空行
            int len = -1;
            line.setLength(0);
            while (true) {
                cur = in.read();
                if (cur < 0) return null;
                if (cur == '\n') {
                    String L = line.toString().trim();
                    line.setLength(0);
                    if (L.isEmpty()) break;                 // header 结束
                    int ci = L.toLowerCase().indexOf("content-length:");
                    if (ci >= 0) {
                        try { len = Integer.parseInt(L.substring(ci + 15).trim()); } catch (Throwable ignore) { }
                    }
                } else if (cur != '\r') {
                    line.append((char) cur);
                }
            }
            if (len <= 0 || len > 4_000_000) return null;
            byte[] buf = new byte[len];
            int off = 0;
            while (off < len) {
                int r = in.read(buf, off, len - off);
                if (r < 0) return null;
                off += r;
            }
            return buf;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 显示一帧 JPEG（带 Bitmap 复用）。 */
    private void showJpeg(byte[] jpg) {
        try {
            BitmapFactory.Options opt = new BitmapFactory.Options();
            opt.inBitmap = reuseBmp;
            opt.inMutable = true;
            Bitmap bm;
            try {
                bm = BitmapFactory.decodeByteArray(jpg, 0, jpg.length, opt);
            } catch (Throwable te) {
                opt.inBitmap = null;
                bm = BitmapFactory.decodeByteArray(jpg, 0, jpg.length, opt);
            }
            if (bm == null) return;
            reuseBmp = bm;
            lastOk = System.currentTimeMillis();
            final Bitmap fb = bm;
            ui.post(new Runnable() { public void run() { if (!collapsed) img.setImageBitmap(fb); } });
        } catch (Throwable t) { }
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
            // **不再每轮 disconnect。** 原来 2.5 次/秒重建 TCP，
            // 杀掉 keep-alive 还堆 TIME_WAIT。读完之后关流就够，连接会被复用。
            if (c != null) {
                try {
                    java.io.InputStream is = c.getInputStream();
                    if (is != null) { /* 已在上面读完 */ }
                } catch (Throwable ignore) { }
            }
        }
    }

    /** 更新通知（用来提示「已隐藏，点这里恢复」）。 */
    private void postNotification(String text) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.notify(CH_NUM, buildNotification(text));
        } catch (Throwable t) { }
    }

    /** 恢复显示。 */
    private void unhide() {
        hidden = false;
        portRetries = 0;                       // 重新允许重试连端口
        if (root != null) { root.setVisibility(View.VISIBLE); }
        applyAspect();
        // 重新开循环（隐藏时可能已经把 MJPEG 断开了）
        if (!looping) { looping = true; loop(); }
        postNotification("看屏幕");
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
        // **点通知恢复显示** —— 隐藏之后这是唯一的叫回入口
        try {
            Intent open = new Intent(this, OverlayService.class);
            open.putExtra("unhide", true);
            int flags = Build.VERSION.SDK_INT >= 23
                    ? android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE
                    : android.app.PendingIntent.FLAG_UPDATE_CURRENT;
            b.setContentIntent(android.app.PendingIntent.getService(this, 1, open, flags));
        } catch (Throwable t) { }
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
