package com.dsh.overlay;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 极简入口：要权限 → 起服务。
 *
 * 不做界面 —— 用户真正要看的是悬浮窗，这个 Activity 只是用来：
 *   ① 拿 SYSTEM_ALERT_WINDOW 权限（必须用户手动点，无 root 绕不过）
 *   ② 收端口参数并转给 OverlayService
 *
 * 用 adb 启动：
 *   adb shell am start -n com.dsh.overlay/.MainActivity --ei port 38601
 *   adb shell am start -n com.dsh.overlay/.MainActivity --ei port 38601 --ez stop true
 */
public class MainActivity extends Activity {
    private static final String TAG = "DshOverlay";

    /**
     * **singleTask 下必须实现 onNewIntent。**
     *
     * 对抗审查发现：manifest 加了 launchMode="singleTask" 之后，
     * 第二次 `am start` 若落到已有 Activity，会走 onNewIntent 而不是 recreate，
     * 而原来没实现这个方法 → `--ez stop true` / `--ei port` **被静默丢弃**，
     * 表现为「点关闭没反应」「新屏不起窗口」。
     */
    @Override
    protected void onNewIntent(Intent it) {
        super.onNewIntent(it);
        setIntent(it);
        try { handleIntent(it); } catch (Throwable t) { Log.w(TAG, "onNewIntent: " + t.getMessage()); }
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        handleIntent(getIntent());
    }

    /** 统一的 Intent 处理入口（onCreate 和 onNewIntent 共用）。 */
    private void handleIntent(Intent it) {
        if (it == null) { finish(); return; }

        // stop=true → 停服务
        if (it != null && it.getBooleanExtra("stop", false)) {
            stopService(new Intent(this, OverlayService.class));
            /* **不弹 Toast。**
             *
             * 2026-11-21 用户报：浮窗早就关了，过一会又突然弹一个「已关闭」。
             * 根因就是这个 Toast —— stop 的 Intent 是异步投递的，
             * 插件收尾时可能连发几次，每次都会拉起一个隐藏的 Activity 弹一次提示。
             * 而用户关窗后看到的画面消失，本身就是最好的反馈，这句提示纯属噪音。
             */
            finish();
            return;
        }

        int port = it != null ? it.getIntExtra("port", 0) : 0;
        int closePort = it != null ? it.getIntExtra("closePort", 0) : 0;
        String state = it != null ? it.getStringExtra("state") : null;

        // ① 要悬浮窗权限
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this)) {
            Toast.makeText(this, "请授予「显示在其他应用上层」权限", Toast.LENGTH_LONG).show();
            try {
                Intent req = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + getPackageName()));
                req.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(req);
            } catch (Exception e) {
                Log.w(TAG, "开权限页失败: " + e.getMessage());
            }
            finish();
            return;
        }

        // ② 起服务
        Intent sv = new Intent(this, OverlayService.class);
        if (port > 0) sv.putExtra("port", port);
        if (closePort > 0) sv.putExtra("closePort", closePort);
        if (state != null) sv.putExtra("state", state);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(sv);
        else startService(sv);

        Toast.makeText(this, port > 0 ? ("悬浮窗已启动，端口 " + port) : "悬浮窗已启动",
                Toast.LENGTH_SHORT).show();
        finish();
    }
}
