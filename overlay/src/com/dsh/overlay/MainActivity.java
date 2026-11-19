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

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        Intent it = getIntent();

        // stop=true → 停服务
        if (it != null && it.getBooleanExtra("stop", false)) {
            stopService(new Intent(this, OverlayService.class));
            Toast.makeText(this, "已停止", Toast.LENGTH_SHORT).show();
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
