# 后台屏 · 让 AI 操控安卓手机，但不抢你的屏幕

**一句话**：这个项目给 AI 在安卓手机上开一块**默认不画在物理屏幕上**的虚拟屏（Android `VirtualDisplay`），
AI 在那块屏上跑 App、点按钮、读文字、玩游戏，而你的主屏、输入法、前台应用的**焦点不会被夺走**

这件事解决的是「**AI 操控手机（computer use）时，人和 AI 抢同一块屏幕**」这个问题 ——
现有的手机自动化方案（无障碍服务、scrcpy 投屏镜像、Appium / UI Automator）都必须占用你的屏幕，
所以它们只能「你让开、它来干」。后台屏把这条约束拆掉了：**不抢屏幕、不打扰用户**，
AI 用的是另一块屏，你还是用你原来那块。

[English](README.en.md) ｜ 中文

> **状态：实验性（v0.1.0）。** 核心链路已在本机实测跑通（含 3D 游戏、网页登录、双屏并存），
> 但有已知问题没修完，见第十节。**只在一台机器上验证过，暂不推荐普通用户直接日常使用。**

---

## 一、三条最核心的能力

| # | 能力 | 实际含义 |
|---|---|---|
| **1** | **后台屏（虚拟屏）** | 一块 720×1592 的 display，**不画在物理屏幕上**、**不抢焦点**、**不抢输入法**。任意 App 可以投上去，AI 用 `vdisplay_*` 那 39 个工具操作它 |
| **2** | **浏览器 CDP 直连** | 不点屏幕、不截图猜坐标，直接用 Chrome DevTools Protocol 读 DOM、点元素、填表单（10 个工具） |
| **3** | **你能看见 AI 在干什么** | 一块悬浮窗（`TYPE_APPLICATION_OVERLAY`）实时显示后台屏画面，点击位置有水滴波纹。**它不抢焦点，你能同时打字** |

配套还有：命令行 `vdisplay`（**不装 DSH 也能用**，任何能跑 bash 的 AI Agent 都行）、
MCP server（给 Claude Desktop / Cursor 这类宿主）、多屏池（一次跑多个 App）、
App 占用租约（多 AI 不互相踩）。

---

## 二、为什么需要它：屏幕是单一资源

### 2.1 争用点在哪

人用手机和 AI 用手机，抢的是同一样东西：

```
一块物理屏幕（Display 0）
  ├── 只有一个前台窗口   → 谁在前台，谁可见
  ├── 只有一个输入焦点   → 焦点在哪，输入事件去哪
  └── 只有一个输入法（IME）
```

现有方案全部建立在「操作 Display 0」这个前提上，于是必然二选一：

- **AI 在操作时，你不能碰手机**（你一点，AI 的界面就没了）
- **你在用手机时，AI 不能操作**（它一操作，前台就跳走，你的草稿/播放/输入法全断）

### 2.2 三种现有方案为什么不够

| 方案 | 怎么操作 | 为什么不够 |
|---|---|---|
| **无障碍服务**（AccessibilityService） | 读无障碍树 + `dispatchGesture` 注入手势 | 树和手势都作用于**当前活动窗口**。要让 AI 操作微信，微信就必须在 Display 0 前台 —— 你就得让开。而且需要用户手动开启无障碍、装 APK、常驻服务 |
| **投屏镜像**（scrcpy 默认模式 / 各类「AI 手机」） | 把 Display 0 的画面推到电脑或另一个窗口，再把点击回灌到 Display 0 | 镜像的是**你的屏幕**。AI 点一下，你的手机上真的会动；你滑一下，AI 的坐标系就错了 |
| **Appium / UI Automator** | `UiAutomation` 读控件树 + 注入事件 | 同上，作用于默认屏。且本机实测 `uiautomator dump` 会因 `UiAutomationService` 被占用直接崩溃 |

三个方案的共同点是：**它们把「屏幕」当成必须独占的资源，只优化了操作方式，没有解决资源争用。**
只要还在 Display 0 上干活，人和 AI 就不可能同时用。

### 2.3 拆掉争用的办法：给 AI 另一块屏

Android 显示子系统本身就支持**多块 display**：每块 display 有自己的 SurfaceFlinger 图层、
自己的窗口栈、自己的焦点、自己的输入路由。手机上常见的无线投屏 / 副屏 / 车载屏就是这个机制。

所以答案是：给 AI 建一块 **`VirtualDisplay`** —— 物理上存在（合成器真的在合成它）、
用户看不见（没有 `FLAG_PUBLIC`，不投到任何物理面板上）、焦点独立（`FLAG_OWN_FOCUS`）。

人和 AI 从此不抢同一份资源：

```
Display 0（你的屏）          VirtualDisplay（AI 的屏）
  前台：你的 App                前台：被操作的 App
  焦点：你的输入框              焦点：AI 的注入事件
  输入法：你正在打字            输入法：不弹（hide）
```

**这是 Android 显示子系统自身的能力，不是外挂、不是 hook、不注入别人进程。**
所以它不需要 root，也不会被「改机/注入/重打包」那类检测命中（详见第十二节 FAQ 与 [LIMITS.md](LIMITS.md)）。

---

## 三、它是怎么做到的

### 3.1 关键：`new_display` 而不是「镜像」

```
插件 screen/（跑在 DSH 引擎的 Node 进程里）
   │ 1. 起一个 uid 2000（shell）的 app_process 跑 scrcpy-server.jar
   │ 2. 通过 LocalSocket `scrcpy_<scid>` 下发 new_display 指令
   ▼
scrcpy-server 5.0.1
   │ 调 DisplayManager.createNewVirtualDisplay(...)
   ▼
VirtualDisplay
   │ FLAG_OWN_CONTENT_ONLY  内容不跟主屏同步（不是镜像）
   │ FLAG_OWN_FOCUS         不抢主屏焦点
   │ FLAG_TRUSTED           可托管 App
   │ 没有 FLAG_PUBLIC        不画到任何物理屏上  ← 这就是「用户看不见」
   ▼
目标 App（跑在这块屏上，自己以为在一台正常手机上）
```

判据（`screen/README.md` 记的做法）：`dumpsys display` 里 **`DisplayDeviceInfo`** 那一行，
同时带 `FLAG_OWN_CONTENT_ONLY` 与 `FLAG_OWN_FOCUS` 才是「能托管 App」的屏。
**`mBaseDisplayInfo` / `mOverrideDisplayInfo` 那两段永远不带这两个标志**，拿它判断会误判成「不能托管」。
`canHostTasks` 也不能当判据 —— 实测能正常投 App 的屏，它在 `mBaseDisplayInfo` 里是 `false`。

  > **⚠️ 这里仓库内部有矛盾，不要当确定结论。**
  >
  > 上面这段「判据」来自 `screen/README.md`。但 `LIMITS.md` A-02 引用**同一行** `dumpsys display` 输出时，
  > 记到的 flags 是 `FLAG_PRESENTATION, FLAG_TRUSTED, FLAG_OWN_DISPLAY_GROUP, FLAG_ALWAYS_UNLOCKED` ——
  > **没有** `FLAG_OWN_CONTENT_ONLY` / `FLAG_OWN_FOCUS`。
  >
  > 两份记录引同一行输出却给出不同结论，**必有一处记错了**。我没能回溯是哪一条抄错，也没核对 AOSP 源码。
  > **【不知道】**
  >
  > **判断能不能托管 App，以「能不能 `am start --display <id>` 成功」为准**，别依赖 flags 字符串。
  > 若 `LIMITS.md` 那条为真，`vd.js` 里按 flags 判 `canHost` 的逻辑会恒 false，这条待查。

### 3.2 无 root 为什么可行：权限从 `uid 2000` 来

建这块屏要的是 `ADD_TRUSTED_DISPLAY`（签名级 `signature|privileged`），普通 App 拿不到。
但 **`adb shell` 是 uid 2000，属于 `com.android.shell`**，这个包在系统里被授予了一堆签名权限：

```bash
$ adb -s 127.0.0.1:5555 shell 'dumpsys package com.android.shell | grep -c "ADD_TRUSTED_DISPLAY: granted=true"'
1
```

所以整条链路是「**借 shell 的身份**」而不是「提权」：没有 root、没有 Magisk、不改系统分区、
不 hook 任何进程。拿到的能力边界也正好是 shell 的能力边界 —— 读不到别人 App 的 `/data/data`
（SELinux 挡着），改不了需要 root 的东西。

取帧另有三条权限，探针实测（`tests/IMAGEREADER-PROBE.md`）：

```
android.permission.CAPTURE_VIDEO_OUTPUT:   granted=true
android.permission.READ_FRAME_BUFFER:      granted=true
android.permission.ACCESS_SURFACE_FLINGER: granted=true
```

> 2021 年 scrcpy issue #2242 说 shell 没有 `CAPTURE_VIDEO_OUTPUT` —— **在这台机器上不成立**。

**代价**：这条路的前提是 ADB 开着。所以 `adb_enabled=1` 这个特征消不掉，见 [LIMITS.md](LIMITS.md) A-01。
换句话说，**没有 ADB 就没有「用户看不见的屏」** —— 这一条不是工程量问题，是权限模型决定的：

- `MediaProjection.createVirtualDisplay()` 建出来的**大概率**是镜像接收端（只能接主屏画面，不能在上面启动 App）。
  **这一条是【推断】，不是实测**：`LIMITS.md` D-04 明确写着「没试过」；我们只用它做过截图，没试过往上投 App。
- `android.companion.virtual` 需要 `COMPANION_DEVICE_APP_STREAMING` role，**只有 OEM 能授给系统 App**

### 3.3 为什么屏会和进程一起消失（以及怎么解决）

虚拟屏的生命周期绑在**建它的那个进程**上：进程一退，`VirtualDisplay.release()` 一跑，屏就没了，
上面跑着的 App 一起结束。这是设计如此，好处是不留垃圾，代价是「一次性命令行调用」没法工作
（`vdisplay shot` 每次都是新进程，屏刚建好就没了）。

所以有两层结构：

```
vdisplay（CLI，随时起随时退）
   │ 回环 HTTP
   ▼
vdisplayd（常驻守护进程，握着虚拟屏）
   └── 闲置 10 分钟且没有屏时自己退出，不留垃圾
```

插件的形态里不需要 daemon：引擎进程本身就是长驻的，屏挂在引擎里。

### 3.4 取帧链路：从 143ms 一帧到 15ms 一帧

这是这个项目里性能差得最远的一段，值得单独说：

| 路径 | 一帧多久 | 怎么来的 |
|---|---|---|
| `screencap -d <SFID>` | **143ms**（≈7fps） | 每帧一次完整的 Surface 回读（141ms 是固有开销） |
| 加 PNG 编码 + adb 传输 | **227–243ms**（2.5fps） | 再 +98ms 编码、+71ms 传输 |
| scrcpy 的 H.264 视频流 | **34.3fps**（29ms） | 411 帧 / 12 秒，但需要解码 |
| **ImageReader（本项目快路径）** | **15ms**（67fps） | 从合成器直接拿 buffer，**没有回读开销** |

做法是写一个 Java 程序（`framesrv/src/com/dsh/framesrv/Main.java`，600 行），用 `app_process` 跑起来：
反射调 `DisplayManager.createVirtualDisplay()`，把虚拟屏**镜像进一个 `ImageReader`**，
自己在进程内起一个 HTTP server 吐 JPEG：

```
虚拟屏（scrcpy 建的）
   ↓ 反射 createVirtualDisplay(name,w,h,displayId,surface)
ImageReader（本进程，事件驱动：画面不变就不出帧）
   ↓ 本进程自己 serve HTTP，不经 Node 中转
/system/bin/app_process ──HTTP :38820──> 悬浮窗 APK / 胶囊 / MJPEG 长连接
```

**关键设计**：服务自己当 HTTP server，所以悬浮窗直连它，链路里没有 Node 中转。
事件驱动的副产品很好用：**静止时几乎零成本**（4 秒 1 帧），动起来立刻出帧。

### 3.5 3D 游戏为什么要开 HWC

虚拟屏默认走 GPU **软件**合成，`SurfaceView` 拿不到硬件叠加层，于是 3D 内容写不进去 —— 黑屏。
实测（REDMAGIC NX809J / Adreno）：

```
厂商声明  vendor.display.vds_allow_hwc = 1   ← 硬件支持
系统默认  debug.sf.enable_hwc_vds     = 0   ← 但出厂关着
置 1 之后 王者荣耀、Minecraft 在虚拟屏正常渲染
```

插件现在按 `hwc: "auto"` 处理：检测到 `vds_allow_hwc=1` 就打开 `debug.sf.enable_hwc_vds`，
`vdisplay_stop` 时恢复原值。**没有 HWC 支持的设备仍然会黑屏**（轻量 App 不受影响）。

> `debug.sf.enable_hwc_vds` 是**全局** SurfaceFlinger 属性，只在这类设备上临时打开，
> `vdisplay_stop` 会还原；它是 `debug.*` 属性，重启设备也会自动复原。

### 3.6 悬浮窗为什么必须是独立 APK

用户问过「为什么单独做一个 App，内置在插件里不行」。查过了，**`app_process` 画不了悬浮窗**
（`tests/NO-APK-OVERLAY-PROBE.md` 探针实测）：

```
CTX_OK     via=systemMain.mSystemContext        ✅ Context 拿到了
WM_OK      true class=android.view.WindowManagerImpl   ✅ WindowManager 拿到了
ADDVIEW_ERR IllegalStateException: Unknown pid=19074 uid=2000
            at com.android.server.wm.Session.<init>(Session.java:161)
```

`WindowManagerService.openSession()` 建 `Session` 时要求调用进程在 ActivityManager 的进程表里。
`app_process` 从 adb shell 起、不是 zygote fork 的应用进程 → `Unknown pid` → 拒绝。
**这不是权限问题**（shell 本来就有 `SYSTEM_ALERT_WINDOW: granted=true`），是**进程身份**问题。

所以做了个 24KB 的 APK，但**用户不用手动装**：APK 就在 `screen/assets/overlay/ai-overlay.apk`，
第一次用推流时插件自动 push → install → `appops set SYSTEM_ALERT_WINDOW allow` → 启动（实测 1094ms）。

---

## 三·五、安装入口只有一个：`screen/`（别装仓库根）

**实测结论**（2026-11-20）：

| 装什么 | `dsh plugin add` 能装吗 | 会激活插件吗 |
|---|---|---|
| 仓库根 `dsh-go-second-screen` | ✅ 能装成依赖 | ❌ **不激活**，profile 里不会多出条目 |
| `screen/` 子目录 | ✅ 能装 | ✅ **会激活**，工具真正出现 |
| `web/` 子目录 | ✅ 能装 | ✅ 会激活 |
| `watch/` 子目录 | ✅ 能装 | ✅ 会激活（但要先拷到 `$DSH_HOME/dsh-go/plugins/`）|

所以正确的装法是：

```bash
dsh plugin --profile web add ./screen      # 后台屏，必需
dsh plugin --profile web add ./web         # 浏览器控制，可选
```

**为什么仓库根装了不激活**：根的 `package.json` 里 `dsh.bundle.patch` 指到 `./screen/cordis.patch.yml`，
但 `dsh plugin add` 只把它当 pnpm 依赖写进 `package.json`，patch 不会被应用。
根 package.json 存在的意义是「让扫描工具认得出这是个 DSH 插件仓库」，不是安装入口。

> 装完必须**重启引擎**。MCP 工具是引擎启动时加载的，不重启看不到。

---

## 四、快速开始

### 4.0 三分钟判断：这台机器能不能用

只有一条是硬门槛 —— **`com.android.shell` 有没有 `ADD_TRUSTED_DISPLAY`**。
一部分机型有（本机 nubia NX809J / Android 16 有），Pixel 和部分 Android 15 没有（scrcpy issue #5523）。

```bash
# 返回 1 = 能用；返回 0 = 这条路在这台机器上走不通，别往下装了
adb -s 127.0.0.1:5555 shell 'dumpsys package com.android.shell | grep -c "ADD_TRUSTED_DISPLAY: granted=true"'
```

### 4.1 前置检查（四条命令，每条都有预期输出）

```bash
# ① adb 客户端在不在
apt-get update && apt-get install -y android-tools-adb ffmpeg python3-pip
adb version
# 预期：Android Debug Bridge version 1.0.41 或更高

# ② 连上手机（回环；关 WiFi、开飞行模式都不影响）
adb connect 127.0.0.1:5555
adb -s 127.0.0.1:5555 shell echo ok
# 预期：ok

# ③ 建屏权限（唯一的硬门槛）
adb -s 127.0.0.1:5555 shell 'dumpsys package com.android.shell | grep -c "ADD_TRUSTED_DISPLAY: granted=true"'
# 预期：1

# ④ 取帧权限（决定能不能用 15ms 的快路径）
adb -s 127.0.0.1:5555 shell dumpsys package com.android.shell \
  | grep -E "CAPTURE_VIDEO_OUTPUT|READ_FRAME_BUFFER|ACCESS_SURFACE_FLINGER"
# 预期：三行都是 granted=true
```

3D 游戏才需要的额外一条：

```bash
adb -s 127.0.0.1:5555 shell getprop vendor.display.vds_allow_hwc
# 1 = 硬件支持 HWC，插件会自动开；0 或空 = 3D 游戏会黑屏
```

> **连不上 adb 怎么办**：回环 5555 不是 adbd 的默认监听端口，第一次必须先配对。完整流程：
>
> ```bash
> # 手机端先做（这两步只能人来点）：
> #   设置 → 关于手机 → 连点「版本号」7 次，打开开发者选项
> #   开发者选项 → 无线调试 → 打开 → 「使用配对码配对设备」，记下配对端口和 6 位码
>
> adb pair 192.168.1.100:37123      # 换成手机上显示的 IP:配对端口，然后输 6 位码
> adb connect 192.168.1.100:41000   # 换成无线调试主页显示的 IP:端口（和配对端口不是同一个）
> adb tcpip 5555                    # 把 adbd 切到固定端口
> adb connect 127.0.0.1:5555        # 之后只用这条回环连接
> adb -s 127.0.0.1:5555 shell echo ok
> ```
>
> 配对成功后**回环连接关 WiFi、开飞行模式都不受影响**；手机重启后要重做一次 `adb tcpip 5555`。
> 更细的排障见 [dsh-go-plugin-adb](https://github.com/JMINN0/dsh-go-plugin-adb)。
> **注意**：`adb tcpip 5555` 会重启 adbd，正在用 adb 的其他工具（包括 Shizuku 的连接）会断**一次**。
> 已经配好回环的设备**不要重复执行**。

### 4.2 克隆与依赖

```bash
cd /root/workspace
git clone https://github.com/JMINN0/dsh-go-second-screen.git
cd dsh-go-second-screen

# Node（插件跑在 Node 里）
node --version          # 需要 ^22.19 或 >=24

# Python 依赖（两个都是「增强能力」，不装也能用，只是对应工具会明确报错）
pip install rapidocr-onnxruntime        # OCR，模型 15MB，vdisplay_text/find 要用
pip install opencv-python-headless      # 视觉，模板匹配/颜色/指纹/差分要用
```

### 4.3 装插件（三种形态，选一个）

**形态 A：只装后台屏（最省事，推荐第一次装）**

```bash
cd /root/workspace/dsh-go-second-screen
dsh plugin --profile web add ./screen
```

**形态 B：后台屏 + 浏览器 CDP**

```bash
cd /root/workspace/dsh-go-second-screen
dsh plugin --profile web add ./screen
dsh plugin --profile web add ./web
```

**形态 C：一个条目装全部**（`screen` + `web` + `adb` + 原生胶囊/面板）

```bash
# 这个组合包的依赖用 link: 指向两个路径，所以两个仓库要并排放
cd /root/workspace
git clone https://github.com/JMINN0/dsh-go-plugin-adb.git
cd dsh-go-second-screen
dsh plugin --profile web add ./plugin
```

> **形态 C 的安装位置有要求**：`plugin/package.json` 里写的是
> `link:../../dsh-go-plugin-adb`、`link:../screen`、`link:../web`。
> 所以它**必须**在仓库内执行，且 `dsh-go-plugin-adb` 要克隆在仓库的**同级目录**。
> 少一个，pnpm 会找不到依赖而失败。**【推断】** 依据是 `plugin/package.json` 里的依赖写法，
> 我没有在干净环境里复现过失败。

**原生插件（胶囊 + 「AI 画面」面板）**：形态 A/B 需要单独装，形态 C 已包含。

```bash
mkdir -p "$HOME/.dsh/dsh-go/plugins"
cp -r /root/workspace/dsh-go-second-screen/watch "$HOME/.dsh/dsh-go/plugins/local-screen-watch"
dsh plugin --profile web add "$HOME/.dsh/dsh-go/plugins/local-screen-watch"
```

> **原生插件和 Cordis 插件的区别**：`package.json` 里有 `dshGo` 字段的就是原生插件（画 App 界面），
> **必须先复制到 `$DSH_HOME/dsh-go/plugins/` 再 add**；只有 `dsh` 字段的是 Cordis 插件（注册工具），
> 直接 add 目录。**装错了不报错**，只是胶囊不出现（原生没加载）或 AI 说没有 `vdisplay_*` 工具。

`dsh plugin add` 除了装包，还会自动把包名写进 `dsh.profile.bundles`（`plugin-manager` 的 reconcile 逻辑），
所以装完不需要手改 `package.json`。

### 4.4 装完必须重启引擎

App 内：**设置 → 引擎 → 重启引擎**。不重启，新工具不会出现。

### 4.5 验证

```bash
# ① 包进 profile 了吗（如果设了 DSH_HOME，把 $HOME/.dsh 换成它）
python3 -c "
import json
d = json.load(open('$HOME/.dsh/profiles/web/package.json'))
b = d['dsh']['profile']['bundles']
for n in ['dsh-go-plugin-screen', 'dsh-go-plugin-web', 'local-screen-watch', 'dsh-go-plugin-mobile']:
    print(n, ':', n in b)"
# 预期：装了的那个 True，其余 False

# ② 引擎加载有没有报错
grep -i "apply failed" "$HOME/.dsh/dsh-app/diagnostics.md" 2>/dev/null \
  | grep -E "screen|watch|mobile" || echo "没有加载错误 ✅"
# 预期：没有加载错误 ✅
```

然后在对话里说一句「用 `vdisplay_status` 看看虚拟屏状态」：能返回状态就是装好了。
输入框上方应该出现一条「AI 未操作」的胶囊。

**不装 DSH 也能用**（Claude Code、opencode、Codex、Cursor，只要能跑 bash）：

```bash
cd /root/workspace/dsh-go-second-screen
node screen/bin/vdisplay.mjs start            # → displayId=81 之类
node screen/bin/vdisplay.mjs launch com.tencent.mm
node screen/bin/vdisplay.mjs shot --out /tmp/wx.jpg
node screen/bin/vdisplay.mjs input tap --nx 0.5 --ny 0.9
node screen/bin/vdisplay.mjs stop
```

装到 PATH 之后可以省掉 `node screen/bin/`：`npm link ./screen`（会装 `vdisplay` 到全局，**【推断】** 按
`package.json` 的 `bin` 字段应该可行，我没在本机验证过），或者用别名：

```bash
alias vdisplay="node /root/workspace/dsh-go-second-screen/screen/bin/vdisplay.mjs"
```

**给别的 agent 宿主（MCP）**：

```json
{
  "mcpServers": {
    "background-screen": {
      "command": "node",
      "args": ["/root/workspace/dsh-go-second-screen/screen/bin/mcp-server.mjs"]
    }
  }
}
```

### 4.6 卸载

```bash
# 1. 停掉常驻进程与屏
node /root/workspace/dsh-go-second-screen/screen/bin/vdisplay.mjs daemon stop   # CLI 形态
#   （插件形态会随引擎停止自动释放；也可以直接调用 vdisplay_stop 工具）

# 2. 卸载插件（按装的时候的包名）
dsh plugin --profile web remove dsh-go-plugin-screen
dsh plugin --profile web remove dsh-go-plugin-web
dsh plugin --profile web remove dsh-go-plugin-mobile
dsh plugin --profile web remove local-screen-watch

# 3. 删原生插件目录
rm -rf "$HOME/.dsh/dsh-go/plugins/local-screen-watch"

# 4. 清掉推到手机上的临时文件（可选）
adb -s 127.0.0.1:5555 shell "rm -rf /data/local/tmp/dshvd /data/local/tmp/dshframe"

# 5. 卸掉悬浮窗 APK（可选）
adb -s 127.0.0.1:5555 uninstall com.dsh.overlay
```

卸载后重启引擎。**不会留下的东西**：没有 root 改动、没有系统设置改动
（唯一的 `debug.sf.enable_hwc_vds` 在 `vdisplay_stop` 时已还原，且重启也会自动复原）。

---

## 五、能做什么 / 不能做什么

### 5.1 已经做到（全部真机实测）

| 能力 | 实测证据 |
|---|---|
| 操作 3D 游戏，而且是**连续控制** | Minecraft 从建世界到进游戏全程 5 步命中；60Hz 虚拟摇杆驱动角色走路。受控对比：静置 1.5 秒画面差异 **0.64**，摇杆 2.5 秒后 **11.69**（**18 倍**）。游戏内 47–60fps。【实测·报告】记录在提交说明里；`tests/MC-OPERATION-TEST.md` 是 11-17 的中间状态，里面「走路」还标着未测，以提交记录为准 |
| 视频画面能抓，而且有更省的办法 | 三次实测：scrcpy 流 411 帧/12 秒 = **34.3fps**；`screencap -d` ≈7fps；ImageReader **67–76fps**。但绕开它更简单 —— App 缓存的视频是标准 MP4，直接 pull 出来 ffmpeg 读（`bin/vidgrab.mjs`）：`hevc 1280×720 + aac，29.98 秒`，抽帧 + 抽音频，**只读、秒级** |
| 网页登录、填表、点按钮 | 走 CDP，读 DOM 而不是看截图；React/Vue 能收到逐字符按键事件 |
| 双屏并存 | 两块虚拟屏同时跑不同 App，各有独立推流与悬浮窗（`screen_pool` / `screen_new` / `screen_use`） |
| 读界面不花图片 token | `vdisplay_text` 返回带 `nx/ny` 的文字行，**0 图片 token**（约 1 秒）；点击、等画面稳定、选区域也都是 0 token。一个完整任务只花 **169** 图片 token（只有最后那张局部图） |
| 你的主屏不受影响 | 虚拟屏上跑计算器时，主屏继续放视频，输入法焦点留在主屏（`mDisplayIdToShowIme=0`），主屏截图里没有任何浮窗 |

### 5.2 做不到（不是 bug）

摘要，完整 **25 条**见 **[LIMITS.md](LIMITS.md)**（按「为什么做不到」分 A–E 五类，每条带证据来源）。

| 做不到 | 原因 | 证据等级 |
|---|---|---|
| 消掉 `adb_enabled = 1` 这个特征 | 整套工具依赖 adb；甚至 `init.svc.adbd`、`ADB_WIFI_ENABLED`、端口探测都能读到 | 【实测】自写探针 App，普通 App 身份零权限就读到 `1` |
| 改掉虚拟屏的名字 `scrcpy` | scrcpy-server 5.0.1 没有改名参数；`uniqueId` 里还带 `com.android.shell,2000` | 【实测】从 dex 提字符串 |
| 截 `FLAG_SECURE` 窗口 | 系统级保护，截图 API 返回全黑。银行、支付、部分 DRM 视频 | 【推断】本仓库没做专门靶场 |
| 造出真实触摸屏的 `deviceId` / `size` / `history` | `adb input` 挑设备，scrcpy 控制通道写死 0；报文里没有 size 字段 | 【实测·源码】 |
| 让 `getCoalescedEvents()` 大于 1 | CDP 和 adb input 两条路都造不出合并采样 | 【实测】六个靶场都报这一条 |
| 让传感器相关性成立 | 注入触摸不产生真实 sensor 事件 | 【推断】没有实测记录 |
| 关掉 ADB 还保留这块屏 | 见 3.2：剩下两条路一条只能镜像、一条要 OEM 授权 | 【实测·源码】 |
| 浏览器在后台时建不了新标签 | Android 系统限制。插件**不会偷偷开窗**，会返回 `needsUserConfirm` 让你决定 | 【实测】 |
| 两个 Chromium 浏览器不能同时用 | 它们抢同一个 `chrome_devtools_remote` socket（Edge / Chrome / 红魔浏览器三选一） | 【实测】 |
| 虚拟屏上软键盘不弹 | `display_ime_policy=hide`，**这是故意的** —— 为的是不抢你的输入法 | 【实测】 |
| 虚拟屏随进程消亡 | 设计如此，不留垃圾。代价是必须有一个常驻进程握着它（见 3.3） | 【实测】 |
| 读不到别人 App 的 `/data/data` | SELinux 限制（没有 root） | 【实测】 |

### 5.3 现在没做，但技术上能做

`LIMITS.md` D 类，**别当成「做不到」**：结构化 UI 树（无障碍）、自己写 display host、
自己写注入器（补齐 deviceId + size + history，**性价比最高的未做项**）、
MediaProjection 替代 screencap、多 AI broker 完整版、跨进程租约。

> 其中「MCP server」一条已经过期：`screen/bin/mcp-server.mjs` 已经实现了
> （11 个工具，手写 JSON-RPC，零依赖）。**我说的「已实现」是【实测·源码】；
> 它在真实宿主（Claude Desktop / Cursor）里跑通过的记录，仓库里没有 → 【不知道】。**

---

## 六、工具清单

一共 **49 个工具**：`screen` 包 39 个（后台屏 + 视觉 + 多屏 + 租约），`web` 包 10 个（浏览器）。

> 子目录里的 `screen/README.md` 还写着「八个工具」，`web/README.md` 写着「工具数 8」——
> 都是早期版本的数字，**以本表为准**（按 `tool-spec.js` 实际注册的 name 数出来）。

### 6.1 选择与安全（4）

| 工具 | 一句话 |
|---|---|
| `screen_modes` | 列出四种操作方式（shell / browser / vdisplay / watch）和各自代价，帮你选 |
| `screen_risk` | 查目标 App 的风控等级（L0 无风控 … L4 银行支付），决定能用什么手段 |
| `screen_user_state` | 查「用户现在在用手机吗」（前台是 DSH Go 或输入法挂起 → BUSY）。**动主屏前先调它** |
| `vdisplay_choose_method` | 量一下当前界面，告诉你该用模板匹配 / 颜色 / OCR 哪一种（按界面指纹缓存） |

### 6.2 屏的生命周期（5）

| 工具 | 一句话 |
|---|---|
| `vdisplay_start` | 建一块私有虚拟屏，返回 displayId 与能力标志；支持 `orientation` / `hwc` |
| `vdisplay_status` | 屏在不在跑、displayId、上面跑着什么、主屏焦点是什么 |
| `vdisplay_stop` | 销毁屏并释放 OCR/OpenCV 常驻助手（不关会留孤儿进程） |
| `screen_keepalive` | 设定「AI 停下多久后自动关屏」，1–360 分钟（默认 5） |
| `screen_shot_main` | 截主屏（只读），用来核对有没有影响用户 |

### 6.3 投 App 与输入（2）

| 工具 | 一句话 |
|---|---|
| `vdisplay_launch` | 把 App 投到虚拟屏。**先 force-stop**（否则旧任务被拉前台会顶掉用户），投完只报告主屏焦点变化、不自动还原 |
| `vdisplay_input` | 往虚拟屏注入 tap / swipe / hold / multitouch / text / key / paste。`verify:true` 时画面没变返回 `ok:false` |

`vdisplay_input` 的坐标写法（**这是最容易写错的地方**，写错不报错、只是点不到）：

| kind | 参数 | 说明 |
|---|---|---|
| `tap` / `hold` | `nx` `ny`（0–1，最稳）或 `x` `y` | `x/y` 按「上一次截图里的像素」理解，会自动换算 |
| `swipe` | `nx1` `ny1` `nx2` `ny2` 或 `x1` `y1` `x2` `y2` | **起点终点都要给**，只给起点会被当成 0 |
| `multitouch` | `p1` + `p2` + 可选 `p2To`（各含 `nx`/`ny`） | 双指：一根按住 + 一根滑动 |
| `text` / `paste` / `key` | `text` / `key` | 中文用 `paste` |

### 6.4 看画面（6）

| 工具 | 一句话 |
|---|---|
| `vdisplay_shot` | 截虚拟屏，返回本地路径；`frames` 九格连拍、`region` 局部放大、`width` 控制清晰度 |
| `vdisplay_live` | 常驻视频流解码器的启停与状态（画面静止时收不到帧，这是正常的） |
| `vdisplay_live_shot` | 从视频流取最新一帧（比截图快，前提是画面在动） |
| `vdisplay_roi` | 自动挑一块值得看的区域，返回 `region` 给 `vdisplay_shot`（同样 token 花在更小面积上 = 更清晰） |
| `vdisplay_probe` | 量边缘密度 / 颜色集中度 / 对比，判断这个界面适合哪种识别方式 |
| `vdisplay_probe_secure` | 黑屏探针：判断画面抓不到是不是 `FLAG_SECURE`（无 root 的硬边界） |

### 6.5 读文字（3）

| 工具 | 一句话 |
|---|---|
| `vdisplay_text` | OCR 读屏，返回文字 + 像素坐标 + `nx/ny` + 置信度。**0 图片 token** |
| `vdisplay_find` | 只找文字，返回坐标不点击；支持 contains / exact / regex，找不到会给相近词建议 |
| `vdisplay_tap_text` | 找到文字并点击。**比让模型自己看 OCR 坐标再算准得多**（那个环节是 17.6% 点空率的主因） |

### 6.6 找图与颜色（4）

| 工具 | 一句话 |
|---|---|
| `vdisplay_find_image` | 模板匹配找图案（图标、开关、准星这类没有文字的东西），实测 5–30ms |
| `vdisplay_tap_image` | 模板匹配 + 点击，一步完成 |
| `vdisplay_find_color` | 按颜色找色块（血条、按钮底色、选中边框）；用 Lab 的 a/b 通道，抗色温漂移 |
| `vdisplay_tap_color` | 按颜色找到最大色块并点击 |

### 6.7 判断「画面有没有变」（4）

| 工具 | 一句话 |
|---|---|
| `vdisplay_fingerprint` | 界面的 64 位指纹（7ms），比截图便宜、比 OCR 可靠；两次调用给汉明距离 |
| `vdisplay_diff` | 和上一张比差异，返回 `mad` 与 `maxCell`（小区域变化看 `maxCell`，全局 `mad` 会被背景稀释） |
| `vdisplay_wait_stable` | 等画面稳定（32×32 灰度判据，实测 121–182ms），替代固定 sleep |
| `vdisplay_wait_for` | 等某个条件成立（文字出现/消失、指纹变化、差异超阈值、出现某颜色）。**省时间最多的一个** |

### 6.8 推流给用户看（2）

| 工具 | 一句话 |
|---|---|
| `vdisplay_stream` | 把画面以 1–15fps（默认 2）JPEG 推给胶囊/悬浮窗，实测约 0.30 核、29KB/s |
| `vdisplay_stream_stop` | 停止推流 |

### 6.9 多屏池（5）

| 工具 | 一句话 |
|---|---|
| `screen_pool` | 池里有几块屏、哪块是活动屏 |
| `screen_new` | 新建一块屏，返回 `screenId`（每块屏 75–185MB 内存，实测两块很轻松） |
| `screen_use` | 切活动屏，之后所有 `vdisplay_*` 作用在它上面 |
| `screen_close` | 销毁一块屏 |
| `vdisplay_apps` | 列第三方 App 的包名（投屏前查，省得猜包名） |

### 6.10 App 占用与租约（4）

| 工具 | 一句话 |
|---|---|
| `screen_check_app` | 这个 App 现在被谁占着：FREE / USER_BG / **USER_ACTIVE（绝对不能碰）** / AI_HELD / FOREIGN |
| `screen_claim_app` | 申请占用。**默认 `fail`，不自动抢**；`preempt` 才能接管。登录/支付传 `preemptible:false` |
| `screen_release_app` | 释放占用 |
| `screen_leases` | 看所有占用凭证（谁占着什么、还剩多久、能不能抢） |

### 6.11 浏览器 CDP（`web` 包，10 个）

| 工具 | 一句话 |
|---|---|
| `web_browser` | 查看或切换目标浏览器（Edge / Chrome / 红魔浏览器，默认 Edge） |
| `web_ensure` | 检查并修复 CDP 通道；**默认不启动浏览器** |
| `web_open` | 打开标签页（只开自己的），返回 `targetId` |
| `web_attach` | 接管用户已经开着的标签（**不导航、不刷新**，保住登录态） |
| `web_tabs` | 列出所有标签，标明是你自己的还是插件开的 |
| `web_read` | 读页面文字（读 DOM，不花图片 token） |
| `web_click` | 按 CSS 选择器或可见文字点击；走触摸事件，自动滚到可见 |
| `web_fill` | 填表单（逐字符 `dispatchKeyEvent`，含 Shift 配对；React/Vue 能收到） |
| `web_shot` | 截图 |
| `web_close` | 只关自己开的标签；关用户的标签要 `confirm:true` |

---

## 七、常见用法示例

### 7.1 在后台读一个 App 的界面并点某一行文字

```
1. vdisplay_start {}                                    → displayId=81
2. vdisplay_launch { pkg: "com.android.settings" }
3. vdisplay_text { maxLines: 10 }
   → [1.00] 设置 / [0.99] WLAN nx=0.128 ny=0.700 / [1.00] 蓝牙 nx=0.118 ny=0.857 …
4. vdisplay_tap_text { text: "WLAN" }                   → 进 WLAN 页（不自己算坐标）
5. vdisplay_stop {}
```

实测过的一步：打开设置 → OCR 找到「WLAN」在 (0.128, 0.700) → 点击 → 再 OCR 到标题栏
「WLAN」和「要查看可用网络，请打开WLAN」。**你的主屏全程没动。**

### 7.2 一边看视频一边让 AI 干活（验证不抢屏）

```
1. vdisplay_start {}                       → 主屏继续放 B 站
2. vdisplay_launch { pkg: "com.xingin.xhs" }  → 小红书投到后台屏
3. vdisplay_text {}                         → 读笔记标题和评论
4. vdisplay_input { kind: "swipe", nx1: 0.5, ny1: 0.8, nx2: 0.5, ny2: 0.2 }
```

实测：主屏的播放没断，输入法焦点留在主屏（`mDisplayIdToShowIme=0`），
主屏截图里找不到任何浮窗。

### 7.3 两块屏跑两个 App（多任务）

```
1. screen_new { orientation: "portrait" }    → sd-1
2. screen_new { orientation: "landscape" }   → sd-2
3. screen_use { screenId: "sd-1" }; vdisplay_launch { pkg: "com.tencent.mm" }
4. screen_use { screenId: "sd-2" }; vdisplay_launch { pkg: "com.android.settings" }
5. screen_pool {}                             → 两块都在，各有自己的推流
6. screen_close { screenId: "sd-2" }
```

**注意**：同一个 `singleTask` 类的 App **不能**同时在两块屏上跑 ——
实测 `am start --display` 会把主屏的旧任务 reparent 到虚拟屏，**主屏那个就没了**。
所以架构上把「屏」当唯一互斥资源，而不是把「App」当资源并行。

### 7.4 网页登录 + 填表（不点屏幕，比截图快几十倍）

```
1. web_ensure {}                                       → 通道就绪
2. web_open { url: "https://example.com/login" }       → targetId: "ABC123"
3. web_read { targetId: "ABC123" }                     → 页面文字
4. web_fill { targetId: "ABC123", selector: "#user", text: "xxx" }
5. web_fill { targetId: "ABC123", selector: "#pass", text: "xxx" }
6. web_click { targetId: "ABC123", text: "登录" }
7. web_close {}
```

**登录用已经开着的标签**：先 `web_tabs` 找到那个标签，再 `web_attach`，不要 `web_open` 重开一个 ——
重开会丢登录态，还要再走一次验证码。

### 7.5 长任务挂机（自己管生命周期）

```
1. screen_keepalive { minutes: 120 }        ← 先按任务估：挂机 2 小时
2. vdisplay_start {}
3. vdisplay_launch { pkg: "com.tencent.mm" }
4. … 循环：vdisplay_text → 判断 → vdisplay_tap_text → vdisplay_wait_for { until: "fingerprint_changes" }
5. vdisplay_stop {}
```

判据是「AI 连续 N 分钟没有调用任何工具」。**任何工具调用都会重置计时**，
所以只要还在操作就不会被关；真闲着才关。不设的话默认 5 分钟。

### 7.6 游戏里的连续控制（按住不放，不是点一下）

```
1. vdisplay_start { orientation: "landscape", hwc: "on" }
2. vdisplay_launch { pkg: "com.mojang.minecraftpe" }
3. vdisplay_input { kind: "hold", nx: 0.10, ny: 0.72, ms: 2500, driftY: -60 }
```

`hold` 是 60Hz 连续 MOVE + 轻微抖动 + 缓慢漂移（真人按不会绝对静止）。
实测 500ms 的 hold 发 32 帧、其中 30 帧是 60Hz 的 MOVE。
**这和市面上「看一眼 → 点一下 → 再看」的离散循环（2 秒一步）是两回事。**

### 7.7 让另一个 agent 宿主用这块屏

```bash
# 任何能跑 bash 的 agent
node /root/workspace/dsh-go-second-screen/screen/bin/vdisplay.mjs --json status
```

或者按 4.5 的 MCP 配置接到 Claude Desktop / Cursor 里。**它不依赖 DSH。**

---

## 八、架构图

### 8.1 两块屏的资源隔离

```
┌ Display 0（物理屏） ───────┐  ┌ 后台屏 VirtualDisplay ─────┐
│ 你正在用的 App             │  │ AI 投上去的 App            │
│ 微信 / B站 / 游戏          │  │ 小红书 / 设置 / MC         │
│                            │  │                            │
│ 自己的窗口栈               │  │ 自己的窗口栈               │
│ 焦点 ← 你的输入框          │  │ 焦点 ← AI 的注入事件       │
│ 输入法 ← 你打字            │  │ 输入法：不弹（hide）       │
└────────────────────────────┘  └────────────────────────────┘
   ▲ 焦点、输入法、图层都留在这边 ▲ 没有 FLAG_PUBLIC，不画到任何物理面板上
   │ 你看得见、摸得着             │ AI 用 adb / 插件工具操作它
   你（人手）                     AI（Agent）
```

### 8.2 进程与数据链路

```
DSH 引擎（Node，跑在 proot 的 Ubuntu 里）
├── screen 插件（39 个工具）
│   ├── vd.js         建屏 / 注入 / 截图 / 页面探测
│   ├── pool.js       多屏池 + dpi 金丝雀（靠 dpi 320+i 分辨哪块屏是哪块）
│   ├── lease.js      占用租约（五级占用 + 抢占 + 默认不抢）
│   ├── ocr.js    ─┐
│   ├── vision.js ─┴──> python3 常驻助手（OCR 15MB / OpenCV 80-150MB）
│   ├── framesrv.js ─┐
│   └── stream.js   ─┴──> 取帧与推流的管理层
└── web 插件（10 个工具）
    └── adb forward tcp:<随机端口> ──> 浏览器 DevTools socket（CDP over WebSocket）

            │ adb shell（uid 2000）
            ▼

手机侧（uid 2000，无 root）
├── /data/local/tmp/dshvd/scrcpy-server.jar
│   └── new_display ──> VirtualDisplay（AI 那块屏，没有 FLAG_PUBLIC）
└── /data/local/tmp/dshframe/frame.dex（app_process）
    ├── ImageReader ← 镜像上面那块 VirtualDisplay
    └── 自己当 HTTP server :38820  →  /frame.jpg  /status  /stream.mjpg

            │ HTTP（悬浮窗直连它，链路里没有 Node 中转）
            ▼

用户能看到的两个入口
├── 悬浮窗 APK（com.dsh.overlay，24KB，插件自动装）
│   TYPE_APPLICATION_OVERLAY + FLAG_NOT_FOCUSABLE → 浮在任何 App 上但不抢焦点
│   落点画水滴波纹（900ms 扩散淡出），能看出点没点偏
└── 原生插件 watch（Cordis 之外的那一半）
    输入框上方胶囊「AI 未操作」+ 点开的「AI 画面」面板
```

### 8.3 一次点击的完整往返

```
AI 调 vdisplay_input { kind: "tap", nx: 0.5, ny: 0.9 }
  │
  ├─ 确认屏还活着（dumpsys display + SurfaceFlinger --display-id）
  ├─ 刷新真实尺寸（转屏后初始声明值会点出屏外）
  ├─ 动作前取一次画面哈希
  ├─ 走 scrcpy 控制通道注入（DOWN + 1–3 MOVE + UP，带压力、60–150ms 随机间隔）
  ├─ 等落定（settleMs，默认 500ms）
  ├─ 动作后再取一次哈希 → 没变就返回 ok:false（不假装成功）
  └─ 顺手把落点发给 framesrv 的 /mark → 悬浮窗画一个波纹
```

---

## 九、性能实测数据

设备：nubia REDMAGIC NX809J / Android 16 / 无 root / 虚拟屏 1592×720。
**「测量方法」这一列是给你判断可信度用的，别只看数字。**

### 9.1 取帧

| 指标 | 数字 | 怎么测的 | 等级 |
|---|---|---|---|
| `screencap -d <SFID>` 单帧 | **143ms**（≈7fps） | 单帧循环计时 | 【实测】 |
| screencap 全流程 | **227–243ms**（2.5fps） | 141ms 回读 + 98ms PNG + 71ms 传输 | 【实测】 |
| ImageReader 镜像，静态屏 | 4 秒 **1 帧** | 事件驱动，不变化不出帧 | 【实测】 |
| ImageReader 镜像，动态内容 | **269 帧 / 4 秒 = 67fps，15ms/帧** | 131 行探针程序（`tests/IMAGEREADER-PROBE.md`） | 【实测】 |
| framesrv 常驻服务 | **76fps**（单次采样，服务自报）；滚动 App 时 **159 帧 / 4.8 秒 = 33fps** | `/status` 的 frames 与 fps | 【实测·报告】 |
| MJPEG 输出（悬浮窗） | **179 帧 / 4 秒**（均值 44.8fps），帧间隔**中位 17ms**，p90 33ms | 4 秒计时 + 帧计数（commit `2aa1ea0`） | 【实测】 |
| scrcpy H.264 视频流 | **411 帧 / 12 秒 = 34.3fps** | 视频流帧计数 | 【实测】 |
| 悬浮窗解码上限 | 1 窗口 30fps；2–3 窗口 15fps；4+ 窗口 8fps | 代码常量 | 【实测·源码】 |
| 推流（`vdisplay_stream`） | 2fps / 360 宽，约 **0.30 核、29KB/s** | top + 抓包 | 【实测】 |

> **关于「114fps」**：这个数字出现在仓库的 `llms.txt` 里（写着「53-114fps」），**但没有任何一次测量支持它**。
> 能查到的是：① 17ms 的帧间隔中位（就是上表那行，对应瞬时 59fps、4 秒均值 44.8fps）；
> ② `53.7fps` —— 那是「没客户端时也在编码」那段时间的编码速率，是审计出来的**浪费**，不是交付帧率；
> ③ `119fps` —— 那是**一个 bug 的读数**：虚拟屏已经死了、framesrv 还在对一片空白疯狂编码。
> 写文档、做容量规划时不要用 114fps。`llms.txt` 里的那一行**已于 2026-11-20 改正**。
>
> **上表里带「4 秒」「179 帧」「17ms」这些数的原始输出，全部照抄在 [tests/MEASUREMENTS-2026-11-20.md](tests/MEASUREMENTS-2026-11-20.md)**，包括测量脚本和当时的命令。

### 9.2 感知与操作

| 指标 | 数字 | 怎么测的 | 等级 |
|---|---|---|---|
| OCR（暖机，1592×720、11 行） | **961ms 中位** | 3 次取中位，先预热（`tests/OCR-TUNING-MEASURED.md`） | 【实测】 |
| OCR（首次 / 进程刚起） | **3–5 秒** | 加载 15MB 模型，常驻后只发生一次 | 【实测】 |
| OCR 调优效果 | `det_limit_side_len` 736→320，**提速 2.5 倍**，质量几乎不变 | 同上 | 【实测】 |
| 关 `use_cls` | 只快 3%（不是估算的 20–30%） | 三组对照 | 【实测】 |
| 模板匹配 / 颜色 / 指纹 / 差分 | **5.7ms / 6.8ms / 7ms / 2.3ms** | OpenCV 常驻助手（`import cv2` 冷启 328ms，所以必须常驻） | 【实测】 |
| 等画面稳定 | **121–182ms** | 32×32 灰度判据 | 【实测】 |
| 注入本身 | **<10ms**（socket 往返 <1ms） | 打点 | 【实测·报告】 |
| **工具层一次 `vdisplay_input`** | **约 2 秒** | 其中 5 次 adb shell 往返（`dumpsys display` 最重）+ 固定 500ms 落定 | 【实测·报告】 |
| 一轮「截图 → 模型看图 → 点击」 | 中位 **19.4 秒** | 旧记录，仓库里没留测量脚本。**这已是旧路径**：现在用 `vdisplay_text` + `vdisplay_tap_text`，模型不用看图也不用算坐标 | 【实测·报告】 |
| 游戏内帧率 | **47–60fps** | 游戏内显示 + logcat | 【实测】 |

### 9.3 资源开销

| 指标 | 数字 | 怎么测的 | 等级 |
|---|---|---|---|
| 虚拟屏空转 | 基线 0.52 → **0.80 秒/秒 = 多占 0.28 核** | `/proc` 累计 CPU 时间 | 【实测】 |
| 对照：`overlay_display_devices` | SurfaceFlinger **43.7% → 68~80%**，约 **5.5W**，而且会压屏、吃触摸、抢输入法 | 同上 | 【实测·报告】 |
| 悬浮窗开着时的 framesrv | **10.3% CPU**（MJPEG 长连接挂着，它就一直编码） | top（2026-11-19） | 【实测】 |
| 每块虚拟屏内存 | **75–185MB**（取决于上面跑的 App 有多重） | `dumpsys meminfo` | 【实测·报告】 |
| ImageReader buffer | **4.37MB/块**（1592×720×4），2 块 8.7MB（Gralloc，不占 Java heap） | 算出来的 | 【实测】 |
| OpenCV 常驻 | **80–150MB** | RSS | 【实测·报告】 |
| OCR 常驻 | 模型 **15MB** | RSS | 【实测·报告】 |

### 9.4 token 成本（AI 侧）

| 步骤 | 成本 |
|---|---|
| `vdisplay_text` 读界面（30 行带坐标） | **0 图片 token**（约 1 秒） |
| 点击（`vdisplay_tap_text`） | **0** |
| 等画面稳定 | **0** |
| 自动选区域（`vdisplay_roi`） | **0** |
| 截一张局部图 544² | **169** |

前面全部免费，只有最后那张图花钱，而且是 1:1 像素。
**一个完整任务（读界面 → 找到 → 点击 → 验证）只花 169 图片 token。**

> 对比：一张全屏截图约 **1.1k tokens**，而且会永久留在上下文里 —— 长任务会吃满。

---

## 十、已知问题与排查

### 10.1 还没修完的问题

| 问题 | 现状 | 影响 |
|---|---|---|
| **打字只对部分 App 有效** | `input text` 在系统设置、标准输入框能用；京东这类自绘输入框注不进去 | 用 `kind: "paste"`（走剪贴板 + `KEYCODE_PASTE`），实测能粘进 `abc中文测试abc` |
| **深链不可靠** | 小红书那次 2 次全被系统拦（`SecurityException: not exported`） | 深链只能碰运气，优先走正常启动 |
| **坐标点击会静默失败** | 已加动作后画面校验（没变返回 `ok:false`） | **「17.6% 点空率」这个数字已作废**：唯一能查到的推导是 `vd.js` 里「15 张抽样有 5 张与上一张逐像素相同」= **约 33%**，不是 17.6%；而 `tests/CLICK-VERIFICATION.md` 的结论是「点击一直有效，失败来自验证信号本身」。修完之后的白点率 **【不知道】**，没有重测。`vdisplay_tap_text` 消掉了这一步。**修完之后的白点率是多少 →【不知道】，没有再测过** |
| **验证信号会骗人** | 用「画面没变」判失败有三个坑：画面本来就在动（视频/秒表）→ 永远 true；屏进 doze → 永远 false；displayId 不匹配时 scrcpy 服务端**静默丢弃** | 看返回值，不要盲目重试同一坐标（重试会制造连点特征） |
| **多屏并行被一把全局锁串行化** | 调度层并行，执行层串行（`input/shot/launch/text` 排同一条 mutex） | 「3 个 AI 同时操作 3 个 App 提速 3 倍」现在做不到 |
| **OCR 缓存只有单槽** | A/B 界面交替时命中率归零 | 交替场景每次都重新识别 |
| **只在一台机器验证** | nubia NX809J / Android 16 | 其他机型、其他 Android 版本都没测 |
| **3D 游戏依赖 HWC** | `vds_allow_hwc=0` 的机器仍黑屏；**本机（`=1`）2026-11-20 复测 Minecraft 主菜单完整渲染**，证据见 [tests/MEASUREMENTS-2026-11-20.md](tests/MEASUREMENTS-2026-11-20.md) M8 | 先按 4.1 最后一条查 |
| **framesrv 不自愈** | 进程死了帧就没了，还没做自动重启（看门狗能防它一直烧电，但不能把它救活） | 重开一次推流 |
| **息屏就断** | 虚拟屏依赖设备保持唤醒；息屏后要人脸/指纹/密码解锁，AI 无法自动恢复 | 正常的点击/滑动会自动重置息屏计时器，任务在跑就不会息屏 |
| **虚拟屏名字固定 `scrcpy`** | `uniqueId` 里还带 `com.android.shell,2000`；普通 App 的 `getDisplays()` 默认看不到（没有 `FLAG_PUBLIC`），但 `getDisplays(DISPLAY_CATEGORY_PRESENTATION)` **能看到**【推断】 | 见 [LIMITS.md](LIMITS.md) A-02 |
| **同一 `singleTask` App 不能双开** | 强行 `am start --display` 会把主屏任务搬走（破坏性） | 多屏时换不同 App |
| **文档之间互相矛盾** | ① `LIMITS.md` A-02 列这块屏的 flags 时**没有** `FLAG_OWN_CONTENT_ONLY` / `FLAG_OWN_FOCUS`，而 `screen/src/vd.js` 与 `screen/README.md` 说这两个是判据 —— 两处描述的可能是不同的 flags 集合，**我没核对 AOSP 源码，所以是【推断】**；② `llms.txt` 写「取帧 53-114fps」，见 9.1 的说明；③ `screen/README.md` 说「八个工具」、`web/README.md` 说「工具数 8」，实际是 39 和 10 | 读数之前先看本节和 9.1 |

### 10.2 排查手册

```bash
# 建屏失败：先看是不是权限
adb -s 127.0.0.1:5555 shell 'dumpsys package com.android.shell | grep -c "ADD_TRUSTED_DISPLAY: granted=true"'
# 0 → 这台机器走不通（scrcpy issue #5523），别浪费时间

# 屏起来了但画面全黑
adb -s 127.0.0.1:5555 shell getprop vendor.display.vds_allow_hwc     # 3D 游戏要看这个
# 或者先试 vdisplay_probe_secure —— 是不是 FLAG_SECURE

# 截图截到了主屏（不是虚拟屏）
# → screencap -d 要的是 SurfaceFlinger 的 64 位 id，不是逻辑 displayId
adb -s 127.0.0.1:5555 shell 'dumpsys SurfaceFlinger --display-id'

# 点击没反应
# ① 不要用 grep mCurrentFocus 判断虚拟屏能不能点（那是默认 display 的焦点）
adb -s 127.0.0.1:5555 shell 'dumpsys window displays | grep -A3 "Display: mDisplayId=<你的id>"'
# ② 看工具返回的 ok/changed；③ 试 vdisplay_tap_text 而不是给坐标

# 虚拟屏凭空消失
# → 建它的进程退了。插件形态挂在引擎上，引擎重启屏就没了；CLI 形态看 daemon 还在不在
node /root/workspace/dsh-go-second-screen/screen/bin/vdisplay.mjs daemon

# 中文打不进去
# → 用 kind:"paste"（写剪贴板 + KEYCODE_PASTE）。input text 对中文必抛 NPE

# 引擎加载失败
grep -i "apply failed" "$HOME/.dsh/dsh-app/diagnostics.md"
```

**屏/推流的资源泄漏**（都修过，但要知道有这回事）：
用一次 `vdisplay_text` / `vdisplay_find_image` 之后，OCR（15MB 模型）和 OpenCV（80–150MB）
会一直挂着 —— 现在 `vdisplay_stop` 和插件卸载都会显式关掉。
`vdisplay_stream` 曾经无条件起两条取帧路径，多烧 0.31 核，现在只在快路径失败时才回退。

### 10.3 已经修好的（留档，免得下一个人重新踩）

| 曾经的坑 | 现在 |
|---|---|
| **每次命令行调用都重建屏** —— 每个 node 进程自己建屏，进程一退屏就没了 | `vdisplayd` 常驻守护进程握着屏，CLI 通过回环 HTTP 发命令（闲置 10 分钟自动退出） |
| 推流没客户端时也在编码 —— 53.7fps × 约 19MB/帧 ≈ 1.04GB/s，一直烧 1.0 核 | framesrv 加了看门狗：15 秒没人取帧暂停编码，120 秒彻底退出 |
| 虚拟屏死了 framesrv 还在对空白编码（119fps），悬浮窗显示冻结的旧画面 | 改用 `DisplayManagerGlobal.getDisplayInfo()`，返回 null 就自己退 |
| 悬浮窗最小化后画面不刷新 | `showJpeg` 里那个 `!collapsed` 判断是反的，已去掉（实测连续三帧差异 10.10 / 13.78，是活的） |
| 拖着窗口往右下角一放就把屏删了 | 改成两步：拖进左下角停靠区停靠，再把旋钮滑过 82% 才删 |
| 多指手势发不出去（服务端把 pointer index 截断） | 改发 0/1/2，`Inconsistent=0`（反编译 scrcpy 才看出来是编码问题） |
| MJPEG 解析器把找 header 的逻辑写错，悬浮窗收不到帧 | 已修 |
| `web_fill` 用 `Input.insertText` —— 只往 DOM 塞文字，不产生 keydown/keyup | 改成逐字符 `dispatchKeyEvent`（含 Shift 配对） |
| README 说过六句「做不到」，其中四句是错的 | 逐条改掉，见第十四节的「我自己推翻过的记录」 |

---

## 十·五、2026-11-20 这一轮修了什么

这一轮全部是**实际使用中撞出来的问题**，不是计划内的功能：

| 问题 | 根因 | 修法 | 验证 |
|---|---|---|---|
| **悬浮窗显示冻结画面** | `framesrv` 镜像的源虚拟屏死了，但它的存活检测走 `IDisplayManager` 反射，失败时返回「活着」保底 → 继续以 119fps 编码一片死画面 | 改用 `DisplayManagerGlobal.getDisplayInfo()`，返回 null 就是屏真没了，直接退出 | 悬浮窗帧与源屏平均像素差 3.1（同一画面） |
| **关一块屏把所有窗口都关了** | `screenPorts` 这个 Map 只有 `get`/`delete`，**从没 `set` 过** → `stop()` 取到 0 → `overlayStop(undefined)` → `--ez stop true` 关全部 | 快慢两条路径都记下 `displayId → port` | 代码审查发现，单测覆盖 |
| **最小化后画面不更新** | `showJpeg` 里写了 `if (... && !collapsed && ...)` —— 收起时跳过刷新 | 去掉 `!collapsed`，收起仍解码 | 最小化状态下连抓 3 次，差异 10.10 / 13.78 |
| **最小化还是太大** | 窗口是 `FrameLayout`，装机后改尺寸但**工具栏/标签/手柄没隐藏**，按钮比 36dp 还宽把窗口撑住 | 收起时三个子控件全 `GONE` | 653×1443 → 117×208 |
| **多窗口重叠** | `applyAspect()` 只在**比例变化**时重算尺寸，不看 `wins.size()` → 第 1 个窗按「独占」定成 668×1478，后面加窗它不缩 | 加 `reflowAll()`，窗口数变化时强制所有未被用户调过尺寸的窗重算 | 两窗同为 177×391，x=20 / x=228 不重叠 |
| **窗口能被拖出屏幕** | clamp 只保证留 72dp，实测跑到 x=-227 完全不可达 | 改为至少一半可见 | — |
| **轻触缩放手柄就缩到最小** | `max(dp(80), startW + 0)`，而 `dp(80)` 在 3.42 密度下 = 260px，正好是下限 | 加 10dp 移动阈值，下限提到 `dp(120)` | — |
| **拖拽删除太容易误触** | 滑轨跟着窗口位置走，拖到右下角就删 | 改两段式：先拖到左下停靠区 → 吸附到滑块 → 再往右滑过 82% 才删 | 停在停靠区不删 |
| **MJPEG 延迟大** | ① 采集线程里同步写 socket，客户端慢就堵住整条链路；② 两边都没设 `TCP_NODELAY`，每帧三次写被 Nagle 攒包 | 写操作移到独立线程（只保留最新帧，旧的丢弃）+ 两边 `setTcpNoDelay(true)` | 改后用 Node 裸 socket 连 `/stream.mjpg` 计 4 秒：**179 帧 = 均值 44.8fps**，帧间隔**中位 17ms**、p90 33ms（见 §9.1）。**没有 114fps 这回事**，理由见 §9.1 的说明 |
| **看不到 AI 点了哪里** | 原来画的是十字准星，在深色背景上看不清 | 改成**水滴波纹**：红色实心点 + 白描边 + 3 圈扩散圆环，900ms 淡出；静止画面时由动画线程连推 16 帧 | 中心区红色像素 2406→2677 递增 |
| **重复 `am start` 起两个 overlay 进程** | `MainActivity` 没有 `launchMode` | 加 `singleTask` + 实现 `onNewIntent`（否则 `--ez stop` 会被静默丢弃） | 进程数恒为 1 |

## 十一、和现有方案对比

| 维度 | 无障碍服务 | 投屏镜像（scrcpy 默认） | Appium / UI Automator | **本项目（后台屏）** |
|---|---|---|---|---|
| **占用户屏幕** | 是（App 必须在前台） | 是（镜像的就是主屏） | 是 | **否** |
| **抢焦点** | 是 | 是 | 是 | **否**（`FLAG_OWN_FOCUS`） |
| **抢输入法** | 是 | 是 | 是 | **否**（虚拟屏 `display_ime_policy=hide`） |
| **人和 AI 能同时用** | 不能 | 不能，而且你看得见它在乱点 | 不能 | **能** |
| **需要 root** | 不需要，但要用户手动开无障碍 | 不需要 | 不需要 | **不需要** |
| **要装 APK / 授权** | 要装 App + 开无障碍常驻 | 通常不需要 | 要装 Appium server / 开 `UiAutomation` | 不需要（悬浮窗 APK 由插件自动装） |
| **怎么读界面** | 无障碍树（结构化，最快） | 像素 | 控件树 | OCR + OpenCV（约 1 秒）**或** 无障碍树（**未验证能不能读虚拟屏**） |
| **单步延迟** | 50–100ms（树读得快） | 143ms/帧 | 树读得快，注入慢 | 读约 1s；注入 <10ms，但工具层约 2s（5 次 dumpsys 往返） |
| **能操作哪些 App** | 绝大多数（自绘控件可能缺节点） | 任意 | 主要是自己的 App / 调试版 | **任意**（包括 3D 游戏，需 HWC） |
| **风控可检测的特征** | 无障碍开启状态（`enabled_accessibility_services` 可读） | 录屏/镜像本身 | 调试连接、`UiAutomation` | `adb_enabled=1`、虚拟屏（`dumpsys display` 可见）、注入的 `deviceId` |
| **多 AI 并发** | 不能（一块屏） | 不能 | 串行 | **能**（多屏池 + 租约。但租约是**协作式**的：`claim` 会拒绝第二个申请，`vdisplay_*` 工具本身**不校验**租约 —— 见 §10.1） |
| **适合干什么** | 需要结构化节点的常规自动化 | 人工远程操作、演示 | 自家 App 的**自动化测试** | AI Agent 在后台跑第三方 App、挂机、多任务 |

**几个必须说清楚的地方**：

1. **无障碍树比我们快两个数量级**（实测 phonedriver 类工具读 1000 行只要 12.7ms，我们 OCR 约 1 秒）。
   我们不用它，不是因为快慢，是因为它解决不了**资源争用** —— 树读得再快，App 还得在你屏幕前台。
   而且「无障碍树能不能读虚拟屏」这一条，**我们测了但结论是【不知道】**
   （`tests/ACCESSIBILITY-VS-VIRTUAL-DISPLAY.md`：初测读不到，复核发现那次测试只能证明
   「我们那个读屏工具读的是主屏活动窗口」，没有排除另外三种解释）。
2. **官方后台屏的实测对照**：同一台手机、同一时刻，官方的后台屏在一个满是文字的设置页上
   **读到 0 个元素**，一次操作后卡进错误状态；我们的 `vdisplay_text` 读到 9 行带坐标的文字。
   但官方的**治理模型**（确认卡、应用名单、授权时效）比我们完善，那是我们该补的。
3. **Appium 在「自动化测试」这个用途上更成熟**：它有完整的断言、报告、CI 集成。
   我们是给 AI Agent 用的运行时，不是测试框架。

---

## 十二、常见问题（FAQ）

**1. 为什么不用无障碍（AccessibilityService）？它读界面快 100 倍。**
因为它不解决争用：无障碍的树和手势都作用于**当前活动窗口**，App 必须在你的屏幕上前台。
你要让 AI 操作微信，就得让开屏幕。而且我们实测过一次，结论是【不知道】——
无障碍树能不能读到虚拟屏上的 App，没验证成功（见第十一节的说明）。
如果以后验证能读，那会是「感知提速 20–30 倍」的最大单点收益。

**2. 会被风控发现吗？**
分场景，说准确一点：
- **纯网页 + 行为风控**：网页读不到 `Settings.Global`，平台隔离，**ADB 开着基本无关**。
  我们在六个本地靶场做过测量：网络层 0 暴露（**但只测了 HTTP 头，TLS/JA3 测不了**）、
  行为层网页路径全过（**但「100/100」的分母是 7 项不是 25 项**，样本不足的检查被跳过）、
  环境层 6/100 暴露。
- **普通 App + 商业风控 SDK**：ADB 是**低危加权，不是否决**（腾讯云把开发者模式列为低危）。
- **银行 / 支付**：**硬条件，会被拒**。越南 Circular 77/2025 点名 ADB 必须自动退出。
- **微信 / 支付宝**：公开证据只到 root/hook/模拟器/多开层面，**专门查 `adb_enabled` 没有公开证据 →【不知道】**。

**重点**：`adb_enabled=1`、`init.svc.adbd`、`ADB_WIFI_ENABLED` 这些**用这套工具就消不掉**。
真实风控的权重我们也看不到。**自建靶场通过 ≠ 真实风控通过。** 详见 [LIMITS.md](LIMITS.md)。

**3. 耗电吗？**
虚拟屏空转 +0.28 核（基线 0.52 → 0.80 秒/秒）；推流 2fps 再加约 0.02 核（合计约 0.30 核）。
对照：`overlay_display_devices` 那条路是 SurfaceFlinger 43.7%→68~80%、约 5.5W，我们便宜一个数量级。
**真正的问题是「忘了关」**：实测悬浮窗连着 MJPEG 时 framesrv 会一直占 10.3% CPU。
所以加了空闲看门狗（AI 不调工具就自动放掉屏和推流，默认 5 分钟，可用 `screen_keepalive` 调）。

**4. 能开几块屏？**
实测两块很轻松（各有独立推流和悬浮窗）。每块 75–185MB 内存，4–6 块要看你手机上跑的 App 有多重。
**但同一个 `singleTask` 的 App 不能同时在两块屏上跑**，强行做会把主屏任务搬走。
另外执行层有一把全局锁，多屏目前是「调度并行、执行串行」。

**5. 怎么卸载？**
见 4.6：`vdisplay daemon stop` → `dsh plugin --profile web remove <包名>` →
删 `$HOME/.dsh/dsh-go/plugins/local-screen-watch` → （可选）清 `/data/local/tmp/dshvd`、
`/data/local/tmp/dshframe`、卸 `com.dsh.overlay`。卸载后重启引擎。没有 root 改动、没有系统设置残留。

**6. 需要 root 吗？**
不需要。整条链路借的是 `uid 2000`（shell）本来就有的签名权限。也正因为如此，
读不到别人 App 的 `/data/data`（SELinux），也不需要改系统分区、不 hook 任何进程。

**7. 为什么一定要 ADB？没有 ADB 行不行？**
不行，而且是权限模型决定的，不是工程量问题：
`MediaProjection.createVirtualDisplay()` 建出来的只是**镜像接收端**（接不了 App），
能托管 App 的可信虚拟屏需要 `ADD_TRUSTED_DISPLAY`，
系统里唯一完整的替代 `android.companion.virtual` 需要 OEM 才能授的 role。
**没有 ADB 就没有这块屏。**

**8. 我的手机能用吗？**
看一条：`com.android.shell` 有没有 `ADD_TRUSTED_DISPLAY`。
本机（nubia NX809J / Android 16）有；Pixel 和部分 Android 15 没有。
另外 3D 游戏还要看 `vendor.display.vds_allow_hwc`。命令在 4.1。

**9. 能跑 3D 游戏吗？**
能，前提是让硬件合成器参与（`hwc: "auto"` 会自动判断）。Minecraft 实测 47–60fps、
用 60Hz 摇杆连续控制走路。**厂商不支持 HWC 的机器仍然黑屏**。
早期版本把这条写成「虚拟屏跑不了 3D 游戏」，那是**只测了默认配置**得出的错结论，已修正。

**10. 能一边操作一边让我看吗？**
能。`vdisplay_stream` 推 1–15fps（默认 2）给悬浮窗或胶囊，悬浮窗是 `FLAG_NOT_FOCUSABLE` 的，
**浮在别的 App 上但不抢焦点，你还能继续打字**。点击位置会画一个水滴波纹（900ms 扩散淡出），
你能看出它点在哪、有没有点偏。

**11. 会抢我的键盘 / 输入法吗？**
虚拟屏上不弹输入法（`display_ime_policy=hide`），焦点永远留在主屏。
这是明确的设计目标，也是最容易踩坏的地方 —— 相关事故和解法记在
[OPERATION-PRIORITY.md](OPERATION-PRIORITY.md) 与 `tools/user-busy.sh`（动前台前先问「用户在用吗」）。

**12. 支持中文输入吗？**
支持，但不要用 `input text`（对中文必抛 Java NPE）。用 `vdisplay_input { kind: "paste", text: "…" }`：
写剪贴板 + `KEYCODE_PASTE`，实测能粘进 `abc中文测试abc`。
自绘输入框（京东那类）注不进去，`paste` 是这类场景的首选。

**13. 息屏 / 锁屏后还能跑吗？**
不能。虚拟屏依赖设备保持唤醒，息屏后会断电、displayId 失效，而且解锁要人脸/指纹/密码，AI 恢复不了。
正常的点击/滑动会自动重置息屏计时器，所以**只要任务在持续执行就不会息屏**。

**14. 和 DSH 自带的「后台屏」（`mcp__phone__*` 的 `background:true`）有什么不同？**
那是另一套实现，实测对照过（同一台手机、同一时刻）：它在文字很多的设置页上**读到 0 个元素**、
点击无法执行，一次操作后卡进「后台屏树连接清理未确认」的错误状态。
我们这套读到 9 行带坐标的文字。但它的治理模型（确认卡、名单、授权时效）比我们完善。

**15. 能拿来做自动化测试吗？**
技术上可以（有 CLI、有 MCP、有 JSON 输出），但**它不是测试框架**：
没有断言库、没有报告、没有 CI 集成。Appium 在「自动化测试」这个用途上更成熟。
我们的定位是「AI 在后台操作真实 App」的运行时。

**16. 有 iOS 版 / 电脑版吗？**
没有。这套东西完全建立在 Android 的 `VirtualDisplay` + `scrcpy-server` + `adb` 上。
不过**驱动方可以跑在电脑上**：CLI 和 MCP 两条路都是纯协议，你的 AI Agent 跑在 PC 上
（computer use / 电脑使用 那类产品）也能用它操控手机。

**17. 会改我的系统设置吗？**
只有一处：3D 游戏需要 `debug.sf.enable_hwc_vds=1`，且只在 `vds_allow_hwc=1` 的设备上、
由 `vdisplay_start` 临时打开、`vdisplay_stop` 还原。它是 `debug.*` 属性，重启也会自动复原。
**不会**改动你的屏幕方向/自动旋转、不会改 ADB 开关、不会改无障碍设置。

**18. 多个 AI 能同时用吗？**
能，但不是「无限并行」。已经实现：多屏池（每块屏一个 `screenId`）、
五级占用检测（`FREE` / `USER_BG` / `USER_ACTIVE` / `AI_HELD` / `FOREIGN`）、
租约与抢占（**默认不抢**）、单个 App 的独占与冲突处理。
**没实现**：跨进程租约共享（每进程各自记账）、完整 broker（优先级老化、wait-for 图、WAL）。
设计在 [BROKER-DESIGN.md](BROKER-DESIGN.md)（代码未实现那部分是设计，不是现状）。

---

## 十三、这个仓库里三个包，各管一段

| 包 | 类型 | 干什么 | 装在哪 |
|---|---|---|---|
| `screen/` | Cordis 插件 | 建看不见的虚拟屏、投 App、点击、截图、视觉识别、推流（**39 个工具**） | profile（给引擎注册工具） |
| `web/` | Cordis 插件 | 用 CDP 操作浏览器：读 DOM、点元素、填表单、截图（**10 个工具**） | profile（同上） |
| `watch/` | dsh-go 原生插件 | 输入框上方的胶囊 + 点开的「AI 画面」面板 | `$DSH_HOME/dsh-go/plugins/`（画 App 界面） |
| `plugin/` | Cordis 插件（组合） | 把 `screen` + `web` + `adb` + `watch` 合成**一个**条目 | profile |

**为什么 `watch/` 不能和 `screen/` 合并**：App 只认原生插件来画界面，引擎只认 Cordis 插件来注册工具。
想实现「AI 在后台干活 + 你能看到」，必须两个都装（`plugin/` 就是这么把它们拼起来的）。

**为什么都在一个仓库**：`screen/` 和 `web/` 以前各自单独开过仓库，结果是代码漂移了 74 行 ——
虚拟屏能跑 3D 游戏的那个修复只进了一边。合并后一处改一处生效。

**名字的由来**：项目叫「后台屏」，因为实质是「一块用户看不见的屏」，
不是「把手机屏幕一分为二的第二块屏幕」。仓库名 `dsh-go-second-screen` 和包名
`dsh-go-plugin-screen` **故意没改** —— 已安装的插件是软链接，改包名会让现有安装全部失效。

**配套的 adb 插件**（`dsh-go-plugin-adb`，单独仓库）：`screen/` 需要一个能连上的 adb。
它**不硬依赖** adb 插件 —— 没有的话回退到 `127.0.0.1:5555`；装了的话会自动跟着 adb 插件的端口迁移走。
两者不合并的原因是依赖单向：adb 插件的其他使用者不需要虚拟屏这一套。

---

## 十四、文档地图

**如果你是 AI，动手前先读这两份：**

| 文档 | 内容 | 什么时候读 |
|---|---|---|
| [docs/OPERATION-PLAYBOOK.md](docs/OPERATION-PLAYBOOK.md) | 拿到一个操作目标，10 秒内判断「能不能做、用什么做、什么时候必须停」。六级风控分类、十二种操作手段、决策树、四个必须停的硬条件、拟人化参数、反面案例库 | **每次操作前** |
| [OPERATION-PRIORITY.md](OPERATION-PRIORITY.md) | 按「对用户的打扰成本」排的四级优先级：后台+命令 → 后台+注入 → 前台+命令 → 前台+注入。以及抢了前台怎么还原 | 要动前台之前 |
| [LIMITS.md](LIMITS.md) | **做不到什么**，**25 条**（A-01…E-03），按原因分 A–E 五类，每条带证据来源 | 想放弃某个方案之前 |
| [llms.txt](llms.txt) | 一页速览，给把文档塞进上下文用的 AI 宿主 | 上下文不够时 |
| [AGENTS.md](AGENTS.md) | 给编码助手读的短版说明（Codex / Cursor / Claude Code 会原生读这个名字）。**其中有两处已经过时**：① 它说 `SET_CLIPBOARD`+`KEYCODE_PASTE` 打不进中文 —— 实测能打进（见 10.1 的「打字只对部分 App 有效」与 FAQ 12）；② 里面的工具名写成 `mcp__phone__vdisplay_start`，实际是 `vdisplay_start` | 用编码助手接这个仓库时 |
| [tools/fetch-sdk.sh](tools/fetch-sdk.sh) | 下载编译依赖（`android-30.jar` 等 37MB，不在 git 里）。只有要从源码重编 APK/dex 时才需要 | 要改悬浮窗或取帧服务时 |
| [tests/](tests/) | 1500+ 行实测记录，含我判断错了、后来自己推翻的地方 | 想知道某个数字怎么来的 |
| [tests/risk-sim/FULL-REPORT.md](tests/risk-sim/FULL-REPORT.md) | 六个本地靶场的完整实测 | 关心风控之前 |
| [BROKER-DESIGN.md](BROKER-DESIGN.md) | 多 AI 多屏的架构设计（**代码未实现那部分是设计**） | 要做多 Agent 之前 |
| [framesrv/README.md](framesrv/README.md) · [overlay/README.md](overlay/README.md) | 取帧服务与悬浮窗的实现细节 | 要改这两块时 |

**几处我自己推翻过的记录**（留着当反例）：

- 一开始说「视频已经最优」→ 错，有个 60fps 的流被丢掉了
- 说「定时驱动不刷新」→ 错，GIF 素材太短，采样时它早播完了
- 说「MC 的 GL 坏了」→ 错，是**手机锁屏了**
- 说「虚拟屏跑不了 3D 游戏」→ 错，只测了默认配置（开 HWC 就能跑）
- 说「无障碍读不到虚拟屏」→ 降级成【不知道】，那次测试没有排除其他解释
- 在 README 写「`adb tcpip` 绑回环是优势」→ 错，那会踢掉 Shizuku 的连接
- 本 README 早先写的两个数字已作废：`114fps`（不存在）和「工具数 8」（实际 39）

---

## 十五、许可

**本仓库自己的代码是 MIT**（见 [LICENSE](LICENSE)）。商业使用、修改、再分发都允许，
保留版权声明即可。作者不承担任何责任。

**但 `screen/assets/scrcpy-server.jar` 不是我们的代码** —— 它是
[scrcpy](https://github.com/Genymobile/scrcpy) 的 server 端，以 **Apache-2.0** 分发。
所以这个仓库实际是 **MIT + Apache-2.0**，两部分各按自己的条款：

- 我们的代码 → MIT
- `scrcpy-server.jar` → Apache-2.0，全文见 [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0)

再分发时**两个许可的副本都要带上**。完整说明、上游归属、以及「怎么自己从源码构建这个 jar
来确认没被改过」，见 [THIRD-PARTY.md](THIRD-PARTY.md)。

---

## 证据等级约定

本文每个技术判断都标了等级，含义和 [LIMITS.md](LIMITS.md) 一致：

| 标记 | 含义 |
|---|---|
| 【实测】 | 在这台机器上跑出来的，有命令和输出 |
| 【实测·源码】 | 读了 Android / scrcpy 源码确认的行为 |
| 【实测·报告】 | 仓库里有记录，但不可在仓库内直接复现 |
| 【推断】 | 有机制依据但没实测 |
| 【不知道】 | 查不到，别当结论用 |

**最后更新**：2026-11-20。设备：红魔 NX809J / Android 16 / 无 root。
版本、价格、权限这类会变的事实，按这个日期判断是否过期。
