# AI 画面悬浮窗（独立 APK）

**浮在任何 App 上面的 AI 操作画面** —— 像 DSH Go 的小鲸鱼娘那样，但显示的是虚拟屏内容。

## 为什么必须是独立 APK

插件跑在 proot 的 Node 里，画不了 Android 窗口。
要浮在别的 App 上，必须有 `SYSTEM_ALERT_WINDOW` 权限的**安装包**。

## 实测结果（2026-11-18）

```
安装:        Success
权限:        appops set com.dsh.overlay SYSTEM_ALERT_WINDOW allow → allow
服务:        ServiceRecord 1 个
窗口:        ty=APPLICATION_OVERLAY，mDisplayId=0
```

**在 DSH Go 和 B 站上都能看到** —— 截图验证过，窗口浮在两者之上。

## 能力

| 功能 | 状态 |
|---|---|
| 浮在任何 App 上 | ✅ 实测 DSH Go + B站 |
| 显示虚拟屏画面 | ✅ 3fps 轮询推流 |
| 显示状态（看屏幕/操作中/完成）| ✅ |
| 横竖屏自适应 | ✅ 按 /status 的 aspect 调高度 |
| 拖动 | ✅ 按住拖 |
| 单击收起/展开 | ✅ 收起成「AI」小方块 |
| 自动消失 | ✅ /status 说 running=false 就自己关 |
| 不抢焦点 | ✅ FLAG_NOT_FOCUSABLE，用户还能打字 |
| 不挡状态栏 | ✅ FLAG_NOT_FOCUSABLE + TRANSLUCENT |

## 用法

```bash
# 1. 装
adb install -r app-signed.apk

# 2. 给悬浮窗权限（不用手点）
adb shell appops set com.dsh.overlay SYSTEM_ALERT_WINDOW allow

# 3. 启动（port 来自 stream.json）
adb shell am start -n com.dsh.overlay/.MainActivity --ei port 46745

# 4. 停
adb shell am start -n com.dsh.overlay/.MainActivity --ez stop true
```

## 构建（本机工具链，不需要 Android Studio）

```bash
cd overlay
./build.sh
```

工具链：
- `javac`（openjdk-21-jdk-headless）
- `android-30.jar`（tools/sdk/，21MB）
- `d8`（tools/sdk/r8.jar 8.3.37）
- `aapt` / `zipalign` / `apksigner`（/usr/lib/android-sdk/build-tools/debian/）

**这套是纯命令行，能在这个 ARM64 proot 里跑。**

## 已知限制

1. **轮询 400ms**：画面延迟约 0.4-0.8 秒。要更快得改成 MJPEG 流或长连接。
2. **targetSdk 30**：Android 14+ 的前台服务类型没声明（用 targetSdk 30 绕开），
   后续如果要上 Play 商店需要补。
3. **只有 3fps**：推流本身限制，不是悬浮窗的问题。
4. **APK 没做资源**（图标用系统自带的），体积 16KB。

## 架构

```
虚拟屏（用户看不见）
    ↓ scrcpy 编码
推流服务（插件里，127.0.0.1:<port>）
    ↓ HTTP /frame.jpg + /status
悬浮窗 APK（独立进程）
    ↓ WindowManager.addView
浮在任何 App 上
```

**关键解耦**：APK 只依赖 HTTP 端点，不依赖 Node、不依赖插件内部状态。
所以任何能给 HTTP 的服务都能驱动它。
