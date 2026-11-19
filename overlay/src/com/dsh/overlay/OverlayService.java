package com.dsh.overlay;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
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

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 多窗口悬浮显示器 —— 一块虚拟屏一个窗口。
 *
 * ## 为什么重写成多窗口
 *
 * 上一版是单窗口：所有字段（root/img/label/lp/port）都是单实例，
 * 第二块屏 `am start` 进来只是把 port 换掉 → **第 1 块的窗口被顶掉**。
 * 用户开 N 块屏，永远只能看到最后一块（用户实测报的「没看到别的对话的后台屏」）。
 *
 * ## 架构
 *
 *   OverlayService          —— 只管 Service 生命周期、通知、端口分发
 *     └ Map<Integer, Win>   —— 每个 port 一个 Win（= 一个悬浮窗）
 *          Win              —— 独自持有视图树、布局参数、轮询线程、缩放状态
 *
 * **关键不变式**：port 是窗口的身份。同一个 port 再来一次 = 更新那一个窗口，
 * 不会新建、也不会影响别的窗口。
 *
 * ## 级联布局
 *
 * 第 n 个窗口初始位置阶梯错开，超出屏幕就换列并收缩偏移，
 * 保证 N 个窗口互不重叠且都在屏内（见 {@link #cascadePos}）。
 */
public class OverlayService extends Service {
    private static final String TAG = "DshOverlay";
    private static final String CH_ID = "dsh_overlay";
    private static final int CH_NUM = 4201;

    private WindowManager wm;
    private Handler ui;
    private volatile boolean running = true;

    /** port → 窗口。LinkedHashMap 保证级联顺序稳定（按启动先后）。 */
    private final Map<Integer, Win> wins = new LinkedHashMap<>();

    @Override
    public IBinder onBind(Intent i) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        ui = new Handler(Looper.getMainLooper());
        startForeground(CH_NUM, buildNotification());
    }

    @Override
    public int onStartCommand(Intent it, int flags, int startId) {
        if (it == null) return START_STICKY;

        // ① 全停
        if (it.getBooleanExtra("stop", false)) {
            closeAll();
            stopSelf();
            return START_NOT_STICKY;
        }

        // ② 关掉指定 port（一块屏停止推流时调用，不该把别的窗口也关了）
        int closePort = it.getIntExtra("closePort", 0);
        if (closePort > 0) {
            removeWin(closePort);
            if (wins.isEmpty()) { stopSelf(); return START_NOT_STICKY; }
            updateNotification();
            return START_STICKY;
        }

        // ③ 新建/更新一个窗口
        int p = it.getIntExtra("port", 0);
        if (p > 0) {
            Win w = wins.get(p);
            if (w == null) {
                w = new Win(p);
                wins.put(p, w);
                w.show();          // 位置按当前 wins.size() 级联
            }
            w.startLoop();
            updateNotification();
        } else if (wins.isEmpty()) {
            // 没有 port 也没有窗口：从持久化里恢复（服务被杀后重启）
            try {
                android.content.SharedPreferences sp = getSharedPreferences("dsh_overlay", 0);
                String saved = sp.getString("ports", "");
                for (String s : saved.split(",")) {
                    try {
                        int q = Integer.parseInt(s.trim());
                        if (q > 0 && !wins.containsKey(q)) {
                            Win w = new Win(q);
                            wins.put(q, w);
                            w.show();
                            w.startLoop();
                        }
                    } catch (NumberFormatException ignore) { }
                }
            } catch (Throwable t) { /* ignore */ }
            updateNotification();
        }
        persistPorts();
        return START_STICKY;
    }

    private void persistPorts() {
        try {
            StringBuilder sb = new StringBuilder();
            for (Integer q : wins.keySet()) {
                if (sb.length() > 0) sb.append(',');
                sb.append(q);
            }
            getSharedPreferences("dsh_overlay", 0).edit().putString("ports", sb.toString()).apply();
        } catch (Throwable t) { /* ignore */ }
    }

    /** 关掉一个窗口（只关这一个）。 */
    private void removeWin(int p) {
        Win w = wins.remove(p);
        if (w != null) w.close();
        persistPorts();
    }

    /** 全部关掉。 */
    private void closeAll() {
        for (Win w : wins.values()) { try { w.close(); } catch (Throwable t) { /* ignore */ } }
        wins.clear();
        persistPorts();
    }

    /**
     * 重排所有「自动定位」的窗口，**按每个窗口的实际高度纵向累加**。
     *
     * ## 为什么不能用固定阶梯
     *
     * 固定步长 64dp 在窗口高度不同时会重叠：
     * 横屏窗口高约 341px、竖屏高达 1478px，同样的步长既浪费空间又压在一起。
     * 用户拖动过的窗口标记 auto=false，**不动它**（只避开）。
     *
     * 算法：从上往下累加，一个字放不下就换列。
     */
    private void relayoutAuto() {
        int screenW = getResources().getDisplayMetrics().widthPixels;
        int screenH = getResources().getDisplayMetrics().heightPixels;
        int startX = dp(12);
        int startY = dp(120);
        int gap = dp(10);
        int colW = 0;          // 当前列已用宽度（该列最宽的窗口）
        int x = startX, y = startY;

        for (Win w : wins.values()) {
            if (!w.autoPos || w.root == null || w.lp == null) continue;
            int ww = w.curW > 0 ? w.curW : Math.round(screenW * 0.46f);
            int wh = w.curH > 0 ? w.curH : dp(200);

            // 当前列放不下了 → 换列
            if (y + wh > screenH - dp(40) && y > startY) {
                x = x + colW + gap;
                y = startY;
                colW = 0;
            }
            // 换列后还是放不下（窗口比屏还高）→ 从顶部强行放
            if (y + wh > screenH - dp(40)) y = startY;

            w.lp.x = x;
            w.lp.y = y;
            try { wm.updateViewLayout(w.root, w.lp); } catch (Throwable t) { /* ignore */ }
            y += wh + gap;
            if (ww > colW) colW = ww;
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        closeAll();
        super.onDestroy();
    }

    // ═══════════════════════════════════════════════════════════════
    // 单个窗口
    // ═══════════════════════════════════════════════════════════════

    private class Win {
        final int port;
        volatile boolean alive = true;
        volatile boolean looping = false;

        View root;
        ImageView img;
        TextView label;
        WindowManager.LayoutParams lp;

        float aspect = 0.5f;
        float appliedAspect = -1f;
        boolean autoPos = true;   // 用户拖过就设 false，重排时不动它
        int curW = 0, curH = 0;   // 当前实际尺寸（relayoutAuto 要用）
        boolean collapsed = false;
        int userW = 0, userH = 0;
        long lastOk = 0;
        int portRetries = 0;
        long lastFrameAt = 0;        // 上一帧显示时间（限帧用）
        int dropped = 0;             // 被限帧丢掉的帧数（诊断）

        Win(int port) { this.port = port; }

        /** 建这个窗口的视图树并加进 WindowManager。 */
        void show() {
            if (root != null) return;

            LinearLayout box = new LinearLayout(OverlayService.this);
            box.setOrientation(LinearLayout.VERTICAL);
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(0xE6101216);
            bg.setCornerRadius(dp(10));
            bg.setStroke(dp(1), 0x60FFFFFF);
            box.setBackground(bg);
            box.setPadding(dp(3), dp(3), dp(3), dp(3));

            // 顶栏：✕ 关自己 / — 收起
            LinearLayout bar = new LinearLayout(OverlayService.this);
            bar.setOrientation(LinearLayout.HORIZONTAL);
            bar.setGravity(Gravity.CENTER_VERTICAL);
            TextView closeBtn = new TextView(OverlayService.this);
            closeBtn.setText("✕");
            closeBtn.setTextColor(0xCCFFFFFF);
            closeBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            closeBtn.setPadding(dp(8), 0, dp(8), 0);
            closeBtn.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    // **只关自己这一个窗口**，不碰别的
                    ui.post(new Runnable() { public void run() { removeWin(port); } });
                }
            });
            bar.addView(closeBtn);
            TextView foldBtn = new TextView(OverlayService.this);
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

            img = new ImageView(OverlayService.this);
            img.setScaleType(ImageView.ScaleType.FIT_XY);
            box.addView(img, new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));

            label = new TextView(OverlayService.this);
            label.setTextColor(Color.WHITE);
            label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
            label.setGravity(Gravity.CENTER);
            label.setText("屏 " + port);
            box.addView(label, new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));

            // 右下缩放手柄
            View handle = new View(OverlayService.this);
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
                            userW = nw; userH = nw;
                            appliedAspect = -1f;
                            applyAspect();
                            return true;
                    }
                    return false;
                }
            });

            root = box;

            int type = Build.VERSION.SDK_INT >= 26
                    ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                    : WindowManager.LayoutParams.TYPE_PHONE;
            lp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, type,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                    android.graphics.PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.TOP | Gravity.START;

            // 先给个临时位置，等第一帧拿到尺寸后 relayoutAuto() 会重排
            lp.x = dp(12);
            lp.y = dp(120) + wins.size() * dp(60);

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
                            if (moved) {
                                autoPos = false;   // **用户拖过 → 以后重排不动它**（否则下次加窗会跳回去）
                                lp.x = startX + dx; lp.y = startY + dy;
                                try { wm.updateViewLayout(root, lp); } catch (Throwable t) { /* ignore */ }
                            }
                            return true;
                        case MotionEvent.ACTION_UP:
                            if (!moved && System.currentTimeMillis() - downAt < 400) toggle();
                            return true;
                    }
                    return false;
                }
            });

            try {
                wm.addView(root, lp);
                Log.i(TAG, "窗口已添加 port=" + port + " x=" + lp.x + " y=" + lp.y);
            } catch (Exception e) {
                Log.e(TAG, "加窗口失败 port=" + port + ": " + e.getMessage());
            }
        }

        void toggle() {
            collapsed = !collapsed;
            if (img != null) img.setVisibility(collapsed ? View.GONE : View.VISIBLE);
            if (label != null) {
                label.setText(collapsed ? String.valueOf(port) : ("屏 " + port));
                label.setTextSize(TypedValue.COMPLEX_UNIT_SP, collapsed ? 11 : 10);
            }
            if (!collapsed) { appliedAspect = -1f; applyAspect(); }
        }

        /** 按真实比例设定显示尺寸（精确尺寸，避免 letterbox）。 */
        void applyAspect() {
            if (img == null || collapsed) return;
            float a = (aspect > 0.15f && aspect < 8f) ? aspect : 0.5f;
            if (Math.abs(a - appliedAspect) < 0.005f) return;
            appliedAspect = a;

            int screenW = getResources().getDisplayMetrics().widthPixels;
            int screenH = getResources().getDisplayMetrics().heightPixels;
            int w, h;
            if (userW > 0) {
                w = userW;
                h = Math.max(dp(60), Math.round(w / a));
            } else {
                // **多窗口时默认小一点**：一份 62% 屏宽，三份叠起来就满了。
                // 按已有窗口数收缩：1 个 62%，2-3 个 46%，4+ 个 38%。
                int n = Math.max(1, wins.size());
                float frac = n <= 1 ? 0.62f : (n <= 3 ? 0.46f : 0.38f);
                w = Math.round(screenW * frac);
                h = Math.round(w / a);
                int maxH = Math.round(screenH * (n <= 1 ? 0.55f : 0.34f));
                if (h > maxH) { h = maxH; w = Math.round(h * a); }
            }
            int capW = Math.round(screenW * 0.92f);
            if (w > capW) { w = capW; h = Math.round(w / a); }

            img.setLayoutParams(new LinearLayout.LayoutParams(w, h));
            img.requestLayout();
            // 记下实际尺寸，并重排所有自动窗口（第一次拿到比例时位置才准）
            boolean sizeChanged = (curW != w + dp(6) || curH != h + dp(50));
            curW = w + dp(6);        // 加上内边距和边框
            curH = h + dp(50);       // 加上工具条 + 标签 + 手柄
            if (sizeChanged) ui.post(new Runnable() { public void run() { relayoutAuto(); } });
        }

        /** 起轮询线程（幂等）。 */
        void startLoop() {
            if (looping || !alive) return;
            looping = true;
            new Thread(new Runnable() {
                @Override public void run() {
                    while (alive && running) {
                        try {
                            if (readMjpeg()) { sleep(600); continue; }
                        } catch (Throwable t) { /* 流断了，重连 */ }
                        sleep(600);
                    }
                }
            }, "overlay-" + port).start();
        }

        /** MJPEG 长连接：一有新帧立刻显示。返回 true 表示「连上过但断了」。 */
        boolean readMjpeg() {
            HttpURLConnection c = null;
            boolean everConnected = false;
            try {
                c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/stream.mjpg").openConnection();
                c.setConnectTimeout(2500);
                c.setReadTimeout(20000);
                c.setUseCaches(false);
                int code = c.getResponseCode();
                if (code != 200) return false;
                everConnected = true;
                lastOk = System.currentTimeMillis();
                BufferedInputStream in = new BufferedInputStream(c.getInputStream(), 1 << 16);
                while (alive && running) {
                    byte[] jpg = readOnePart(in);
                    if (jpg == null) break;
                    lastOk = System.currentTimeMillis();
                    showJpeg(jpg);
                    // 每帧顺手看看状态（便宜，2 秒一次）
                    if (System.currentTimeMillis() - lastStatusAt > 2000) {
                        lastStatusAt = System.currentTimeMillis();
                        if (!pollStatus()) break;
                    }
                }
            } catch (Throwable t) {
                // 连接失败是常态（服务端没起），不刷日志
            } finally {
                try { if (c != null) c.disconnect(); } catch (Throwable t) { /* ignore */ }
            }
            return everConnected;
        }

        long lastStatusAt = 0;

        /**
         * 从 multipart 流里读一帧 JPEG。
         *
         * **第一版有 bug**：每遇到 '\n' 就 reset 缓冲区，结果只留下最后一行，
         * Content-Length 那行被清掉 → len<=0 → 返回 null → 窗口永远不显示。
         * 正确做法：把整个头部块（直到空行）累积起来再解析。
         */
        byte[] readOnePart(InputStream in) throws Exception {
            // ① 一次读一个字节累积整块头部，直到遇到空行（\r\n\r\n）
            ByteArrayOutputStream hb = new ByteArrayOutputStream();
            int b;
            int nl = 0;   // 连续换行计数
            while ((b = in.read()) != -1) {
                hb.write(b);
                if (b == '\n') {
                    nl++;
                    if (nl == 2) break;      // 空行 = 头部结束
                } else if (b != '\r') {
                    nl = 0;
                }
                if (hb.size() > 8192) break;  // 头部异常，放弃这一帧
            }
            String hdr = new String(hb.toByteArray(), "UTF-8");
            int len = -1;
            int ci = hdr.toLowerCase().indexOf("content-length:");
            if (ci >= 0) {
                int e = ci + 15;
                while (e < hdr.length() && !Character.isDigit(hdr.charAt(e))) e++;
                int st = e;
                while (e < hdr.length() && Character.isDigit(hdr.charAt(e))) e++;
                if (e > st) {
                    try { len = Integer.parseInt(hdr.substring(st, e)); } catch (Throwable t) { /* ignore */ }
                }
            }
            if (len <= 0 || len > 8_000_000) return null;

            // ② 精确读 len 字节
            byte[] buf = new byte[len];
            int off = 0;
            while (off < len) {
                int n = in.read(buf, off, len - off);
                if (n < 0) return null;
                off += n;
            }
            return buf;
        }

        /**
         * 解码并显示一帧。
         *
         * **限帧是必须的。** MJPEG 是全速推的（服务端有新帧就发），
         * 单窗口无所谓，但 N 个窗口时解码量 = N × 推送帧率：
         * 5 个窗口 × 50fps = 250 次解码/秒，主线程必然堆积、GC 抖动。
         *
         * 上限按窗口数动态算：1 个窗口 30fps，2-3 个 15fps，4+ 个 8fps。
         * 超出的帧直接丢（**丢掉比排队好** —— 排队只会越来越延迟）。
         */
        void showJpeg(byte[] jpg) {
            long now = System.currentTimeMillis();
            int n = Math.max(1, wins.size());
            int capFps = n <= 1 ? 30 : (n <= 3 ? 15 : 8);
            if (now - lastFrameAt < (1000 / capFps)) { dropped++; return; }
            lastFrameAt = now;
            try {
                // 收起/不可见时不解码 —— 反正用户看不到
                if (collapsed || root == null || root.getVisibility() != View.VISIBLE) return;
                Bitmap bm = BitmapFactory.decodeByteArray(jpg, 0, jpg.length);
                if (bm == null) return;
                final Bitmap fb = bm;
                // 更新比例（用解码出来的真实尺寸）
                float a = (float) fb.getWidth() / Math.max(1, fb.getHeight());
                if (Math.abs(a - aspect) > 0.01f) {
                    aspect = a;
                    ui.post(new Runnable() { public void run() { applyAspect(); } });
                }
                ui.post(new Runnable() {
                    public void run() {
                        if (img != null && !collapsed && alive) img.setImageBitmap(fb);
                    }
                });
            } catch (Throwable t) { /* 单帧解码失败不影响流 */ }
        }

        /** 查 /status；服务端说没在跑就关掉自己这个窗口。 */
        boolean pollStatus() {
            try {
                String st = http("http://127.0.0.1:" + port + "/status");
                if (st == null) return true;                     // 查不到，别急着自己关
                if (st.contains("\"running\":false")) {
                    ui.post(new Runnable() { public void run() { removeWin(port); } });
                    return false;
                }
                float a = parseAspect(st);
                if (a > 0.15f && Math.abs(a - aspect) > 0.01f) {
                    aspect = a;
                    ui.post(new Runnable() { public void run() { applyAspect(); } });
                }
            } catch (Throwable t) { /* ignore */ }
            return true;
        }

        void close() {
            alive = false;
            if (root != null) {
                try { wm.removeView(root); } catch (Throwable t) { /* 可能已经不在 */ }
                root = null;
            }
            img = null;
            label = null;
            // 位图交给 GC（限帧后不再复用同一个 buffer，避免撕裂）
            Log.i(TAG, "窗口已关闭 port=" + port);
        }
    }

    // ═══════════════ 工具 ═══════════════

    static float parseAspect(String st) {
        try {
            int i = st.indexOf("aspect");
            if (i < 0) return 0f;
            int c = st.indexOf(':', i);
            int e = c + 1;
            while (e < st.length() && "-0123456789.".indexOf(st.charAt(e)) >= 0) e++;
            return Float.parseFloat(st.substring(c + 1, e).trim());
        } catch (Throwable t) { return 0f; }
    }

    String http(String u) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(u).openConnection();
            c.setConnectTimeout(1200);
            c.setReadTimeout(1200);
            InputStream in = c.getInputStream();
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            byte[] b = new byte[4096];
            int n;
            while ((n = in.read(b)) > 0) o.write(b, 0, n);
            return new String(o.toByteArray(), "UTF-8");
        } catch (Throwable t) {
            return null;
        } finally {
            try { if (c != null) c.disconnect(); } catch (Throwable t) { /* ignore */ }
        }
    }

    static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { /* ignore */ }
    }

    int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /** 通知：显示当前有几个窗口。 */
    void updateNotification() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.notify(CH_NUM, buildNotification());
        } catch (Throwable t) { /* ignore */ }
    }

    Notification buildNotification() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm.getNotificationChannel(CH_ID) == null) {
                nm.createNotificationChannel(new NotificationChannel(
                        CH_ID, "AI 画面", NotificationManager.IMPORTANCE_LOW));
            }
        }
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);

        int n = wins.size();
        String title = n <= 1 ? "AI 画面正在显示" : "AI 画面 · " + n + " 个窗口";
        String text = n <= 0 ? "等待连接…" : "端口 " + describePorts();
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CH_ID)
                : new Notification.Builder(this);
        return b.setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    private String describePorts() {
        StringBuilder sb = new StringBuilder();
        for (Integer p : wins.keySet()) {
            if (sb.length() > 0) sb.append(" / ");
            sb.append(p);
        }
        return sb.toString();
    }
}
