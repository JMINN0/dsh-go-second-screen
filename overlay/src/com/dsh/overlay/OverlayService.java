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

    /** 返回手势边缘保护带（px）。左右各留这么宽，窗口不许贴边。
     *
     *  用户 2026-11-21 报：主屏侧滑返回时 B 站没反应 —— 手势被悬浮窗抢走。
     *  系统返回手势从屏幕左右边缘的窄条起手（各厂商 20-40dp），
     *  @480dpi 下 96px ≈ 32dp，覆盖大部分机型。
     */
    static final int EDGE_GUARD = 96;

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

    /** 最近一次 startId —— 用来 stopSelf(startId) 精确停，避免多 startId 残留。 */
    private int lastStartId = -1;

    @Override
    public int onStartCommand(Intent it, int flags, int startId) {
        lastStartId = startId;
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

    /** 关掉一个窗口（只关这一个）。全关完了就把服务也停掉。 */
    private void removeWin(int p) {
        Win w = wins.remove(p);
        if (w != null) w.close();
        persistPorts();
        // 对抗审查 #9：原来不更新通知、也不 stopSelf
        // → 最后一个窗口关了之后，前台通知和空服务永远留着
        updateNotification();
        if (wins.isEmpty()) {
            try { hideRail(); } catch (Throwable t) { /* ignore */ }
            hideRail();
            try { stopForeground(true); } catch (Throwable t) { /* ignore */ }
            stopSelf();
        }
    }

    /** 全部关掉。 */
    private void closeAll() {
        // 对抗审查 #6：滑轨是独立窗口，不清会永远浮在屏幕上（还不可触摸，只能 force-stop）
        try { hideRail(); } catch (Throwable t) { /* ignore */ }
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
    /**
     * 窗口数量变了 → 所有「用户没手动调过大小」的窗口都要按新数量重算尺寸。
     *
     * **对抗审查发现的 P0**：applyAspect() 只在 aspect 变化时跑，完全不看 wins.size()。
     * 于是第 1 个窗口按「只有 1 个」定成 668×1478，后面再开第 2、3 个它不会缩，
     * findFreeSlot 放不下就回退到同一个坐标 → **重叠**。
     */
    private void reflowAll() {
        for (Win w : wins.values()) {
            if (w.userW > 0 || w.collapsed) continue;   // 用户调过大小/收起的别动
            w.appliedAspect = -1f;                      // 强制重算
            w.applyAspect();
        }
        relayoutAuto();
    }

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
    private boolean railShown = false;

    /** 滑轨的几何：底部一条横向跑道。 */
    /* ═══════════════════════════════════════════════════════════════
     * 拖拽删除：底部投放环 + 左右两条出口
     *
     * 用户 2026-11-21 定的规格（逐条对应）：
     *   1. 拖到屏幕正下方圆圈 → 触发
     *   2. 屏幕最左 / 最右各出现一条文字+按钮
     *        左：只关闭悬浮窗
     *        右：关闭悬浮窗并关闭后台屏
     *   3. 全程不许松手：圆圈 → 左/右按钮
     *   4. 没滑到按钮上就松手 → 不触发，窗口留在松手处
     *   5. **不可以恢复进度**：下次拖动必须重新经过圆圈才能再出按钮
     *   6. 从圆圈往上离开水平带 → 按钮消失
     *
     * 关键设计点（前两版是两个子代理挑出来的教训）：
     *   · 按钮放屏幕**最左右边缘**，不放拇指底下 —— 拇指在中间，边缘才看得见
     *   · 判据用**手指**坐标，出圈每帧复位，绝不latch
     *   · 每个破坏性动作都要「进圈 + 到按钮 + 松手」三件事同时成立
     * ═══════════════════════════════════════════════════════════════ */

    private View hubView, leftBar, rightBar;
    private WindowManager.LayoutParams hubLp, leftLp, rightLp;
    private TextView leftLabel, rightLabel;
    private boolean hubShown = false;
    /** 本次手势内是否已经「过圈」。
     *
     *  2026-11-21 用户报「拖到左右两边有时有反馈有时没反馈」——
     *  根因：原来每帧用 `dropState >= 2` 判断是否武装，而 dropState 只有手指
     *  真的穿过那个 117px 的小圆才会变 2。斜着拖过去路径不经过圆心 → 永远不武装
     *  → 到了按钮位置也毫无反应。
     *  现在改成：进过圈就锁住，直到松手/取消/离开水平带才清。
     */
    private boolean armedThisGesture = false;
    /** 窗口实际位置与 lp 请求位置的差（px）。
     *
     *  **这是「只有上半部分有反馈」的根因。**
     *  2026-11-21 用户实测：左右按钮只有上半截能触发。
     *  推演：若窗口实际渲染比 lp.y 低了约 dp(30)（状态栏 inset），
     *  视觉条整体下移，而判定矩形还按 lp 那套坐标算 → 视觉条只有上半部分
     *  落进判定区，下半部分「看得见但按不到」。
     *  解决：用 getLocationOnScreen() 实测一次，把差值补到判定坐标上。
     */
    private int originDX = 0, originDY = 0;
    private int dropState = 0;      // 0=隐藏 1=幽灵(拖动中) 2=已进圈(按钮显示) 3=选中左 4=选中右

    /** 圆圈中心：屏幕正下方，抬离导航条。 */
    private int hubCx() { return getResources().getDisplayMetrics().widthPixels / 2; }
    private int hubCy() {
        int sh = getResources().getDisplayMetrics().heightPixels;
        int ins = 0;
        try {
            android.util.DisplayMetrics m = new android.util.DisplayMetrics();
            android.view.WindowManager w = (android.view.WindowManager) getSystemService(WINDOW_SERVICE);
            if (w != null && w.getDefaultDisplay() != null) w.getDefaultDisplay().getRealMetrics(m);
        } catch (Throwable t) { /* ignore */ }
        return sh - dp(96) - ins;
    }
    /** 进圈半径 = 视觉半径 + 一点手指容错。
     *
     *  **这是「触碰位置跟 UI 有差别」的头号原因。**
     *  圈视觉直径 dp(56) → 半径 dp(28)=91px；原来这里写 dp(76)=247px，
     *  等于用户离圈边还有 156px 就被判成「进圈」了，2.7 倍的偏差。
     *  现在 = 视觉半径 + dp(8) 容错 = dp(36)。
     */
    private int hubR() { return dp(36); }
    /** 水平带半高：离开这个范围按钮就消失。 */
    private int hubBand() { return dp(52); }   // 原来 dp(120)=390px 占屏高 23%，太宽
    /** 左/右按钮窗口宽度。
     *
     *  原来是 dp(168)=546px，占屏宽 **45%**，两条加起来 90%，中间只剩 10% 空隙 ——
     *  而且左条的命中区一路延伸到屏幕中心，**人站在圆圈上就已经算「选中左」**，
     *  一松手就删。这是最致命的一条。
     *  现在 dp(120)=390px（32%），两条 64%，中间留 36% 的空档放圆圈。
     */
    private int barW() { return dp(96); }

    /** 按钮命中容差：只给一点手指误差，不许溢出视觉区太多。 */
    private int barPad() { return dp(6); }

    /** 造一个 Apple/SpaceX 质感的胶囊：深近黑底、极细描边、圆角。 */
    private GradientDrawable pill(int accent, boolean filled) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.RECTANGLE);
        g.setCornerRadius(dp(16));
        g.setColor(filled ? accent : 0xE60A0A0C);
        g.setStroke(dp(1), filled ? 0xFFFFFFFF : (accent == 0 ? 0x33FFFFFF : accent));
        return g;
    }

    private TextView barText(String s, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextColor(color);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 9.5f);
        t.setLetterSpacing(0.08f);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(4), dp(8), dp(4), dp(8));
        return t;
    }

    /** 建好三个视图（只建一次，复用）。 */
    private void ensureDropViews() {
        if (hubView != null) return;
        int type = Build.VERSION.SDK_INT >= 26
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        int flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;

        // ── 圆圈 ──
        android.widget.LinearLayout hub = new android.widget.LinearLayout(this);
        hub.setOrientation(android.widget.LinearLayout.VERTICAL);
        hub.setGravity(Gravity.CENTER_HORIZONTAL);
        View ring = new View(this);
        GradientDrawable rg = new GradientDrawable();
        rg.setShape(GradientDrawable.OVAL);
        rg.setColor(0xE60A0A0C);
        rg.setStroke(dp(2), 0x66FFFFFF);
        ring.setBackground(rg);
        /* **圆圈里要有个符号。** 原来是个纯黑空饼 + 发丝描边，
         * 在深色画面上等于不存在，用户根本看不出这是个投放目标。 */
        android.widget.TextView hubIcon = new android.widget.TextView(this);
        hubIcon.setText("✕");
        hubIcon.setTextColor(0xE6FFFFFF);
        hubIcon.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f);
        hubIcon.setGravity(Gravity.CENTER);
        android.widget.FrameLayout hubWrap = new android.widget.FrameLayout(this);
        android.widget.FrameLayout.LayoutParams rlp = new android.widget.FrameLayout.LayoutParams(dp(56), dp(56));
        hubWrap.addView(ring, rlp);
        android.widget.FrameLayout.LayoutParams ilp = new android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
                android.widget.FrameLayout.LayoutParams.WRAP_CONTENT);
        ilp.gravity = Gravity.CENTER;
        hubWrap.addView(hubIcon, ilp);
        hub.removeAllViews();
        hub.addView(hubWrap, new android.widget.LinearLayout.LayoutParams(dp(56), dp(56)));
        /* 原来这里还塞了一个 1dp 高的 TextView，导致内容 57dp > 窗口 56dp 被裁，
         * 视觉中心偏半像素。去掉，窗口和内容都严格 dp(56)。 */
        hubView = hub;
        hubLp = new WindowManager.LayoutParams(dp(56), dp(56), type, flags,
                android.graphics.PixelFormat.TRANSLUCENT);
        hubLp.gravity = Gravity.TOP | Gravity.START;
        hubLp.x = hubCx() - dp(28);
        hubLp.y = hubCy() - dp(28);

        // ── 左侧：只关浮窗 ──
        leftLabel = barText("关 闭 浮 窗", 0xE6FFFFFF);
        leftLabel.setBackground(pill(0xFF5E9EFF, false));
        leftBar = leftLabel;
        leftLp = new WindowManager.LayoutParams(barW(), dp(36), type, flags,
                android.graphics.PixelFormat.TRANSLUCENT);
        leftLp.gravity = Gravity.TOP | Gravity.START;
        leftLp.x = dp(4);
        leftLp.y = hubCy() - dp(18);

        // ── 右侧：关浮窗 + 停后台屏 ──
        rightLabel = barText("关闭并停 后台屏", 0xE6FFFFFF);
        rightLabel.setBackground(pill(0xFFFF453A, false));
        rightBar = rightLabel;
        rightLp = new WindowManager.LayoutParams(barW(), dp(36), type, flags,
                android.graphics.PixelFormat.TRANSLUCENT);
        rightLp.gravity = Gravity.TOP | Gravity.END;
        rightLp.x = dp(4);   // gravity=END 时 x 是右边距
        rightLp.y = hubCy() - dp(18);
    }

    /** **按当前屏幕重新摆三个投放窗口。** 每次 ACTION_DOWN 调一次。
     *
     *  为什么不缓存：heightPixels 在 Service 里不稳定（见 ACTION_DOWN 的注释），
     *  缓存的坐标会和现算的命中区脱钩。
     */
    /** 实测窗口渲染位置与 lp 请求位置的差，用于校正命中坐标。
     *
     *  **这是「只有上半部分有反馈」的解药。**
     *  如果窗口实际渲染比 lp.y 低了一个状态栏高度，视觉条整体下移，
     *  而判定矩形还按 lp 那套坐标算 → 视觉条只有上半截落进判定区，
     *  下半截「看得见但按不到」。实测出来补到判定坐标上即可对齐。
     */
    private void calibrateOrigin() {
        try {
            if (hubView == null || hubLp == null || !hubView.isAttachedToWindow()) return;
            if (hubView.getWidth() == 0 || hubView.getHeight() == 0) return;
            int[] loc = new int[2];
            hubView.getLocationOnScreen(loc);
            int dx = loc[0] - hubLp.x, dy = loc[1] - hubLp.y;
            if (Math.abs(dx) > dp(120) || Math.abs(dy) > dp(120)) return;
            if (dx != originDX || dy != originDY) {
                originDX = dx; originDY = dy;
                Log.i(TAG, "原点补偿更新 dx=" + dx + " dy=" + dy);
            }
        } catch (Throwable t) { /* ignore */ }
    }

    private void layoutDropViews() {
        if (hubLp == null) return;
        int sw = getResources().getDisplayMetrics().widthPixels;
        int sh = getResources().getDisplayMetrics().heightPixels;
        int cx = sw / 2, cy = sh - dp(96);
        hubLp.x = cx - dp(28);   hubLp.y = cy - dp(28);
        leftLp.x = dp(4);        leftLp.y = cy - dp(18);
        rightLp.x = dp(4);       rightLp.y = cy - dp(18);   // gravity=END，x 是右边距
        if (hubShown) {
            try { wm.updateViewLayout(hubView,  hubLp);  } catch (Throwable t) { }
            try { wm.updateViewLayout(leftBar,  leftLp); } catch (Throwable t) { }
            try { wm.updateViewLayout(rightBar, rightLp); } catch (Throwable t) { }
            /* 布局完成后实测一次位置，拿到原点补偿。
             * 必须 post：updateViewLayout 是异步的，立刻 getLocationOnScreen 还是旧值。 */
            if (hubView != null) {
                hubView.post(new Runnable() { public void run() { calibrateOrigin(); } });
            }
        }
    }

    /** 显示/更新投放 UI。state: 0 隐藏, 1 幽灵, 2 进圈, 3 选左, 4 选右。 */
    private void setDropState(int state) {
        try {
            ensureDropViews();
            dropState = state;
            if (state == 0) {
                if (hubShown) {
                    try { wm.removeView(hubView); } catch (Throwable t) { }
                    try { wm.removeView(leftBar); } catch (Throwable t) { }
                    try { wm.removeView(rightBar); } catch (Throwable t) { }
                    hubShown = false;
                }
                return;
            }
            if (!hubShown) {
                try { wm.addView(hubView, hubLp); } catch (Throwable t) { }
                try { wm.addView(leftBar, leftLp); } catch (Throwable t) { }
                try { wm.addView(rightBar, rightLp); } catch (Throwable t) { }
                hubShown = true;
            }
            // 圆圈：幽灵 40% / 进圈 100%
            hubView.setAlpha(state == 1 ? 0.58f : 1f);
            // 左右两条：只有进圈才看得见
            boolean showBars = state >= 2;
            leftBar.setAlpha(showBars ? 1f : 0f);
            rightBar.setAlpha(showBars ? 1f : 0f);
            leftBar.setVisibility(showBars ? View.VISIBLE : View.INVISIBLE);
            rightBar.setVisibility(showBars ? View.VISIBLE : View.INVISIBLE);
            // 选中态：填充 + 白字
            if (showBars) {
                leftLabel.setBackground(pill(0xFF5E9EFF, state == 3));
                rightLabel.setBackground(pill(0xFFFF453A, state == 4));
            }
        } catch (Throwable t) { /* ignore */ }
    }

    private void hideRail() { setDropState(0); }

    /** 左按钮的**视觉**矩形（和 LayoutParams 必须一致）。 */
    private int[] leftBarRect() {
        int l = dp(4), t = hubCy() - dp(18);
        return new int[] { l, t, l + barW(), t + dp(36) };
    }
    /** 右按钮的**视觉**矩形。 */
    private int[] rightBarRect() {
        int sw = getResources().getDisplayMetrics().widthPixels;
        int r = sw - dp(4), t = hubCy() - dp(18);
        return new int[] { r - barW(), t, r, t + dp(36) };
    }

    /** 手指是否在左按钮上：**严格按视觉矩形 + barPad 容错**。
     *  绝不允许命中区延伸到屏幕中间 —— 那会让「站在圆圈上」被误判成「选中左」。 */
    private boolean onLeftBar(float x, float y) {
        int[] b = leftBarRect();
        int padY = dp(10);
        /* **扣掉原点补偿**：判定按「视觉上真正在哪」算，不是按 lp 请求值。 */
        float xx = x - originDX, yy = y - originDY;
        return xx >= b[0] - barPad() && xx <= b[2] + barPad()
                && yy >= b[1] - padY && yy <= b[3] + padY;
    }
    /** 手指是否在右按钮上。 */
    private boolean onRightBar(float x, float y) {
        int[] b = rightBarRect();
        int padY = dp(10);
        float xx = x - originDX, yy = y - originDY;
        return xx >= b[0] - barPad() && xx <= b[2] + barPad()
                && yy >= b[1] - padY && yy <= b[3] + padY;
    }
    /** 手指是否还在圆圈那一带的水平线附近（离开就藏按钮）。 */
    private boolean inBand(float y) { return Math.abs((y - originDY) - hubCy()) < hubBand(); }
    /** 手指是否进了圆圈（视觉判定用）。 */
    private boolean inHub(float x, float y) {
        float xx = x - originDX, yy = y - originDY;
        return Math.hypot(xx - hubCx(), yy - hubCy()) < hubR();
    }

    /** **武装区**：以圆圈为中心的方形区域，边长比圆直径大一圈。
     *
     *  为什么不用圆：手指斜着拖过来时，圆形边界命中率低，会出现
     *  「有时碰到有时没碰到」的飘忽感。方形区在四个方向上给的容错一致，
     *  而且和「圆圈所在的中间那一块」这个直觉吻合。
     */
    private boolean inArmZone(float x, float y) {
        /* **必须等于真实的圆。**
         * 2026-11-21 对抗审查抓到：这里原来是个半宽 dp(110)=358px 的方块，
         * 面积是圆的 19.7 倍，手指离圈边还有 266px 就判「进圈」。
         * 而 inHub()/hubR() 根本没被调用，所以我之前把 hubR 从 76dp 改到 36dp
         * 对行为是零影响 —— 用户那句「触碰位置跟 UI 有差别」一点没修掉。
         * 「斜着拖过去没反应」的问题由 armedThisGesture（进过一次就锁）解决，
         * 不需要靠放大判定区。 */
        return inHub(x, y);
    }



    /** 通知 AI：用户手动关了后台屏。 */
    /** 告诉插件「用户手动关掉了这个浮窗」。
     *
     *  alsoStopScreen=true 表示用户还要求连后台屏一起关 —— 那时连 /stop 一起打，
     *  否则只关浮窗、屏留着。
     *
     *  为什么这件事必须通知 AI：用户可能正在等这个屏上的结果，
     *  也可能只是收拾界面。AI 收到之后要自己判断「是不是打断了用户的活」，
     *  再决定停下来问还是继续。
     */
    private void notifyUserDeleted(int port, boolean alsoStopScreen, int displayId) {
        try {
            final int p = port;
            new Thread(new Runnable() {
                public void run() {
                    try {
                        java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                                new java.net.URL("http://127.0.0.1:" + p + "/event?type=user_deleted"
                                        + "&stopScreen=" + (alsoStopScreen ? "1" : "0")
                                        + "&displayId=" + displayId).openConnection();
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
        LinearLayout bar;      // 顶栏（最小化时隐藏，否则按钮比小预览还宽，把窗口撑大）
        View handle;           // 缩放手柄（同样要藏）
        WindowManager.LayoutParams lp;

        float aspect = 0.5f;
        float appliedAspect = -1f;
        boolean autoPos = true;   // 用户拖过就设 false，重排时不动它
        float dragFrac = -1f;     // 拖动时在滑轨上的位置（0..1，-1=不在滑轨上）
        boolean resizeMoved = false;   // 缩放手柄是否已越过阈值
        boolean docked = false;        // 已进入删除投放点（此时只判左右方向）
        int armDir = 0;                // -1 左=只关浮窗 / +1 右=关浮窗+关后台屏 / 0 未选
        boolean statusTimerStarted = false;
        int statusFails = 0;
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

            // 顶栏：✕ 关自己 / — 收起（**存成字段**，最小化时才能隐藏）
            LinearLayout bar = new LinearLayout(OverlayService.this);
            this.bar = bar;
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
            // **顶栏必须在图之后 bringToFront。**
            // FrameLayout 后加的在上层，原来 bar 先加、img 后加 → 第一帧一到就把 ✕/— 盖住了，
            // 但按钮仍在触摸链里 → 用户点右上角会误关/误收起（对抗审查 #3）。
            try { bar.bringToFront(); } catch (Throwable t) { /* ignore */ }

            label = new TextView(OverlayService.this);
            label.setTextColor(Color.WHITE);
            label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
            label.setGravity(Gravity.CENTER);
            refreshLabel();
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
            this.handle = handle;   // 存字段，最小化时隐藏
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
                            resizeMoved = false;
                            return true;
                        case MotionEvent.ACTION_MOVE:
                            // **必须真的拖了才缩放。**
                            // 实机踩到：手柄被误触一下（dx≈0）就执行
                            //   nw = max(dp(80), startW + 0)
                            // 而 dp(80)=260 正好是下限 → 窗口瞬间缩到最小，
                            // 用户看到的就是「窗口莫名其妙变很小、尺寸和别的窗不一样」。
                            int mvx = (int)(e.getRawX() - downX);
                            int mvy = (int)(e.getRawY() - downY);
                            if (!resizeMoved && Math.abs(mvx) < dp(10) && Math.abs(mvy) < dp(10)) {
                                return true;   // 还没到阈值，不缩
                            }
                            resizeMoved = true;
                            int nw = Math.max(dp(120), startW + mvx);
                            userW = nw; userH = nw;
                            appliedAspect = -1f;
                            applyAspect();
                            return true;
                        case MotionEvent.ACTION_UP:
                            resizeMoved = false;
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
            /* **必须加 FLAG_NOT_TOUCH_MODAL，否则窗口边界内的触摸全被吃掉。**
             *
             * 2026-11-21 用户报的 bug：主屏侧滑返回时，B站没反应 —— 手势被悬浮窗抢了。
             * 根因是窗口位置 x=dp(12) 落在系统返回手势的边缘感应区里，
             * 手指从屏幕左/右边缘滑进来，起点就在窗口范围内，事件被这个窗口消费了。
             *
             * 修法两条一起上：
             *   1) 加 FLAG_NOT_TOUCH_MODAL —— 窗口外的触摸明确放行给下层
             *   2) clampPos 里把位置限制在手势安全区之外（见 EDGE_GUARD）
             * 只做其中一条都还会漏：单加 flag，窗口盖住边缘时照样抢；
             * 单挪位置，用户一拖动又回到边缘。
             */
            lp = new WindowManager.LayoutParams(w0, h0, type,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                    android.graphics.PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.TOP | Gravity.START;

            // 先给个临时位置，等第一帧拿到尺寸后 relayoutAuto() 会重排
            lp.x = EDGE_GUARD;   // 避开返回手势边缘区，见 clampPos
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
                            /* **每次按下都强制复位。**
                             * 2026-11-21 对抗审查抓到：armedThisGesture 是 Service 级字段，
                             * 原来只在 UP/CANCEL/离开水平带 三处复位。只要有一次手势被打断
                             * （比如 pollStatus 发现屏没了、窗口自己关掉），它留 true，
                             * 下一次拖任何窗口都算「已武装」→ 没经过圆圈就能直接滑到按钮删。
                             * 这正是用户禁止的「恢复拖拽进度」。ACTION_DOWN 是唯一权威复位点。
                             */
                            armedThisGesture = false;
                            docked = false;
                            if (hubShown) setDropState(0);
                            /* **每次按下重算几何并重摆窗口。**
                             * 2026-11-21 坐标审查抓到：ensureDropViews() 里有
                             * `if (hubView != null) return;` —— 三个窗口坐标一辈子只算一次，
                             * 而 hubCy() 每帧现算。heightPixels 在服务里会变
                             * （API30+ 返回进程内顶层 Activity 的尺寸，而 MainActivity 是 noHistory，
                             * 销毁后值会跳 65~173px），一变就视觉停在旧位置、命中跟新位置走。
                             * 这就是「触碰位置跟 UI 有点差别」的时序来源。
                             */
                            layoutDropViews();
                            return true;
                        case MotionEvent.ACTION_MOVE:
int dx = (int)(e.getRawX() - downX);
                            int dy = (int)(e.getRawY() - downY);
                            if (Math.abs(dx) > dp(6) || Math.abs(dy) > dp(6)) moved = true;
                            if (!moved) return true;

                            int sw = getResources().getDisplayMetrics().widthPixels;
                            int sh = getResources().getDisplayMetrics().heightPixels;

                            /* ═══ 已进入删除投放点：只判左右，窗口跟手走 ═══ */
                              /* ═══ 已进入投放环：**窗口冻结不动**，只等停留计时 ═══
                               *
                               * 用户 2026-11-21 实测三个问题都来自上一版：
                               *   1) 巨大圆圈 —— 已缩到 56dp
                               *   2) 窗口被吸附 —— 现在进环后一个字都不改窗口坐标
                               *   3) 碰一下就没了 —— 现在必须「进环 + 停留 400ms 锁定」才允许执行，
                               *      单纯滑过去松手不会删。
                               */
                              /* **先跟手。** 2026-11-21 挑刺方抓到：上一版把这段删了，窗口完全拖不动。 */
                              /* ═══ 1. 先跟手拖动（窗口跟手指走）═══ */
                            int sw2 = getResources().getDisplayMetrics().widthPixels;
                            int sh2 = getResources().getDisplayMetrics().heightPixels;
                            int kw2 = Math.max(dp(40), curW);
                            int kh2 = Math.max(dp(40), curH);
                            int kx2 = Math.max(dp(72), kw2 / 2);
                            lp.x = Math.max(-(kw2 - kx2), Math.min(sw2 - kx2, startX + dx));
                            lp.y = Math.max(0, Math.min(Math.max(0, sh2 - kh2), startY + dy));
                            try { wm.updateViewLayout(root, lp); } catch (Throwable t) { }

                            /* ═══ 2. 状态机 ═══
                             *
                             * 用户 2026-11-21 的硬规则：
                             *   · 必须先到圆圈，按钮才出现（不可跳过 → 「不可以恢复拖拽进度」）
                             *   · 往上离开水平带 → 按钮消失
                             *   · 没滑到按钮上松手 → 什么都不发生
                             */
                            float fx = e.getRawX(), fy = e.getRawY();
                            boolean wasArmed = armedThisGesture || (dropState >= 2);

                            /* **幽灵圈要常显。**
                             * 审查抓到：原来只有 !inBand 时才 setDropState(1)，
                             * 而窗口本来就停在屏幕下半部时（用户反复拖的就是那），
                             * 第一帧就落在带内 → dropState 一直 0 → 圈根本不出现。
                             */
                            if (!hubShown) setDropState(1);

                            if (!inBand(fy)) {
                                // 离开水平带：按钮消失，重新过圈才能再出
                                if (wasArmed) {
                                    docked = false;
                                    armedThisGesture = false;
                                    setDropState(1);
                                } else if (!hubShown) {
                                    setDropState(1);
                                }
                            /* **按钮判定优先。**
                             * 武装区 dp(110) 半宽=357px，和左右按钮（命中到 x=455 / 从 x=761 起）
                             * 有一段 205px 的重叠。如果先判武装区，手指已经在按钮上了却只当「进圈」，
                             * 用户看到的就是「滑到按钮上没反馈」。所以按钮优先。
                             */
                            } else if (wasArmed && onLeftBar(fx, fy)) {
                                if (dropState != 3) {
                                    setDropState(3);
                                    try { root.performHapticFeedback(android.view.HapticFeedbackConstants.TEXT_HANDLE_MOVE); } catch (Throwable t) { }
                                }
                            } else if (wasArmed && onRightBar(fx, fy)) {
                                if (dropState != 4) {
                                    setDropState(4);
                                    try { root.performHapticFeedback(android.view.HapticFeedbackConstants.TEXT_HANDLE_MOVE); } catch (Throwable t) { }
                                }
                            } else if (inArmZone(fx, fy)) {
                                /* **回到圆圈必须无条件降级到 2。**
                                 * 2026-11-21 对抗审查抓到致命 bug：原来只在 dropState<2 时
                                 * setDropState(2)，所以「选中左(3) → 滑回圆圈 → 松手」时
                                 * dropState 仍是 3 → 直接删除。
                                 * 用户的原话是「只要没放在左右两边其中一个按钮上就不算」，
                                 * 松手在圆圈里正是「没放在按钮上」，绝不该删。 */
                                docked = true;
                                if (!armedThisGesture) {
                                    armedThisGesture = true;
                                    try { root.performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK); } catch (Throwable t) { }
                                }
                                if (dropState != 2) setDropState(2);
                            } else if (wasArmed) {
                                // 已武装但不在按钮也不在武装区：按钮保持显示，取消选中
                                if (dropState > 2) setDropState(2);
                            }
                            return true;
                        case MotionEvent.ACTION_CANCEL:
                            /* 被打断（来电/系统弹窗/多指）：必须复位，否则 UI 会卡在屏幕上。 */
                            docked = false;
                            armedThisGesture = false;
                            setDropState(0);
                            return true;
                        case MotionEvent.ACTION_UP:
                            /* ═══ 3. 松手：只有正好停在按钮上才执行 ═══ */
                            {
                                /* **松手时用事件自己的坐标重判，不信上一帧的 dropState。**
                                 * 2026-11-21 对抗审查抓到：快速滑到按钮立刻抬手时，
                                 * 最后一次 MOVE 可能还没到，dropState 仍是 2 → 不触发。
                                 * 用户感知就是「有时灵有时不灵」。
                                 */
                                final float upx = e.getRawX(), upy = e.getRawY();
                                int pick = 2;
                                if (armedThisGesture && inBand(upy)) {
                                    if (onLeftBar(upx, upy)) pick = 3;
                                    else if (onRightBar(upx, upy)) pick = 4;
                                }
                                armedThisGesture = false;
                                if (docked || pick == 3 || pick == 4) {
                                    docked = false;
                                    setDropState(0);
                                    if (pick == 3) {
                                        final int p3 = port;
                                        Log.i(TAG, "松手在左按钮 → 只关浮窗 port=" + p3);
                                        notifyUserDeleted(p3, false, -1);
                                        ui.post(new Runnable() { public void run() { removeWin(p3); } });
                                        return true;
                                    }
                                    if (pick == 4) {
                                        final int p4 = port;
                                        Log.i(TAG, "松手在右按钮 → 关浮窗+停后台屏 port=" + p4);
                                        /* **真的停屏。**
                                         * 2026-11-21 对抗审查抓到：原来这里只发了个 /event 就 removeWin，
                                         * framesrv 只是往 events.log 写一行，虚拟屏照跑、CPU 照烧，
                                         * 用户按左按右结果一模一样。
                                         * framesrv 的 /quit 是 System.exit(0)，虚拟屏随持有它的进程一起释放。
                                         */
                                        try {
                                            new Thread(new Runnable() {
                                                public void run() {
                                                    try {
                                                        java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                                                                new java.net.URL("http://127.0.0.1:" + p4 + "/quit").openConnection();
                                                        c.setConnectTimeout(1200);
                                                        c.setReadTimeout(1200);
                                                        c.getResponseCode();
                                                        c.disconnect();
                                                    } catch (Throwable t) { /* 停不掉也不能拖住 UI */ }
                                                }
                                            }).start();
                                        } catch (Throwable t) { /* ignore */ }
                                        notifyUserDeleted(p4, true, -1);
                                        ui.post(new Runnable() { public void run() { removeWin(p4); } });
                                        return true;
                                    }
                                    // 只是进过圈但没到按钮：取消，窗口留在松手处
                                    Log.i(TAG, "投放取消（未到按钮）port=" + port);
                                    clampPos(curW, curH);
                                    try { wm.updateViewLayout(root, lp); } catch (Throwable t) { }
                                    return true;
                                }
                            }
                            setDropState(0);
                            /* **正常松手也要 clampPos。**
                             * 2026-11-21 审查抓到：拖动时只保证「一半可见」，窗口能到 x=-300，
                             * 整块盖住屏幕左边缘 0..96 的返回手势保护区 —— 把之前修好的
                             * 「侧滑返回被悬浮窗抢走」重新引回来。收尾必须夹一次。
                             */
                            clampPos(curW, curH);
                            try { wm.updateViewLayout(root, lp); } catch (Throwable t) { }
                            if (!moved && System.currentTimeMillis() - downAt < 400) toggle();

                        }
                    return false;
                }
            });

            try {
                wm.addView(root, lp);
                Log.i(TAG, "窗口已添加 port=" + port + " " + lp.width + "x" + lp.height + " x=" + lp.x + " y=" + lp.y);
                // **加完立刻重算所有窗口尺寸再重排**（P0：数量变了尺寸要跟着变）
                ui.post(new Runnable() { public void run() { reflowAll(); } });
            } catch (Exception e) {
                Log.e(TAG, "加窗口失败 port=" + port + ": " + e.getMessage());
            }
        }

        /** 把窗口位置拉回「至少一部分在屏内」。 */
        void clampPos(int ww, int hh) {
            if (lp == null) return;
            int sw = getResources().getDisplayMetrics().widthPixels;
            int sh = getResources().getDisplayMetrics().heightPixels;
            /* **左右各留 EDGE_GUARD 的手势安全区，不许贴边。**
             *
             * 用户 2026-11-21 报：主屏侧滑返回被悬浮窗抢走，B站没反应。
             * 系统返回手势从屏幕左/右边缘的窄条起手（各厂商 20-40dp 不等，
             * 这里取 32dp 覆盖大部分机型）。窗口只要盖住那条，手势起点就落在窗口上。
             *
             * 所以窗口的左右边界都必须离开屏幕边缘至少这个距离。
             * 上下不设限：手势不从上/下边缘起手（下拉通知栏是另一套）。
             */
            int minX = EDGE_GUARD;
            int maxX = Math.max(minX, sw - ww - EDGE_GUARD);
            lp.x = Math.max(minX, Math.min(maxX, lp.x));
            lp.y = Math.max(0, Math.min(Math.max(0, sh - hh), lp.y));
        }

        void toggle() {
            collapsed = !collapsed;
            // **最小化时不隐藏画面** —— 用户要的是「很小的实时画面标识」，
            // 不是空白小方块。所以只改窗口尺寸，img 继续 MATCH_PARENT 刷新。
            if (img != null) img.setVisibility(View.VISIBLE);
            if (collapsed) {
                // **最小化要真的小。**
                // 原来 dp(76) 在 3.42 密度下是 260px —— 用户实测「还是太大」。
                // 改成 36dp（≈123px），并且高度按比例但限死在 36~64dp。
                int smallW = dp(36);
                int smallH = Math.round(smallW / Math.max(0.2f, Math.min(5f, aspect)));
                if (smallH < dp(36)) smallH = dp(36);
                if (smallH > dp(64)) smallH = dp(64);
                // **工具栏必须藏起来**：两个 13sp 按钮的宽度远超 36dp，
                // 不藏的话 FrameLayout 会把窗口撑回大尺寸，用户看到的就是「最小化还是太大」。
                if (bar != null) bar.setVisibility(View.GONE);
                if (label != null) label.setVisibility(View.GONE);
                if (handle != null) handle.setVisibility(View.GONE);
                if (lp != null) {
                    lp.width = smallW; lp.height = smallH;
                    clampPos(smallW, smallH);
                    try { wm.updateViewLayout(root, lp); } catch (Throwable t) { /* ignore */ }
                }
                if (label != null) refreshLabel();
                return;
            }
            if (label != null) {
                // **始终显示「屏 N」**：只显示数字会被误认为窗口坏了
                refreshLabel();
                label.setTextSize(TypedValue.COMPLEX_UNIT_SP, collapsed ? 11 : 10);
            }
            if (!collapsed) {
                if (bar != null) bar.setVisibility(View.VISIBLE);
                if (label != null) label.setVisibility(View.VISIBLE);
                if (handle != null) handle.setVisibility(View.VISIBLE);
                appliedAspect = -1f;
                applyAspect();
                clampPos(curW > 0 ? curW : dp(200), curH > 0 ? curH : dp(200));
                if (lp != null) { try { wm.updateViewLayout(root, lp); } catch (Throwable t) { /* ignore */ } }
            }
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
                // **单窗口默认 40%，不要 62%。**
                // 用户反馈：默认建悬浮窗时占了屏幕大半，挡着他看主屏。
                // 40% 宽在 720p 逻辑宽上约 490px，内容仍看得清，但留出 60% 给用户。
                float frac = n <= 1 ? 0.40f : (n <= 3 ? 0.34f : 0.28f);
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

        /**
         * **独立的状态定时器**：不依赖「收到帧」才查 /status。
         *
         * 对抗审查 #5：原来 pollStatus() 只在 readMjpeg() 收到帧后调用，
         * 于是「端口死了 / 那块屏没 App / 已经 stop」的窗口**永远不会关**，
         * 留下一个永久空白窗，还会吞触摸事件。
         */
        void startStatusTimer() {
            if (statusTimerStarted) return;
            statusTimerStarted = true;
            final Runnable tick = new Runnable() {
                public void run() {
                    if (!alive || !running) return;
                    /* 每 3 秒同时刷新底部等级。原来只 pollStatus 查存活，
                     * 从不刷 label —— 用户在那块屏上换了 App，L 等级一直停在旧值，
                     * 除非手动收起再展开。等级是用来判断能不能这么操作的，
                     * 显示过期值比不显示更糟。 */
                    refreshLabel();
                    new Thread(new Runnable() {
                        public void run() {
                            if (!pollStatus()) return;   // 返回 false = 已决定关闭
                        }
                    }).start();
                    ui.postDelayed(this, 3000);
                }
            };
            ui.postDelayed(tick, 3000);
        }

        /** 起轮询线程（幂等）。 */
        void startLoop() {
            if (looping || !alive) return;
            startStatusTimer();
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
          /** 刷新底部那行字：屏号 + 风控等级 + 当前操作方式。
           *
           * 数据来自 /data/local/tmp/dshframe/opmode，由插件每次操作前写入。
           * 收起状态只显示屏号。
           */
          void refreshLabel() {
              if (label == null) return;
              String[] st = readStatus();
              String lv = st == null ? "" : st[0];
              String op = st == null ? "" : st[1];
              String dn = st == null ? "" : st[2];
              /* 三段：等级 · 操作方式 · 屏号。用户 2026-11-21 明确要这三样。
               * 收起时空间小，只留等级。缺哪段就少显示哪段，不补占位符。 */
              StringBuilder sb = new StringBuilder();
              if (!lv.isEmpty()) sb.append(lv);
              if (!collapsed) {
                  if (!op.isEmpty()) { if (sb.length() > 0) sb.append(" · "); sb.append(op); }
                  if (!dn.isEmpty()) { if (sb.length() > 0) sb.append(" · "); sb.append("屏").append(dn); }
              }
              if (sb.length() == 0) {
                  label.setText("屏 " + port);
                  label.setTextColor(0xCCFFFFFF);
              } else {
                  label.setText(sb.toString());
                  label.setTextColor(lv.isEmpty() ? 0xCCFFFFFF : levelColor(lv));
              }
          }

        void showJpeg(byte[] jpg) {
            long now = System.currentTimeMillis();
            int n = Math.max(1, wins.size());
            int capFps = n <= 1 ? 30 : (n <= 3 ? 15 : 8);
            if (now - lastFrameAt < (1000 / capFps)) { dropped++; return; }
            lastFrameAt = now;
            try {
                // **收起时也解码**：用户要的是「很小的实时画面」，不是冻结帧。
                // 只是不解码到不可见窗口（被 ✕ 隐藏那种）。
                if (root == null || root.getVisibility() != View.VISIBLE) return;
                Bitmap bm = BitmapFactory.decodeByteArray(jpg, 0, jpg.length);
                if (bm == null) return;
                final Bitmap fb = bm;
                // 更新比例（用解码出来的真实尺寸）
                float a = (float) fb.getWidth() / Math.max(1, fb.getHeight());
                if (Math.abs(a - aspect) > 0.01f) {
                    aspect = a;
                    // 收起状态不改尺寸（否则实时刷新会把小预览打回大窗口）
                    if (!collapsed) {
                        ui.post(new Runnable() { public void run() { applyAspect(); } });
                    }
                }
                ui.post(new Runnable() {
                    public void run() {
                        // **收起时也要刷新画面！** 原来写了 !collapsed，最小化后小预览永远停在第一帧
                        if (img != null && alive) img.setImageBitmap(fb);
                    }
                });
            } catch (Throwable t) { /* 单帧解码失败不影响流 */ }
        }

        /** 查 /status；服务端说没在跑就关掉自己这个窗口。 */
        boolean pollStatus() {
            try {
                String st = http("http://127.0.0.1:" + port + "/status");
                if (st == null) {
                    // **连续 5 次（15 秒）都连不上 = 端口真的没了** → 关窗
                    if (++statusFails >= 20) {
                        Log.i(TAG, "端口 " + port + " 连续 " + statusFails + " 次不通，关闭窗口");
                        ui.post(new Runnable() { public void run() { removeWin(port); } });
                        return false;
                    }
                    return true;
                }
                statusFails = 0;
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
            Log.w(TAG, "http 失败 " + u + " : " + t.getClass().getSimpleName() + " " + t.getMessage());
            return null;
        } finally {
            try { if (c != null) c.disconnect(); } catch (Throwable t) { /* ignore */ }
        }
    }

    static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { /* ignore */ }
    }

    /** 当前操作方式与风控等级，从 /data/local/tmp/dshframe/opmode 读。
     *
     *  为什么走文件：插件（Node）和浮窗（Java）是两个进程，
     *  但都在 uid 2000 能写的 /data/local/tmp 下，落一个小文件最省事，
     *  不用再开 socket。插件每次操作前写一行，浮窗轮询读，读不到就显示空。
     *
     *  格式：`L2|拟人化|vdisplay_tap_text` 或简写 `L2|vdisplay_tap_text`
     */
    /** 读插件写的状态行：`L2|注入·tap|699`。缺段返回空串。
     *
     *  用户 2026-11-21 要求浮窗同时显示：风控等级、当前操作方式、后台屏编号。
     *  插件在每次操作前/守护进程定时写这一行，浮窗轮询解析。
     */
    static String[] readStatus() {
        java.io.BufferedReader r = null;
        try {
            r = new java.io.BufferedReader(new java.io.FileReader("/data/local/tmp/dshframe/opmode"));
            String line = r.readLine();
            if (line == null) return null;
            line = line.trim();
            if (line.isEmpty()) return null;
            String[] parts = line.split("\\|", -1);
            String[] out = new String[] { "", "", "" };
            for (int i = 0; i < parts.length && i < 3; i++) {
                String v = parts[i].trim();
                out[i] = v.length() > 24 ? v.substring(0, 24) : v;
            }
            // 等级段必须是 L0..L5，别的当没拿到
            String lv = out[0];
            if (lv.length() != 2 || (lv.charAt(0) != 'L' && lv.charAt(0) != 'l')
                    || lv.charAt(1) < '0' || lv.charAt(1) > '5') {
                out[0] = "";
            } else {
                out[0] = "L" + lv.charAt(1);
            }
            return out;
        } catch (Throwable t) {
            return null;
        } finally {
            try { if (r != null) r.close(); } catch (Throwable t) { /* ignore */ }
        }
    }

    static String readRiskLevel() {
        java.io.BufferedReader r = null;
        try {
            r = new java.io.BufferedReader(new java.io.FileReader("/data/local/tmp/dshframe/opmode"));
            String line = r.readLine();
            if (line == null) return "";
            line = line.trim();
            /* 只认 `L0`..`L5` 这种两字符开关。
             * 2026-11-21 用户反馈：之前那行是「屏 38820 · 注入·tap」，一堆看不懂的，
             * 唯一有意义的是风控等级。所以这里只取等级，别的全部丢掉。 */
            if (line.length() >= 2 && (line.charAt(0) == 'L' || line.charAt(0) == 'l')
                    && Character.isDigit(line.charAt(1))) {
                return "L" + line.charAt(1);
            }
            return "";
        } catch (Throwable t) {
            return "";
        } finally {
            try { if (r != null) r.close(); } catch (Throwable t) { /* ignore */ }
        }
    }

    /** 等级 → 中文短词。用户要能一眼看懂这一档意味着什么。 */
    static String levelWord(String lv) {
        switch (lv) {
            case "L0": return "自由";
            case "L1": return "控频";
            case "L2": return "拟人";
            case "L3": return "只读";
            case "L4": return "人工";
            case "L5": return "不可";
            default:   return "";
        }
    }

    /** 等级 → 颜色。越高越红，用户不用读字就知道危险程度。 */
    static int levelColor(String lv) {
        switch (lv) {
            case "L0": return 0xFF34D399;   // 绿
            case "L1": return 0xFFA3E635;   // 黄绿
            case "L2": return 0xFFFACC15;   // 黄
            case "L3": return 0xFFFB923C;   // 橙
            case "L4": return 0xFFEF4444;   // 红
            case "L5": return 0xFFDC2626;   // 深红
            default:   return 0xFFFFFFFF;
        }
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
