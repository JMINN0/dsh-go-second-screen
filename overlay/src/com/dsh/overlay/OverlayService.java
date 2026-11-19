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
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
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
    /**
     * 重排所有「自动定位」的窗口，**用碰撞检测保证绝对不重叠**。
     *
     * ## 为什么不用「累加高度」
     *
     * 上一版按顺序累加每个窗口高度排位置。问题：
     * 用户拖过的窗口（autoPos=false）被跳过，但它仍占着屏幕，
     * 后面的窗口照样往那儿放 → 重叠。实测出现 (-124,412) 这种跑出屏幕的坐标。
     *
     * ## 现在的做法
     *
     * 1. 先把「用户手动摆过」的窗口当成障碍物收进 placed
     * 2. 自动窗口逐个扫描屏幕，找第一个不和任何障碍物相交的位置
     * 3. 整屏都放不下就缩小到 70% 再试，再不行就叠在角落（极端情况）
     */
    private void relayoutAuto() {
        int screenW = getResources().getDisplayMetrics().widthPixels;
        int screenH = getResources().getDisplayMetrics().heightPixels;

        List<Rect> placed = new ArrayList<>();
        // 手动摆过的窗口当障碍
        for (Win w : wins.values()) {
            if (w.autoPos || w.root == null || w.lp == null) continue;
            int ww = w.curW > 0 ? w.curW : Math.round(screenW * 0.46f);
            int wh = w.curH > 0 ? w.curH : dp(200);
            placed.add(new Rect(w.lp.x, w.lp.y, w.lp.x + ww, w.lp.y + wh));
        }

        for (Win w : wins.values()) {
            if (!w.autoPos || w.root == null || w.lp == null) continue;
            int ww = w.curW > 0 ? w.curW : Math.round(screenW * 0.46f);
            int wh = w.curH > 0 ? w.curH : Math.round(screenH * 0.3f);
            int[] pos = findFreeSlot(placed, ww, wh, screenW, screenH);
            w.lp.x = pos[0];
            w.lp.y = pos[1];
            try { wm.updateViewLayout(w.root, w.lp); } catch (Throwable t) { /* ignore */ }
            placed.add(new Rect(pos[0], pos[1], pos[0] + ww, pos[1] + wh));
        }
    }

    /**
     * 在屏幕上找一块不和 placed 相交的空位。
     * 从左上往下扫，步长 dp(16)（足够细，不会漏掉能放的地方但不至于太慢）。
     */
    private int[] findFreeSlot(List<Rect> placed, int ww, int wh, int screenW, int screenH) {
        int startX = dp(6), startY = dp(96), step = dp(16);
        int limitX = screenW - ww - dp(6);
        int limitY = screenH - wh - dp(16);
        for (int y = startY; y <= limitY; y += step) {
            for (int x = startX; x <= limitX; x += step) {
                Rect r = new Rect(x, y, x + ww, y + wh);
                boolean hit = false;
                for (Rect o : placed) {
                    if (Rect.intersects(r, o)) { hit = true; break; }
                }
                if (!hit) return new int[]{x, y};
            }
        }
        // 放不下：退到左上角（宁可重叠也别跑到屏幕外）
        return new int[]{dp(6), startY};
    }

    @Override
    public void onDestroy() {
        running = false;
        closeAll();
        super.onDestroy();
    }

    // ═══════════════════ 删除滑轨 ═══════════════════

    /** 滑轨窗口（拖动时出现，把窗口拖进右下端 = 删除）。 */
    private View railView;
    private WindowManager.LayoutParams railLp;
    private View railKnob;
    private boolean railShown = false;

    /** 滑轨的几何：底部一条横向跑道。 */
    private int railY() { return getResources().getDisplayMetrics().heightPixels - dp(160); }
    private int railLeft() { return dp(24); }
    private int railRight() { return getResources().getDisplayMetrics().widthPixels - dp(24); }

    /** 显示滑轨（拖动进入左下区域时调）。 */
    private void showRail() {
        if (railShown) return;
        railShown = true;
        try {
            if (railView == null) {
                android.widget.FrameLayout fl = new android.widget.FrameLayout(this);
                // 跑道底
                GradientDrawable track = new GradientDrawable();
                track.setColor(0xCC1A1A1A);
                track.setCornerRadius(dp(24));
                track.setStroke(dp(2), 0x66FFFFFF);
                fl.setBackground(track);
                fl.setPadding(dp(8), dp(8), dp(8), dp(8));
                // 提示文字
                TextView hint = new TextView(this);
                hint.setText("拖到最右删除");
                hint.setTextColor(0xAAFFFFFF);
                hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
                android.widget.FrameLayout.LayoutParams hl =
                        new android.widget.FrameLayout.LayoutParams(
                                android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
                                android.widget.FrameLayout.LayoutParams.WRAP_CONTENT);
                hl.gravity = Gravity.CENTER;
                fl.addView(hint, hl);
                // 圆形手柄
                railKnob = new View(this);
                GradientDrawable kb = new GradientDrawable();
                kb.setShape(GradientDrawable.OVAL);
                kb.setColor(0xFFFF3B30);
                railKnob.setBackground(kb);
                android.widget.FrameLayout.LayoutParams kl =
                        new android.widget.FrameLayout.LayoutParams(dp(44), dp(44));
                kl.gravity = Gravity.START | Gravity.CENTER_VERTICAL;
                fl.addView(railKnob, kl);
                railView = fl;

                railLp = new WindowManager.LayoutParams(
                        railRight() - railLeft(), dp(64),
                        Build.VERSION.SDK_INT >= 26
                                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                                : WindowManager.LayoutParams.TYPE_PHONE,
                        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                                | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
                        android.graphics.PixelFormat.TRANSLUCENT);
                railLp.gravity = Gravity.TOP | Gravity.START;
                railLp.x = railLeft();
                railLp.y = railY();
                wm.addView(railView, railLp);
            } else {
                wm.addView(railView, railLp);
            }
            Log.i(TAG, "滑轨已显示");
        } catch (Throwable t) {
            Log.e(TAG, "滑轨显示失败: " + t.getMessage());
        }
    }

    /** 拖动时更新滑轨手柄位置（0..1）。 */
    private void moveRailKnob(float frac) {
        if (!railShown || railKnob == null) return;
        try {
            int span = railRight() - railLeft() - dp(60);
            android.widget.FrameLayout.LayoutParams kl =
                    (android.widget.FrameLayout.LayoutParams) railKnob.getLayoutParams();
            kl.leftMargin = Math.round(Math.max(0f, Math.min(1f, frac)) * span);
            railKnob.setLayoutParams(kl);
        } catch (Throwable t) { /* ignore */ }
    }

    /** 隐藏滑轨。 */
    private void hideRail() {
        if (!railShown) return;
        railShown = false;
        try { if (railView != null) wm.removeView(railView); } catch (Throwable t) { /* ignore */ }
    }

    /** 通知 AI：用户手动关了后台屏。 */
    private void notifyUserDeleted(int port) {
        try {
            final int p = port;
            new Thread(new Runnable() {
                public void run() {
                    try {
                        java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                                new java.net.URL("http://127.0.0.1:" + p + "/event?type=user_deleted").openConnection();
                        c.setConnectTimeout(1200);
                        c.setReadTimeout(1200);
                        c.getResponseCode();
                        c.disconnect();
                    } catch (Throwable t) { /* 端口已经没了，正常 */ }
                }
            }).start();
        } catch (Throwable t) { /* ignore */ }
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
        float dragFrac = -1f;     // 拖动时在滑轨上的位置（0..1，-1=不在滑轨上）
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

            // **FrameLayout：工具条浮在画面上，不占额外高度。**
            //
            // 原来是 LinearLayout 竖排（工具条 + 图 + 标签 + 手柄），
            // chrome 约占 60dp/180px —— 于是：
            //   ① 窗口比画面大，四周露出深色背景 = 用户说的「黑边」
            //   ② relayoutAuto 按估算高度排位置，算不准 → 两个窗重叠
            // 改成叠放后，**窗口尺寸 = 画面尺寸**，一个像素多余空间都没有。
            FrameLayout box = new FrameLayout(OverlayService.this);
            // 背景全透明：画面自己铺满，不留任何边框
            box.setBackgroundColor(0x00000000);

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
            // 半透明底，叠在画面右上角，不占布局高度
            GradientDrawable barBg = new GradientDrawable();
            barBg.setColor(0x99000000);
            barBg.setCornerRadius(dp(6));
            bar.setBackground(barBg);
            FrameLayout.LayoutParams blp = new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
            blp.gravity = Gravity.TOP | Gravity.END;
            blp.topMargin = dp(2);
            blp.rightMargin = dp(2);
            box.addView(bar, blp);

            img = new ImageView(OverlayService.this);
            img.setScaleType(ImageView.ScaleType.FIT_XY);
            // **给一个初始占位尺寸。**
            // 原来 WRAP_CONTENT + 没有 bitmap = 宽高 0，
            // 帧还没到时整个窗口只剩「✕ — 端口」一条细线，
            // 用户看到的就是「窗口塌了」。
            int phW = Math.round(getResources().getDisplayMetrics().widthPixels * 0.46f);
            // img 铺满整个窗口（MATCH_PARENT）—— 窗口就是画面，没有留白
            FrameLayout.LayoutParams ilp2 = new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT);
            box.addView(img, ilp2);

            label = new TextView(OverlayService.this);
            label.setTextColor(Color.WHITE);
            label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
            label.setGravity(Gravity.CENTER);
            label.setText("屏 " + port);
            // 标签浮在底部居中，半透明底，不占布局高度
            GradientDrawable lbg = new GradientDrawable();
            lbg.setColor(0x88000000);
            lbg.setCornerRadius(dp(4));
            label.setBackground(lbg);
            label.setPadding(dp(6), dp(1), dp(6), dp(1));
            FrameLayout.LayoutParams tlp2 = new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
            tlp2.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
            tlp2.bottomMargin = dp(2);
            box.addView(label, tlp2);

            // **右下缩放手柄：画成斜向双箭头**，一眼就知道能拖大小
            View handle = new View(OverlayService.this) {
                @Override protected void onDraw(Canvas c) {
                    super.onDraw(c);
                    Paint p2 = new Paint(Paint.ANTI_ALIAS_FLAG);
                    p2.setColor(0xEEFFFFFF);
                    p2.setStrokeWidth(dp(2));
                    p2.setStyle(Paint.Style.STROKE);
                    p2.setStrokeCap(Paint.Cap.ROUND);
                    float w = getWidth(), h = getHeight();
                    float pad = dp(3), ar = dp(5);
                    // 主对角线 ╱
                    c.drawLine(pad, h - pad, w - pad, pad, p2);
                    // 右上箭头
                    c.drawLine(w - pad, pad, w - pad - ar, pad, p2);
                    c.drawLine(w - pad, pad, w - pad, pad + ar, p2);
                    // 左下箭头
                    c.drawLine(pad, h - pad, pad + ar, h - pad, p2);
                    c.drawLine(pad, h - pad, pad, h - pad - ar, p2);
                }
            };
            GradientDrawable hbg = new GradientDrawable();
            hbg.setColor(0x66000000);
            hbg.setCornerRadius(dp(6));
            handle.setBackground(hbg);
            FrameLayout.LayoutParams hlp = new FrameLayout.LayoutParams(dp(16), dp(16));
            hlp.gravity = Gravity.BOTTOM | Gravity.END;
            hlp.bottomMargin = dp(2);
            hlp.rightMargin = dp(2);
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
            // **建窗口时就给固定尺寸，不要 WRAP_CONTENT。**
            // WRAP_CONTENT + FrameLayout(MATCH_PARENT img) + 还没帧 = 尺寸为 0，
            // 窗口塌成一条线，而且碰撞检测拿不到真实尺寸 → 排位置会重叠。
            int w0 = Math.round(getResources().getDisplayMetrics().widthPixels * 0.46f);
            int h0 = Math.round(w0 * 1.6f);
            curW = w0; curH = h0;
            lp = new WindowManager.LayoutParams(w0, h0, type,
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
                                autoPos = false;   // 用户拖过 → 以后重排不动它
                                lp.x = startX + dx; lp.y = startY + dy;
                                try { wm.updateViewLayout(root, lp); } catch (Throwable t) { /* ignore */ }

                                // **拖到屏幕下半部 → 出现删除滑轨**
                                int screenH = getResources().getDisplayMetrics().heightPixels;
                                int screenW = getResources().getDisplayMetrics().widthPixels;
                                if (e.getRawY() > screenH * 0.62f) {
                                    showRail();
                                    float frac = (e.getRawX() - railLeft())
                                            / Math.max(1f, (railRight() - railLeft()));
                                    moveRailKnob(frac);
                                    dragFrac = frac;
                                } else {
                                    hideRail();
                                    dragFrac = -1f;
                                }
                            }
                            return true;
                        case MotionEvent.ACTION_UP:
                            // **拖到滑轨最右端 = 删除这块屏**
                            if (moved && dragFrac >= 0.82f) {
                                hideRail();
                                final int dp2 = port;
                                Log.i(TAG, "用户拖到滑轨右端，删除 port=" + dp2);
                                notifyUserDeleted(dp2);          // 通知 AI
                                ui.post(new Runnable() {
                                    public void run() {
                                        // 关窗口 + 通知 Node 侧停这块屏的推流
                                        try {
                                            java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                                                    new java.net.URL("http://127.0.0.1:38820/stopdisplay")
                                                            .openConnection();
                                        } catch (Throwable t) { /* ignore */ }
                                        removeWin(dp2);
                                    }
                                });
                                return true;
                            }
                            hideRail();
                            dragFrac = -1f;
                            // 点一下（没拖动）→ 最小化/恢复
                            if (!moved && System.currentTimeMillis() - downAt < 400) toggle();
                            return true;
                    }
                    return false;
                }
            });

            try {
                wm.addView(root, lp);
                Log.i(TAG, "窗口已添加 port=" + port + " " + lp.width + "x" + lp.height + " x=" + lp.x + " y=" + lp.y);
                // **加完立刻重排**：这时所有窗口都已有固定尺寸，碰撞检测才算得准
                ui.post(new Runnable() { public void run() { relayoutAuto(); } });
            } catch (Exception e) {
                Log.e(TAG, "加窗口失败 port=" + port + ": " + e.getMessage());
            }
        }

        void toggle() {
            collapsed = !collapsed;
            // **最小化时不隐藏画面** —— 用户要的是「很小的实时画面标识」，
            // 不是空白小方块。所以只改窗口尺寸，img 继续 MATCH_PARENT 刷新。
            if (img != null) img.setVisibility(View.VISIBLE);
            if (collapsed) {
                // 缩成 76dp 宽的小预览
                int smallW = dp(76);
                int smallH = Math.round(smallW / Math.max(0.2f, Math.min(5f, aspect)));
                if (smallH < dp(48)) smallH = dp(48);
                if (smallH > dp(120)) smallH = dp(120);
                if (lp != null) {
                    lp.width = smallW; lp.height = smallH;
                    try { wm.updateViewLayout(root, lp); } catch (Throwable t) { /* ignore */ }
                }
                if (label != null) label.setText("屏 " + port);
                return;
            }
            if (label != null) {
                // **始终显示「屏 N」**：只显示数字会被误认为窗口坏了
                label.setText("屏 " + port);
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

            // **设的是「窗口」尺寸，不是「图片」尺寸。**
            // FrameLayout 下 img 是 MATCH_PARENT，窗口多大画面就多大，
            // 所以窗口永远是「画面尺寸」——一个像素黑边都没有。
            curW = w;
            curH = h;
            if (lp != null) {
                boolean sizeChanged = (Math.abs(lp.width - w) > 2 || Math.abs(lp.height - h) > 2);
                lp.width = w;
                lp.height = h;
                if (root != null) {
                    try { wm.updateViewLayout(root, lp); } catch (Throwable t) { /* ignore */ }
                }
                if (sizeChanged) ui.post(new Runnable() { public void run() { relayoutAuto(); } });
            }
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
