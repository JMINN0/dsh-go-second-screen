package com.dsh.probe;

import android.content.Context;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;

import java.lang.reflect.Method;

/**
 * 无 APK 悬浮窗探针 —— 验证 app_process 能不能直接画 overlay。
 *
 * ## 为什么重要
 *
 * 现在的方案要装一个独立 APK，用户嫌麻烦（「别人去 GitHub 还要单独下个 app」）。
 * 如果 app_process 能直接画，就完全不需要 APK。
 *
 * ## 已确认的前提
 *
 * ```
 * android.permission.SYSTEM_ALERT_WINDOW: granted=true   ← shell 有
 * android.permission.INTERNAL_SYSTEM_WINDOW: granted=true
 * ```
 *
 * ## 关键难点：Context
 *
 * `WindowManager.addView` 要 Context。app_process 没有 Activity。
 * 试三条路：
 *   A. ActivityThread.systemMain() → getSystemContext()
 *   B. ActivityThread.currentActivityThread() → 反射 getSystemContext
 *   C. 拿不到就用 systemMain 的 mSystemThread 里的 ContextImpl
 *
 * ## 用法
 *
 * ```
 * CLASSPATH=/data/local/tmp/dshovp/ovp.dex app_process / com.dsh.probe.OverlayProbe --ms=8000
 * ```
 */
public class OverlayProbe {

    public static void main(String[] args) {
        int ms = 8000;
        for (String a : args) {
            if (a.startsWith("--ms=")) ms = Integer.parseInt(a.substring(5));
        }
        System.out.println("PROBE_OVERLAY start");

        Looper.prepareMainLooper();

        Context ctx = null;
        String how = null;

        // ── 路线 A: ActivityThread.systemMain()
        try {
            Class<?> at = Class.forName("android.app.ActivityThread");
            Method sysMain = at.getDeclaredMethod("systemMain");
            sysMain.setAccessible(true);
            Object thread = sysMain.invoke(null);
            System.out.println("A1 systemMain ok: " + (thread != null));
            // 从 thread 里拿 mSystemContext 字段
            java.lang.reflect.Field f = at.getDeclaredField("mSystemContext");
            f.setAccessible(true);
            Object c = f.get(thread);
            if (c instanceof Context) {
                ctx = (Context) c;
                how = "systemMain.mSystemContext";
                System.out.println("A2 mSystemContext ok, pkg=" + ctx.getPackageName());
            }
        } catch (Throwable t) {
            System.out.println("A_ERR " + t.getClass().getSimpleName() + ": " + t.getMessage());
        }

        // ── 路线 B: getSystemContext() 静态方法
        if (ctx == null) {
            try {
                Class<?> at = Class.forName("android.app.ActivityThread");
                Method m = at.getDeclaredMethod("getSystemContext");
                m.setAccessible(true);
                Object c = m.invoke(null);
                if (c instanceof Context) {
                    ctx = (Context) c;
                    how = "getSystemContext()";
                    System.out.println("B ok, pkg=" + ctx.getPackageName());
                }
            } catch (Throwable t) {
                System.out.println("B_ERR " + t.getClass().getSimpleName() + ": " + t.getMessage());
            }
        }

        // ── 路线 C: currentActivityThread + 反射
        if (ctx == null) {
            try {
                Class<?> at = Class.forName("android.app.ActivityThread");
                Method cur = at.getDeclaredMethod("currentActivityThread");
                cur.setAccessible(true);
                Object thread = cur.invoke(null);
                System.out.println("C1 currentActivityThread=" + (thread != null));
                if (thread != null) {
                    java.lang.reflect.Field f = at.getDeclaredField("mSystemContext");
                    f.setAccessible(true);
                    Object c = f.get(thread);
                    if (c instanceof Context) { ctx = (Context) c; how = "current.mSystemContext"; }
                }
            } catch (Throwable t) {
                System.out.println("C_ERR " + t.getClass().getSimpleName() + ": " + t.getMessage());
            }
        }

        if (ctx == null) {
            System.out.println("RESULT ctx=null 失败");
            System.exit(3);
        }
        System.out.println("CTX_OK via=" + how + " pkg=" + ctx.getPackageName());

        // ── 拿 WindowManager
        WindowManager wm = null;
        try {
            wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
            System.out.println("WM_OK " + (wm != null) + " class=" + (wm == null ? "-" : wm.getClass().getName()));
        } catch (Throwable t) {
            System.out.println("WM_ERR " + t.getClass().getSimpleName() + ": " + t.getMessage());
        }
        if (wm == null) { System.out.println("RESULT wm=null 失败"); System.exit(4); }

        // ── 建 View 并 addView
        try {
            TextView tv = new TextView(ctx);
            tv.setText("PROBE OK");
            tv.setTextColor(Color.WHITE);
            tv.setBackgroundColor(0xCC000000);
            tv.setPadding(30, 20, 30, 20);

            int type = Build.VERSION.SDK_INT >= 26
                    ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                    : WindowManager.LayoutParams.TYPE_PHONE;
            WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    type,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                    PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.CENTER;
            wm.addView(tv, lp);
            System.out.println("ADDVIEW_OK ✅ 悬浮窗已添加（无 APK）");
        } catch (Throwable t) {
            System.out.println("ADDVIEW_ERR " + t.getClass().getSimpleName() + ": " + t.getMessage());
            Throwable c = t.getCause();
            if (c != null) System.out.println("  cause: " + c.getClass().getSimpleName() + ": " + c.getMessage());
            System.out.println("RESULT addview=失败");
            System.exit(5);
        }

        // 保持一段时间，好让外面截图验证
        final boolean[] done = {false};
        new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
            public void run() { done[0] = true; Looper.myLooper().quitSafely(); }
        }, ms);

        System.out.println("LOOP_START ms=" + ms);
        Looper.loop();
        System.out.println("RESULT addview=成功");
        System.exit(0);
    }
}
