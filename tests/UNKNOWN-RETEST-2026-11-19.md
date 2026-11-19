# 「做不到」清单复核 —— 16 条里只有 4 条站得住

> 2026-11-19 独立复核（只读静态分析 + 本地 jar 符号核对）。

## 结论分布

| 判断 | 条数 | 说明 |
|---|---|---|
| **经得起复核** | 4 | #13 读 data/data、#16 无 APK 悬浮窗、#5 还原键盘焦点、#6 无痕抢前台 |
| **已被项目自己推翻、文档没同步** | 3 | #8 视频抓不到（实测 34fps）、#2 多指、#4 不夺焦点打中文 |
| **技术理由本身是错的** | 3 | #11 短信、#14 蓝牙 HID、#10 手柄 |
| **从没试过，且有更便宜的新路** | 6 | #1 无障碍、#7 MediaProjection、#12 多用户 |

## 三个最值得试的（按性价比）

### ① 多指：只发基础 action ✅ 已做
已在 2026-11-19 完成。反编译 scrcpy 字节码发现服务端自己算 pointer index，
客户端发 `5|(1<<8)` 被截断成 5 → 事件被丢弃。改发 0/1/2 后 Inconsistent=0。

### ② 无障碍读虚拟屏：不需要装 APK
**关键改判**：android-30.jar 里有 `UiAutomation.getWindowsOnAllDisplays()`，
可以在 `app_process` 里用（和 framesrv 同一条流水线），
`setServiceInfo()` 能塞 `FLAG_RETRIEVE_INTERACTIVE_WINDOWS`。

**装 APK + 用户点无障碍这一整套成本可以去掉。**

最小实验（30-60 分钟）：
1. 2 分钟：`adb shell uiautomator dump` 看是否还报 UiAutomation 被占用
2. 25 分钟：写 40 行 app_process → `getWindowsOnAllDisplays()` → 打印每个 displayId
3. 判定：出现虚拟屏那个 key = 通（感知 20-30 倍提速成立）

### ③ 注入器 int 返回码：15 分钟决定 D-03
`InputManagerGlobal.injectInputEvent(InputEvent, int, int)` 的 3 参版本有 int 返回码
（文档说「方法解析失败」是**反射签名问题，不是接口不存在**）。
拿到 int 能区分 PERMISSION_DENIED / FAILED / TIMED_OUT，一步定位。
注意第三参数是 `UserHandle.USER_ALL = -1`，**不是 displayId**。

## 文档矛盾（已修）

| 文件 | 原说法 | 实际 |
|---|---|---|
| `README.md:67` | 视频抓不到 | **三次实测：34.3fps / 7fps / 76fps** |
| `VIDEO-VIA-CACHE.md` | MediaCodec 只出首帧 | 同上 |
| `MULTITOUCH-FAILED.md` | 多指分支没调 refreshRealSize | 在 input() 顶部，是 grep 太脆 |
| `MULTITOUCH-FAILED.md` | UHID 需要 root | 未验证；Android 11+ scrcpy 就用 /dev/uhid 无需 root |
| `LIMITS.md` | 蓝牙只做 HID Host | android-30.jar 有 BluetoothHidDevice（API 28+）|

## 一条系统性问题

第 3、4、5、6 条写在 `/root/.agents/AGENTS.md:430-434`（**每次会话必加载**）。
其中 3 和 4 已经过时，但因为在必加载文件里，会被**无条件执行且不再被复查**。

**错的规则放在必加载文件里，成本比放在 LIMITS.md 里高一个数量级。**
建议：必加载文件只写「判断标准」，具体事实结论放项目记录并带复查日期。
