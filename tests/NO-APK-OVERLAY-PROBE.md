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

---

# 补充：AOSP 源码级核实（2026-11-18，独立子代理核对）

子代理对比了 AOSP `Session.java` 的 **android14-release / android15-release / main** 三个分支，
独立确认了结论，而且找到了精确的版本分界线。

## 源码对比

**android14-release —— 只打日志：**
```java
void windowAddedLocked() {
    if (mPackageName == null) {
        final WindowProcessController wpc =
                mService.mAtmService.mProcessMap.getProcess(mPid);
        if (wpc != null) { mPackageName = wpc.mInfo.packageName; ... }
        else { Slog.e(TAG_WM, "Unknown process pid=" + mPid); }   // ← 只是日志，继续
    }
    ...
}
```

**android15-release / main（16+）—— 直接抛：**
```java
mPid = callingPid;
mUid = callingUid;
synchronized (service.mGlobalLock) {
    mProcess = service.mAtmService.mProcessMap.getProcess(mPid);
}
if (mProcess == null) {
    throw new IllegalStateException("Unknown pid=" + mPid + " uid=" + mUid);
}
```

**版本边界**：14.0 还能用，**14 QPR3 起安全补丁被回移，15/16 上是硬门槛**。
（RikkaW 的 gist 标题原文：*"impossible to work from Android 14 QPR 3 or Android 15,
as addView requires the calling process an Android app process"*）

## 这否定了所有「绕」的办法

因为异常发生在**所有权限检查之前**：

| 以为能绕的 | 实际 |
|---|---|
| 换 Context（systemMain / FakeContext）| ❌ Session 只看 pid/uid，不看 Context |
| 直调 `WindowManagerGlobal.addView` | ❌ 内部还是 `new ViewRootImpl` → `openSession` |
| `setDefaultToken(new Binder())` | ❌ 异常在 token 解析之前 |
| 注入 `ServiceManager.sCache` | ❌ 只解决服务可见性，不解决 pid 校验 |
| 伪造 `atts.token` / `packageName` | ❌ 还没轮到 `addWindow` |
| 伪造 pid | ❌ 做不到，`Binder.getCallingPid()` 由驱动填 |
| 自己 `attachApplication` 冒充 | ❌ AMS 只接受它自己 spawn 的进程，且会搞坏状态 |

**核心：`ProcessRecord` 只能由 AMS 在 `startProcessLocked` 时创建，只有 zygote fork 的进程才有。**

## 两个额外的坑（即使 Session 放宽也会撞）

1. **`lp.packageName` 必须显式设成 `com.android.shell`**
   用 system context 时它默认是 `"android"`，与 uid 2000 不匹配 →
   `AppOpsManager.checkOpNoThrow(OP_SYSTEM_ALERT_WINDOW, 2000, "android")` 会被拒。
   **我的探针没设这个**，是个疏漏（但反正死在 Session 之前）。

2. **`ContextWrapper.getPackageName()` ≠ `getBasePackageName()` / `getOpPackageName()`**
   `ViewRootImpl` 拿的是后两个，只改前者白改。

## 先例盘点

| 项目 | 结论 |
|---|---|
| RikkaW gist | 唯一靠谱先例，作者自己标注 14 QPR3/15 起不可能 |
| scrcpy `FakeContext` | 只给**读取类** API 用（Settings/PackageManager），**从不 addView** |
| Auto.js / AutoX / Scene / Tasker | 悬浮窗全是 APK 内进程 |
| Shizuku | 不画窗口 |
| SurfaceControl 直连 SF | 【推测】能画像素但拿不到触摸/焦点，且 SELinux 未知，没试 |

**「不装 APK 就能浮窗」的可行先例，只找到 14 及以前的，15+ 没有。**

## 最终结论

**装 APK 这条路不是「没找到更好的办法」，是 Android 15 起 WMS 在代码层面关死了非应用进程建窗口。**

**「内置 APK + 自动装 + appops 授权」已经是这个平台上最省事的正确解**（实测 1094ms，用户零操作）。

## 顺带的实用信息

- `pm install` 由 uid 2000 执行，**没有用户确认框**（shell 有 `INSTALL_PACKAGES`）
- `SAW` 不是 runtime permission，`pm grant` 无效，只能 `appops set`
- 重装必须同一签名，否则 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`
- `targetSdk 30` 是为绕 Android 14+ 的前台服务类型声明
- Android 15+ 会对「显示在其他应用上层」的包弹系统通知，无法关掉，属正常
