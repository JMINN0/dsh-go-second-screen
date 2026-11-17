# 能不能不装 APK 就画悬浮窗？—— 探针实测：不能

> 2026-11-18。用户质疑「为什么单独做成一个 App」，这是查清楚的答案。

## 结论

**`app_process` 画不了悬浮窗。** 不是权限问题，是**进程注册**问题。

## 实测过程

前提（全部满足）：
```
android.permission.SYSTEM_ALERT_WINDOW:   granted=true   ← shell 已授予
android.permission.INTERNAL_SYSTEM_WINDOW: granted=true
```

探针 `probe/src/com/dsh/probe/OverlayProbe.java`（170 行）三步：

| 步骤 | 结果 |
|---|---|
| ① 拿 Context（`ActivityThread.systemMain()` → 反射 `mSystemContext`）| ✅ **成功**，`pkg=android` |
| ② 拿 WindowManager（`ctx.getSystemService(WINDOW_SERVICE)`）| ✅ **成功**，`android.view.WindowManagerImpl` |
| ③ `wm.addView(textView, lp)` | ❌ **失败** |

失败信息：
```
IllegalStateException: Unknown pid=19074 uid=2000
  at com.android.server.wm.Session.<init>(Session.java:161)
  at com.android.server.wm.WindowManagerService.openSession(WindowManagerService.java:6503)
```

## 根因

`WindowManagerService.openSession()` 建 `Session` 时会检查调用进程是否在
ActivityManager 的进程表里（`ProcessMap.isPidActive`）。

`app_process` 从 adb shell 启动，**不是 zygote fork 出来的应用进程**，
AMS 不认识它 → `Unknown pid` → 直接拒绝。

**这不是权限能解决的**（shell 已经有 `SYSTEM_ALERT_WINDOW`），
是「进程身份」问题 —— 要建窗口，进程必须是被 AMS 管理的应用进程。

## 那为什么 DSH Go 的宠物能浮起来？

因为 DSH Go **本身就是一个装好的 App**，它的进程是 AMS 注册的。

## 所以悬浮窗必须有安装包

这条绕不过去。但**用户的抱怨（「还要单独下个 app」）可以解决**：

**插件内置 APK，首次使用时自动装** —— 用户不用手动下载、不用手动装。

见 `overlay/README.md` 的「零门槛」一节。

## 试过但没继续的路

1. **`ActivityThread.main()` + `attach()`** —— 让 app_process 冒充应用进程注册到 AMS。
   【推测】AMS 会校验包名、uid、签名，冒充大概率失败；且容易搞崩系统。
   **没试，风险太高**（可能让 AMS 认为有个坏进程，影响整机）。
2. **`WindowManagerGlobal.addView` 直接绕** —— 它内部还是要 `IWindowSession`，
   还是会走到 `openSession`，同一个检查。
3. **`SurfaceControl` 直接画** —— 需要 `READ_FRAME_BUFFER`（有），但那是合成层，
   不是窗口，画不出能接收触摸的 UI，而且要自己处理输入。

## 结论

**装 APK 是必须的，但可以让用户完全无感。**
