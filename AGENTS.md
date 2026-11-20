# AGENTS.md — 给 AI agent 的使用说明

> 这个文件是给 **CLI agent / 编码助手** 读的，不是给人看的。
> Codex、Cursor、Copilot、Zed、Aider、Claude Code 会原生读 `AGENTS.md`。

## 这是什么

一个安卓**「后台屏」**实现：给 AI 一块用户看不见的虚拟屏（`VirtualDisplay`），
AI 在那块屏上运行 App、点击、输入、截图，用户的物理主屏完全不受影响。

**不要**把它当成"另一个 scrcpy 封装"。区别在于：scrcpy 镜像的是**主屏**，
AI 的操作直接显示在用户脸上；这里操作的是**一块独立创建的显示设备**。

## 你能用它做什么

如果用户说：
- 「帮我挂机 / 帮我操作这个 App，但我要继续用手机」
- 「AI 点的时候别抢我屏幕 / 别弹窗 / 别抢键盘」
- 「让 AI 在后台跑微信/淘宝/游戏」
- 「同时盯着两个 App」

→ 这就是正确的工具。

如果用户说：
- 「帮我操作银行 App / 支付」→ **不行**，`FLAG_SECURE` 截不到图
- 「把微信开两个实例」→ **不行**，`singleTask` 限制
- 「在 iPhone 上」→ 不行

## 前置条件（先检查，别直接跑）

```bash
# ① 必须有 adb，且能连上本机
adb devices                      # 要有 127.0.0.1:5555
adb -s 127.0.0.1:5555 shell id   # 应该是 uid=2000(shell)

# ② 没有 5555 就先配（手机需开无线调试，只配一次）
adb connect 127.0.0.1:5555

# ③ 确认不是 root 设备也能跑
adb shell getprop ro.build.version.sdk   # 需要 >= 31（Android 12+）
```

**不要**试着 `adb root`，这套工具设计成 uid 2000 就能工作。

## 装法

```bash
git clone https://github.com/JMINN0/dsh-go-second-screen.git
cd dsh-go-second-screen
bash tools/fetch-sdk.sh        # 下载 37MB 编译依赖（不在 git 里）
bash overlay/build.sh          # 悬浮窗 APK
bash framesrv/build.sh         # 取帧 dex
```

装完必须**重启引擎**才生效（MCP 工具是启动时加载的）。

## 五个最容易踩的坑

1. **虚拟屏会随创建它的进程一起死。**
   如果你用 `node -e "..."` 建屏，进程一退屏就没了。要用长驻进程，或者用 MCP 工具（引擎持有的）。

2. **`am start --display N` 对 `singleTask` App 会把主屏任务搬走。**
   设置、文件管理器、微信都是 `singleTask`。想投它们到后台屏，做不到。
   测试时用闲鱼、B站、浏览器、mpv、游戏这类非 singleTask 的。

3. **`SET_CLIPBOARD` + `KEYCODE_PASTE` 打不进中文。**
   要长按输入框 → 点「粘贴」。`adb shell input text` 对中文会失败。

4. **绝对不要用 `monkey` 启动 App。**
   实测 4/4 次会把系统的自动旋转打开。

5. **不要随手 `force-stop` 用户正在用的 App。**
   先查 `dumpsys window | grep mCurrentFocus` 和 `dumpsys media_session | grep PLAYING`。

## 关键命令

```bash
# 建一块后台屏（MCP 工具，推荐）
mcp__phone__vdisplay_start  {orientation: "portrait"}

# 投 App 到后台屏（用 --display，且 App 不能是 singleTask）
adb shell am start --display <displayId> -n <pkg>/<activity>

# 看后台屏在不在
adb shell dumpsys display | grep "Virtual display"

# 取帧服务状态
curl -s http://127.0.0.1:38820/status

# 点击位置可视化（水滴波纹）
curl -s "http://127.0.0.1:38820/mark?nx=0.5&ny=0.5"
```

## 强制规则

- **不要碰 `accelerometer_rotation`**（用户 2026-11-05 明确禁止）
- **不要在没有确认前台的情况下 `am force-stop`**
- **操作浏览器只能进 Edge 的「AI操作」标签组**（用户 2026-11-05 定）
- 用户在用手机时（前台是 DSH Go 或输入法弹着）**不要抢前台**

## 已知不适用

- 需要 `FLAG_SECURE` 的目标 → 截不到，直接告诉用户做不到
- 高风控 App（银行、部分游戏）→ 事件注入可被识别，需要真实输入
- 想完全拟人化 → 做不到，`adb input` 没有 MOVE、压力恒定

## 详细文档

- [README.md](README.md) — 完整原理、安装、工具清单
- [LIMITS.md](LIMITS.md) — 25 条做不到的事
- [llms.txt](llms.txt) — 一页速览
