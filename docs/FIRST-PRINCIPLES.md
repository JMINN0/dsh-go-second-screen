# 安卓后台屏 · 第一性原理白皮书

> 这份文档回答三个问题：**为什么必须这样做**、**怎么做到的（别人照着能复现）**、**做不到什么**。
>
> 它不是功能清单。功能清单在 `README.md` 第六节。这里写的是每个设计决定背后的物理约束 ——
> 以及不遵守这些约束时，具体会坏成什么样。

---

## 0. 怎么读这份文档

### 0.1 证据标记

全文只用四种标记，和 `LIMITS.md` 的约定一致：

| 标记 | 含义 |
|---|---|
| **【实测】** | 本仓库的 `tests/` 或 `README.md` 里有原始命令和输出，可以按出处重跑 |
| **【实测·源码】** | 我读了仓库源码（或仓库里记录的字节码 / AOSP 证据）确认的实现事实 |
| **【推断】** | 有机制依据，但仓库里没有实测记录。**不要当结论用** |
| **【不知道】** | 查不到。缺什么我会写清楚 |

一句话规则：**能重跑的叫实测，读代码读出来的叫实测·源码，其余都不算。**

### 0.2 这份文档的核对基准

写文档期间，仓库里有两个源码文件正在被同时修改，所以基准必须钉死：

| 文件 | 我读到的版本 | md5 / 行数 |
|---|---|---|
| `screen/src/tool-spec.js` | 2026-11-20 21:42:00 | `6c5693c8839156c03bf5db0e05ab7184` / 862 行 |
| `screen/src/vd.js` | 2026-11-20 21:42:35 | `bfa51d575295db9bfbb727f7d2f177ef` / 2236 行 |
| `web/src/tool-spec.js` | 2026-11-15 22:40:38 | 196 行 / 10 个工具 |
| `framesrv/.../Main.java` | 2026-11-20 20:06:19 | 772 行 |
| `LIMITS.md` | 2026-11-19 18:45 | 477 行 / 25 条 |

**注意**：`screen/src/tool-spec.js` 在我开始读之后（21:42）被改过一次 —— 其中「17.6% 点空率」
这个数字被改成了「这个比例没有可靠测量，别引用具体数字」，同时 `README.md:877` 也把它标成**已作废**。
所以本文**不引用 17.6%**，正文里所有工具描述以 21:42 那一版为准。

### 0.3 先说结论

**这套方法不是我们的专利。** 它用的是 Android 显示子系统本来就有的能力（多 display、
每 display 独立窗口栈与输入路由），入口是 `DisplayManager.createVirtualDisplay`，
身份是 `adb shell` 本来就有的 uid 2000。任何一个能跑 adb 的 AI，只读源码就能自己复现
（§4.6 有一份外部复现记录，连同它的证据边界）。

所以本文的重点不是「我们做了什么」，而是「为什么绕不开这条路、绕开之后会怎样」。

---

## 一、为什么需要它：问题的本质

### 1.1 屏幕是独占资源，而且它一次绑定了三个"只有一个"

先把现象还原成约束。一块 Android 手机屏（`Display 0`）在系统语义里同时是：

```
只有一个前台窗口   → 谁在前台，谁可见；别人全在后台
只有一个输入焦点   → 焦点在哪，按键和触摸就去哪
只有一个输入法(IME) → 焦点一换，输入法的 InputConnection 就被 detach
```

这三条不是习惯，是 `WindowManagerService` 里按 display 建立的模型：一个 display 对应
一个 `DisplayContent`，里面一个 focused window、一个 IME target。

**推论的直接来源**：只要两个主体（人、AI）都要求在 display 0 上获得「前台 + 焦点 + IME」，
它们就在争同一组独占量。这不是调度算法能解决的问题 —— 独占量的意思是**同一时刻只能有一个持有者**。

**不这样做的代价，我们已经踩过实机事故**：`am start` / 打开链接会让新窗口成为焦点，
IME 的 `InputConnection` 从用户的输入框上 detach —— 用户正在拼的半截字丢了，键盘被抢走
（2026-11-17 的真实事故，之后才写进 `AGENTS.md` 成为强制前置检查）。
更糟的是同一条路上 `input text` 会把文字**拼进用户的草稿**，`input keyevent 66` 可能把草稿**发出去**。

所以"资源争用"在这里不是抽象的并发问题，它的具体形态是：**丢数据、断播放、跳前台、坐标错位。**

### 1.2 现有方案各自的物理约束

五种主流做法，逐个说清它被什么卡住。**注意：前四种卡在同一件事上，第五种卡在另一件事上。**

| 方案 | 它怎么操作 | 躲不开的物理约束 |
|---|---|---|
| **无障碍服务**（AccessibilityService） | 读无障碍树拿控件；`dispatchGesture` 注入手势 | 树和手势的作用域是**当前活动窗口**。`getRootInActiveWindow()` 只在 display 0 有焦点时返回你要的界面；要让 AI 操作微信，微信就必须在前台 → 用户让开。且需用户手动开无障碍、常驻服务 |
| **scrcpy 主屏镜像** | 把 display 0 的画面编码推出去，点击回灌 display 0 | 它镜像的就是**用户的屏**。AI 点一下，用户手机上真的会动；用户滑一下，AI 的坐标系就错了（内容位移）。双向干扰，无法靠参数调掉 |
| **Appium / UI Automator** | `UiAutomation` 读控件树 + 注入事件 | 同上，作用域是默认 display。本机另有一个具体故障：`uiautomator dump` 因 `UiAutomationService` 被占用直接崩溃【实测·报告：`LIMITS.md` D-01】 |
| **云手机 / 模拟器** | 在数据中心跑一台安卓，AI 操作那台 | 卡的不是屏，是**身份**：那不是用户的设备。没有用户的账号态、已装 App、设备指纹、本地文件。它解决的是"有台安卓可用"，不是"操作这台安卓" |
| **hook / 注入 / Xposed** | 改目标进程行为 | 需要 root 或重打包；且这几类在商业风控里是**高危**信号（比 ADB 更致命）【有依据：`LIMITS.md` 引用腾讯云推荐等级】 |

**共同点**：前四种都在优化"怎么操作得更顺"，没有解决"两个主体要同一块屏"。
第五种换掉了实现手段，但引入了更重的可检测特征。

### 1.3 把问题重写：能不能不消除争用，而消除对同一资源的依赖？

第一性原理的转折点在这里。原来的问题是：

> 怎么让人和 AI **轮流**用同一块屏而不互相打断？

这个问题没有好答案，因为它的前提是"只有一块屏"。改成：

> 人和 AI 各自需要一块**逻辑屏**。系统能不能同时存在两块？

于是争用问题变成资源供给问题。资源供给问题有解 —— 前提是平台支持多 display。

**这不是绕开限制，是用平台的设计目标。** Android 本来就要支持 HDMI、无线投屏、车机副屏、
可折叠设备的多显示组。多 display 是它必须支持的能力，不是漏洞。

于是得到唯一形状正确的答案：

```
给 AI 建一块 VirtualDisplay ——
  物理上存在（合成器真的在合成它）
  用户看不见（虚拟屏没有物理输出设备接；不带 FLAG_PUBLIC 所以也枚举不到）
  焦点独立（FLAG_OWN_FOCUS）
  输入法不进来（display_ime_policy=hide）
```

代价是：新资源有它自己的约束（不能托管所有 App、生命周期绑进程、取帧要另做一条路）。
**下面第二、五节全部在讲这些代价。** 一份只讲"你得到了什么"的文档在这里就开始骗人了。

### 1.4 Android 显示子系统提供的原语

为什么"多块逻辑屏并存"在原理上成立，逐层拆：

| 原语 | 它负责什么 | 为什么允许多份 |
|---|---|---|
| `DisplayManager` / `DisplayManagerGlobal` | 逻辑显示屏注册表：每块屏有 `DisplayInfo`（逻辑 id、尺寸、dpi、rotation、状态） | 一个进程内可以查多块屏；`getDisplayIds()` 返回的是**集合** |
| `SurfaceFlinger` | 合成器。每块 display 一个 layer stack | 合成单位是 display，不是"整机一张画布" |
| `DisplayDevice` | 输出设备（物理面板 / 虚拟输出） | 物理面板只是输出设备的一种 |
| `VirtualDisplay` | 由进程创建、输出到创建者给的 `Surface` 或内部 buffer | 设计如此；`release()` 或进程死亡即销毁 |
| `DisplayContent`（WMS 内部） | 每块屏一个：自己的窗口栈、自己的 focused window、自己的 IME target | 焦点是**每 display** 的属性，不是全局属性 |
| `InputDispatcher` 路由 | 注入事件带目标 displayId；每 display 有自己的 input channel 集合 | 事件投递按 display 分流 |
| display group | 一组 display 共享某些策略（IME、焦点行为）。`FLAG_OWN_DISPLAY_GROUP` 让这块屏独立成组 | 组是可切的，所以 IME 可以不跟默认屏共享 |
| `Presentation` / `FLAG_PRESENTATION` | 给"副屏"用的展示标志 | 副屏本来就是被支持的场景 |
| `DisplayManager.createVirtualDisplay(@hide, 带 displayIdToMirror + Surface)` | 把某块屏**镜像**进你给的 Surface | 需要 `CAPTURE_VIDEO_OUTPUT` —— 这条是取帧的路，不是建屏的路 |

**关键区别（很多人在这里就搞混了）**：

- **建一块能跑 App 的屏** → 需要 `ADD_TRUSTED_DISPLAY`（签名级）→ 靠 uid 2000 拿到
- **把一块已有的屏镜像进 ImageReader** → 需要 `CAPTURE_VIDEO_OUTPUT`（签名级）→ 也靠 uid 2000

这两件事用的不是同一个权限，也不是同一个 API。§2.1 建屏，§2.3 取帧。

---

## 二、怎么做到的：机制，写到能复现

### 2.1 建屏：`app_process` 跑 scrcpy-server 的 `new_display`

#### 2.1.1 为什么必须是 `app_process`（两个独立的事实，不是一个）

这里经常被说成一句"因为 app_process 有权限"，不准确。它是两件事：

**事实一：`app_process` 是 ART 的启动器，让你不装 APK 就能跑 dex。**
`/system/bin/app_process` 起一个 ART 运行时，加载 `CLASSPATH` 指向的 jar/dex，执行你指定的
`main`。这样不需要安装、不需要签名、不占包名，进程也不是 zygote fork 出来的应用进程。
【实测·源码：`vd.js:574` 的启动命令，`framesrv` 用同一条路】

**事实二：权限来自 uid 2000（`com.android.shell`），不是来自 `app_process`。**
`ADD_TRUSTED_DISPLAY` 是签名级权限，普通 App 拿不到。但 adbd 起的 shell 就是 uid 2000，
而 uid 2000 对应的 `com.android.shell` 在系统里被授予了这一批权限：

```bash
$ adb -s 127.0.0.1:5555 shell 'dumpsys package com.android.shell | grep -c "ADD_TRUSTED_DISPLAY: granted=true"'
1
```

【实测：`README.md:127-129`；同一份输出 `vd.js:532` 用作启动前置检查】

准确的因果链是：**要以 uid 2000 跑 → 要跑现成的 dex 而不装 APK → 只剩 `app_process` 这个入口。**
不是"app_process 给了权限"，是"进程没有降权"。

**顺带否掉一个常见误解**：`app_process` 画不了悬浮窗。`WindowManagerService.openSession()`
建 `Session` 时要求调用进程在 ActivityManager 的进程表里，`app_process` 不在 →
`IllegalStateException: Unknown pid=19074 uid=2000`【实测：`tests/NO-APK-OVERLAY-PROBE.md`】。
这不是权限问题（shell 本来就有 `SYSTEM_ALERT_WINDOW: granted=true`），是**进程身份**问题。
所以面向用户的预览必须另做 APK（§2.5）。

#### 2.1.2 完整命令（可复制）

插件里实际跑的是这条【实测·源码：`vd.js:574-591`，参数顺序即原样】：

```bash
# 一次准备
adb connect 127.0.0.1:5555
adb push screen/assets/scrcpy-server.jar /data/local/tmp/dshvd/
adb shell 'chmod 444 /data/local/tmp/dshvd/scrcpy-server.jar'

# 每次建屏：SCID 必须是「有符号 32 位内的正整数」的十六进制
#   用 0xffffffff 随机会得到 cd7bccd6 这种超范围值 → server NumberFormatException 直接退
SCID=1a2b3c4d
PORT=28123

adb forward tcp:$PORT localabstract:scrcpy_$SCID     # 名字带下划线，见下

adb shell "CLASSPATH=/data/local/tmp/dshvd/scrcpy-server.jar app_process / \
  com.genymobile.scrcpy.Server 5.0.1 \
  log_level=info tunnel_forward=true \
  display_ime_policy=hide \
  vd_system_decorations=false \
  new_display=720x1600/320 \
  max_fps=60 control=true audio=false scid=$SCID"
```

逐个参数说清为什么必须在：

| 参数 | 不加会怎样 | 证据 |
|---|---|---|
| `tunnel_forward=true` | server 反向连客户端，adb forward 的方向就不对了；这套是「客户端连 server」 | 【实测·源码】 |
| `new_display=WxH/DPI` | 不传就退化成镜像主屏，**所有前提失效** | 【实测·源码】 |
| `display_ime_policy=hide` | 虚拟屏上的输入框会把系统 IME 焦点抢过去（`mDisplayIdToShowIme` 变成虚拟屏 id），**用户在主屏打字时键盘就没了**。代价：虚拟屏上也不弹输入法 | 【实测·`vd.js:580-582`】 |
| `vd_system_decorations=false` | 虚拟屏上自带二级桌面 launcher、导航栏、权限弹窗，AI 截图把这些一起截进去，**以为是自己要操作的界面**。关掉后屏上窗口数=0 | 【实测·`vd.js:583-585`，需 scrcpy ≥3.1】 |
| `max_fps=60` | 以前从没传过 = 无限帧率，实测 MC 跑起来视频流 **145fps**，CPU 和带宽白烧 | 【实测·`vd.js:588-591`】 |
| `control=true audio=false` | 没有控制通道就没有输入注入；audio 不需要 | 【实测·源码】 |
| `scid` 范围 | 见上，`Integer.parseInt(radix 16)` 解析 | 【实测·`vd.js:541-542`】 |

**socket 名必须带下划线**：`localabstract:scrcpy_<scid>`。写成 `scrcpy<scid>` 会连不上，
server 卡在 accept 不建屏，日志只打到 `Device:` 那一行 —— 这个坑会让人排查很久
【实测·源码：`vd.js:12-13` 把它列为四条必踩坑之一】。

**jar 目录要 chmod 555**：`scrcpy-server` 启动时会删自己（`unlinkSelf`）。目录可写就删得掉，
然后下一次启动只报一句 `Aborted`，极难定位【实测·源码：`vd.js:177-181`】。
实现上每次 `ensureJar()` 先 `chmod 777` 目录（否则永远无法升级 jar），推完再 `chmod 444` jar + `chmod 555` 目录。

#### 2.1.3 时序：为什么必须等，为什么必须保持连接

```
app_process 起 server
   │
   ├─ 固定等 1800ms ← 不能省。试过「能连上就往下走」，结果连太早 server 还没准备完，
   │                    屏建不出来（实测 10.6 秒后失败）【实测·源码 vd.js:637-639】
   │
   ├─ socket #0 连上：收 H.264 视频流（不是哑客户端，喂给 video.js 解析）
   ├─ 等 500ms
   ├─ socket #1 连上：控制通道（输入注入）
   │
   ├─ 轮询 dumpsys display 取"新出现的 displayId"（差集，最多 8 秒）
   └─ 轮询 dumpsys SurfaceFlinger --display-id 取"新的 64 位 SF id"（最多 3 秒）
```

**两个 socket 缺一不可，断一个屏就消失。** 因为 scrcpy 的 server 把这块屏的生命绑在客户端连接上：
客户端一断，server 退出，`VirtualDisplay` 被 release。

这解释了为什么「一次性命令行调用」不能用：`vdisplay shot` 每次是新进程，屏刚建好、进程退了、屏没了。
必须有一个长驻进程握着它（插件的形态里就是 DSH 引擎进程；CLI 形态里是一个 daemon）【实测：`README.md` §3.3】。

#### 2.1.4 怎么确认建成了（判据，以及仓库里一处未解决的矛盾）

**能用的判据有两条，可靠性不同：**

1. **`dumpsys display` 里出现新 displayId** —— 只说明屏存在，不说明能托管 App。
2. **`am start --display <id>` 能成功把 App 放上去** —— 这是能力判据，可靠。

代码里还有第三条，**但它可疑**：

```js
// vd.js:514 / 694
const canHost = /FLAG_OWN_CONTENT_ONLY/.test(flags) && /FLAG_OWN_FOCUS/.test(flags);
```

**仓库内部对同一行 `dumpsys display` 输出给出了两份矛盾的记录**（`README.md:109-119` 自己标了
这个问题，我核实它至今没解决）：

| 出处 | 记到的 flags |
|---|---|
| `screen/README.md`（判据来源） | 含 `FLAG_OWN_CONTENT_ONLY` + `FLAG_OWN_FOCUS` |
| `LIMITS.md` A-02（引同一行 `DisplayDeviceInfo`） | `FLAG_PRESENTATION, FLAG_TRUSTED, FLAG_OWN_DISPLAY_GROUP, FLAG_ALWAYS_UNLOCKED` —— **两个关键标志都没有** |

两份记录必有抄错。**如果 `LIMITS.md` 那条为真，`vd.js` 的 `canHost` 会恒为 `false`**
（我核对过：代码没做兜底），而工具输出里这个字段就会被当成"能不能托管"的结论。
**我没能回溯是哪一条抄错，也没核对 AOSP 源码 → 【不知道】。**

**结论：判断能不能托管 App，以 `am start --display` 是否成功为准，不要依赖 flags 字符串。**
这也是本文对用户提问「哪些 flag 决定托管能力」的诚实回答：**机制上应该是那两个，
但本仓库的实测记录自相矛盾，所以这一条只能给到【不知道】。**

### 2.2 为什么这块屏能托管 App，又为什么用户看不见

#### 2.2.1 四个 flag 各管一件事

按 AOSP 常量语义逐个拆（语义部分【推断】自平台文档，行为部分标了仓库证据）：

| Flag | 管什么 | 不设会怎样 |
|---|---|---|
| `FLAG_TRUSTED` | 这块屏"可信"，可以托管 Activity / 输入法 | 不能跑 App，只能当镜像接收端。**这是"能跑 App"的门槛**，创建它需要 `ADD_TRUSTED_DISPLAY` |
| `FLAG_OWN_CONTENT_ONLY` | 屏上只显示**明确投到它上面**的内容，不复制默认屏 | 会变成镜像屏 —— 你看到的还是主屏，AI 点和你看的是同一份画面 |
| `FLAG_OWN_FOCUS` | 这块屏有**自己的焦点**，不与默认屏共享（Android 14+ 才有的标志【实测·源码 `vd.js:7`】） | 一次点击会改全局焦点 → 用户前台被打断。这是"不抢焦点"的机制本体 |
| `FLAG_OWN_DISPLAY_GROUP` | 这块屏独立成一个 display group | IME / 焦点策略跟默认屏绑在一起 → `hide` 也压不住输入法跟过来 |
| **没有 `FLAG_PUBLIC`** | `PUBLIC` 是**枚举可见性** —— 别的用户/App 能不能在显示列表里看到这块屏 | **决定的是“能不能被枚举到”，不是“画不画到面板上”**。一块 public 的虚拟屏照样不会画到物理面板（它没有物理 device 接）。物理不可见的原因是 §2.2.2 的条件一，不是这个 flag |

`FLAG_ROTATES_WITH_CONTENT` 也在，但它带来一个新问题（§2.6），不是"能托管"的原因。

#### 2.2.2 "用户看不见"是两个条件的合取

**条件一：没有物理输出设备接它。** 一块 display 要被看见，必须有一个物理面板（或投屏接收端）
作为它的 `DisplayDevice`。虚拟屏的输出目标是创建者给的 Surface / 内部 buffer。

**条件二：没有 `FLAG_PUBLIC`。** 这块屏不进公共可见集合，只属于创建它的 uid。

两个条件都成立才"看不见"。**只看其中一条会得出错误结论** —— 比如以为"虚拟屏天然不可见"，
于是自己写 display host 时忘了 flag，屏就可能被别的东西枚举出来。

**侧信道（诚实记录）**：这块屏在 `dumpsys display` 里**看得见**，而且名字固定叫 `scrcpy`，
`uniqueId` 里还带 `virtual:com.android.shell,2000,scrcpy,<n>` —— **连建屏用户的 uid 都写在那里**。
scrcpy-server 5.0.1 只有两个 `vd_` 参数（`vd_destroy_content`、`vd_system_decorations`），
**没有改名参数**；这条是从 `classes.dex` 提字符串确认的【实测·源码：`LIMITS.md` A-02】。
要改名只能自己写 display host（未验证）。

所以"用户看不见"的准确含义是：**用户的眼睛看不见，`dumpsys` 看得见。**

#### 2.2.3 托管 App 的硬约束：`singleTask`

这是最容易低估的一条，它是 Android 任务模型决定的，不是参数问题：

```bash
# 对 singleTask 的 App（设置、文件管理器、微信…）
adb shell am start --display <虚拟屏id> -n com.android.settings/.Settings
# → 主屏上那个任务被 reparent 到虚拟屏，用户那一下就没了
```

【实测：`screen/src/tool-spec.js` 的 `screen_check_app` 描述、`README.md` §7.3】

推论有两条，都很硬：

1. **不能给同一个 `singleTask` App 开两个实例。** 想要两个微信只能多用户，不是多屏。
2. **架构上必须把「屏」当唯一互斥资源，而不是把「App」当资源。**
   这条直接决定了 `screen_claim_app` 那组工具的存在理由（§3.5）。

### 2.3 取帧：`ImageReader` 为什么比 `screencap` 快一个数量级

#### 2.3.1 两条路的实现差异

```
【screencap（慢路）】
AI/Node ──exec──> adb shell screencap -d <SFID> -p
                    │
                    ├─ 打开 SurfaceFlinger 的一个 display
                    ├─ 把整块 framebuffer 从 GPU 内存回读到 CPU   ← 141ms 固定开销，不可优化
                    ├─ PNG 编码                                    ← +98ms
                    └─ 经 adbd socket 传回主机                      ← +71ms
                  合计 ≈ 227–243ms/帧（≈2.5–4fps）

【ImageReader（快路）】
建屏时就把一个 BufferQueue 的 Surface 交给合成器
                    │
                    ├─ 合成器每帧把结果**写进你的 buffer**（GPU 合成，没有回读）
                    ├─ 你的进程收到 onImageAvailable 回调（事件驱动）
                    └─ 直接读 CPU 可读的 RGBA buffer → JPEG
                  合计 ≈ 15ms/帧（67fps，回调到达率）

  注意这里有**两块屏**：
    ① scrcpy 建的「后台屏」—— App 跑在上面
    ② framesrv 建的「镜像屏」—— 用 createVirtualDisplay(..., displayIdToMirror=①) 镜像①，
       它的输出 Surface 挂的是 ImageReader
  取帧的代价里包含这第二次合成，图里没画出来容易让人以为是一块屏。
```

**根本差别**：`screencap` 是"事后回读"——每次都要建立一次回读通路并搬运整帧；
`ImageReader` 是"事前接入"——你从一开始就在合成通路上，帧是送给你的。

【实测：`tests/IMAGEREADER-PROBE.md` —— 主屏对照 8.7fps、虚拟屏静止 4 秒 1 帧、虚拟屏动画
269 回调 / 4 秒 = **67fps**（这是回调到达率，探针只做 32×32 采样；做成可交付 JPEG 还要逐行拷 + RGBA→ARGB + 缩放 + 编码，约 10–20ms/帧，端到端交付见 MJPEG 那行的 44.8fps），`firstMean=24` 说明不是黑屏；`README.md` §3.4 的对照表】

#### 2.3.2 事件驱动是个意外的好性质

`ImageReader` 只在内容变化时出帧【实测：静止 4 秒只有 1 帧】。这带来两个后果：

- **静止时几乎零成本**（不用反复截同一张图）
- **变化时立刻出帧**，延迟 ≈ 1 vsync + 拷贝 ≈ 17–20ms（p50≈10ms、p95≈20ms 为推算值）【推断】

所以它同时是"快路径"和"省电路径"。这个性质后来变成了 `vdisplay_wait_for` /
`vdisplay_fingerprint` 那组工具的基础（§3.3）。

#### 2.3.3 代价（都记在案）

| 代价 | 数值 / 说明 | 证据 |
|---|---|---|
| 多一块镜像屏 | 源屏每帧多一次合成（1.15Mpx，估 1–3ms），可能让 3D 游戏掉帧 | 【推断：`IMAGEREADER-PROBE.md` 已知风险 3】 |
| 内存 | 1592×720×4 = 4.37MB/块（Gralloc，不占 Java heap） | 【推断：同上 已知风险 2】 |
| HWC 冲突 | ImageReader 要 CPU 可读 buffer，HWC 未必愿意合成进去 → 3D 游戏可能重新变黑 | 【不知道：探针文件自己列为"需要专门测"】 |
| 常驻进程 | 必须是 `app_process` 常驻，还要自己当 HTTP server | 【实测·源码：`framesrv`】 |

### 2.4 输入注入：scrcpy 控制通道的 32 字节协议

#### 2.4.1 为什么不继续用 `adb shell input`

`input` 那条路的破绽是结构性的，改不动【实测·源码：`inject.js:4-11`】：

| 破绽 | 具体表现 |
|---|---|
| 每次起子进程 | 30–80ms 开销 |
| 压力恒定 | `MotionEvent.obtain(..., pressure=1.0f, size=1.0f, ...)` 写死 1.0 |
| `getHistorySize()` 恒 0 | 没有历史采样 |
| MOVE 严格线性等距 | AOSP `sendSwipe()` 用 `lerp` 等分，间隔 1ms 级 —— **比没有 MOVE 更假** |
| `getDeviceId()` 不确定 | 取"第一个支持 TOUCHSCREEN 的设备"，可能挑中某个虚拟触屏 |

换成控制通道之后，**压力变成报文里的独立字段**，服务端原样写进
`MotionEvent.PointerCoords.pressure`，系统不会重算。

#### 2.4.2 报文格式（scrcpy 5.0.1，32 字节定长，全大端）

```
偏移  字段            类型    说明
 0    type            u8     = 2 (INJECT_TOUCH_EVENT)
 1    action          u8     0=DOWN 1=UP 2=MOVE 3=CANCEL   ← 只有 1 字节，见 2.4.3
 2    pointerId       i64    BE；-1 表示鼠标指针
10    x               i32
14    y               i32
18    screenWidth     u16    必须是虚拟屏**真实**宽，不匹配服务端会静默丢弃
20    screenHeight    u16
22    pressure        u16    定点：0xFFFF = 1.0
24    actionButton    i32
28    buttons         i32
```

**【实测·源码：`inject.js:20-44`】** v2.0 起就是这个格式，v3.3.4 / v4.1 / v5.0.1 逐字节一致
（v1.25 少 `actionButton`）。

**报文里没有 displayId 字段。** 事件投到哪块屏，由服务端与它创建的那块屏的绑定决定，
不是客户端指定的【实测·源码：字段表里确实没有；行为上事件只落在虚拟屏】。

#### 2.4.3 多点触控：为什么必须发基础 action

这是本文里唯一一条**靠反编译自己的依赖**才查清的结论，值得完整写出来。

第一版按 Android 的通用约定，把 pointer index 编进 action 高 8 位：`5 | (1<<8) = 261`。
结果设备侧报 `Inconsistent event`，事件被丢弃。

反编译 `screen/assets/scrcpy-server.jar` 里的 `classes.dex`，在
`com/genymobile/scrcpy/control/Controller.smali` 看到服务端自己就在算：

```smali
:cond_8c                        # action == UP 且还有其他指针
    shl-int/lit8 v1, v10, 0x8   #   action = (pointerIndex << 8)
    or-int/lit8  v1, v1, 0x6    #   action |= 6   ACTION_POINTER_UP

:cond_93                        # action == DOWN 且还有其他指针
    shl-int/lit8 v1, v10, 0x8   #   action = (pointerIndex << 8)
    or-int/lit8  v1, v1, 0x5    #   action |= 5   ACTION_POINTER_DOWN
```

**结论**：客户端只发基础 action（0=DOWN / 1=UP / 2=MOVE），index 由服务端自己移位拼接。
自己编码的结果是 `261 & 0xff = 5` —— **index 被截掉**，服务端再基于 5 生成它自己的序列，
事件自相矛盾。

修复后实测【实测：`tests/MULTITOUCH-FAILED.md`】：

```
双指 600ms → 76 帧
Inconsistent event: 0    （之前每次都有）
Dropping event:     0    （之前 4 次）
窗口：com.android.settings/.Settings 在前台
```

**这条的方法论价值大于结论本身**：能回答问题的物证（scrcpy 自己的字节码）一直躺在仓库里，
当时却把失败归给了"平台限制"。**归因给平台之前，先看依赖的字节码。**

#### 2.4.4 修不掉的（诚实记录）

| 破绽 | 原因 | 能不能修 |
|---|---|---|
| `getDeviceId()` 不是真实触摸屏 | 服务端**写死 0**；`InputDevice.getDevice(0)` 可能返回 null | 自写注入器 |
| 接触面积 `PointerCoords.size` 恒 0 | **协议里根本没有这个字段**（32 字节布局里没有位置） | 自写注入器（`MotionEvent.obtain` 能自己填） |
| `getHistorySize()` 恒 0 | 历史采样由 `InputDispatcher` 合批产生，客户端控制不了 | 自写注入器（`addBatch()`） |
| x/y 只能是整数 | 协议是 i32 | 改协议或自写注入器 |

【实测·源码：`inject.js:35-43`、`LIMITS.md` A-04/A-05/A-06】

### 2.5 实时预览：`TYPE_APPLICATION_OVERLAY` + MJPEG，为什么不用 SurfaceFlinger 直出

#### 2.5.1 必须先解决"谁来画这个窗"

`app_process` 画不了窗（§2.1.1 的 `Unknown pid` 实测）。所以预览必须由一个**真正的应用进程**画。
这就是那个 24KB 的 APK 存在的唯一理由。用户不用手动装：APK 在
`screen/assets/overlay/ai-overlay.apk`，第一次推流时插件自动 push → install →
`appops set SYSTEM_ALERT_WINDOW allow` → 启动（实测 1094ms）【实测：`README.md` §3.6】。

#### 2.5.2 为什么不能"SurfaceFlinger 直出"

**这是【推断】，仓库里没有这条的实测记录，我按机制推**：

一块 App 窗口是 display 0 的 layer stack 里的一层。要把**另一块 display** 的合成结果
放进这一层里，需要一个"从 display N 的 framebuffer 复制到 display 0 的 layer"的通路。
Android 没有这个公开 API，因为合成器的输出目标是**显示设备**，不是别人的窗口。

能跨过这条边界的只有三条路，每条都是"复制像素"：

| 路 | 能不能用 | 原因 |
|---|---|---|
| `Presentation` | ❌ 方向相反 | 它把**你自己的内容**渲染到目标 display 上，不是把目标 display 的内容拿回来 |
| `MediaProjection` | ⚠️ 可用但要授权 | 每会话一次用户同意弹窗；且建出来的是镜像接收端（能否托管 App 未验证） |
| 读帧（ImageReader / screencap） | ✅ 本项目的选择 | 已经在 §2.3 建好通路了 |

所以"SF 直出"不是被放弃的优化，是**不存在这条路**。

#### 2.5.3 为什么是 MJPEG，不是 H.264

已经有一条 H.264 流（scrcpy 的视频 socket，34.3fps【实测：`README.md` §3.4，411 帧/12 秒】），
为什么预览不用它？

| 维度 | H.264 直用 | MJPEG（选的） |
|---|---|---|
| 解码 | 需要 MediaCodec + 时间戳同步 + 渲染到 Surface | 一帧一张 JPEG，解码器就是 `BitmapFactory` |
| 跨进程 | 视频 socket 在 Node 进程里 | framesrv 自己起 HTTP server，**链路里没有 Node 中转** |
| 延迟 | 有 B 帧/重排风险 | 单帧独立，延迟有界 |
| 成本 | 编码省带宽 | 2fps 预览实测 **0.30 核、29KB/s**（360×640）【实测】 |

代价是带宽和质量。在"用户偶尔瞄一眼 AI 在干什么"这个用途上，2fps + JPEG q70 是够的；
要高帧率看动画，走 `vdisplay_live`（H.264 常驻解码，读一帧 <1ms）【实测·源码：`tool-spec.js`】。

#### 2.5.4 成本结构（实测）

| 项 | 数值 | 出处 |
|---|---|---|
| MJPEG 帧间隔 | 平均 20.6ms / 中位 17.0ms / P90 33.1ms | 【实测 `MEASUREMENTS` M1】 |
| 4 秒收到帧数 | 179 帧（≈44.8fps） | 【实测 M1】 |
| 单帧编码 | 约 10–20ms（400px 宽 q70） | 【实测·报告 `llms.txt`】 |
| 悬浮窗最小化尺寸 | 117×208（dp(36)×3.25） | 【实测 M3】 |
| 悬浮窗画面与源屏一致性 | 平均像素差 3.1（同画面，属 JPEG+缩放误差） | 【实测 M5】 |
| 空闲时 framesrv CPU | **10.3%**（悬浮窗连着 MJPEG，它就一直编码） | 【实测 `README.md:846`】 |

最后一条催生了 `screen_keepalive`：**后台屏不关是有成本的，所以必须让 AI 按任务预估生命周期。**

### 2.6 方向问题：`FLAG_ROTATES_WITH_CONTENT` 与尺寸看门狗

#### 2.6.1 问题链（每一环都会让人以为是"渲染坏了"）

```
虚拟屏带 FLAG_ROTATES_WITH_CONTENT
   ↓
App 强制横屏时，屏的**逻辑尺寸真的会变**：720×1592 → 1592×720
   ↓
① 取帧镜像的 ImageReader 尺寸是建的时候定死的 → 画面挤在顶部一条，其余全黑
② SurfaceFlinger 会**重建**这块虚拟屏 → 64 位 SF id 换新 → 旧的 screencap -d 全部失败
③ 输入换算用的 state.width/height 还是竖屏值 → nx/ny 乘错 → 点不到
   ↓
三个症状看起来都像"渲染不出来 / 3D 支持不行"，实际都是尺寸没跟上
```

【实测：`framesrv/.../Main.java:91-94`（"2026-11-20 实测"）、`vd.js:806-814`
（"根本不是 3D 渲染不出来"）、`MULTITOUCH-FAILED.md` 问题③】

#### 2.6.2 解法的第一原则：尺寸不能"建时定死"，必须"持续对齐"

由此得到两个看门狗，分别在链路的两端：

**A. 取帧侧（`framesrv` 的 `size-watch` 线程）**：

```
每 1000ms 读一次真实尺寸（dumpsys window displays 里 cur=WxH）
   ↓ 读到新尺寸
连续两次一致才动手（去抖：转屏中间态尺寸会跳变，看到一次就重建会在动画中间反复拆建）
   ↓
距上次重建 <1500ms 则跳过（限速，同理）
   ↓
openMirror(w, h)：**先建新的 ImageReader + 镜像，成功了再拆旧的**
   ↓
打日志 RESIZE 720x1592 -> 1592x720
```

【实测·源码：`Main.java:170-214`、`openMirror` 的注释"顺序很重要：先建新的，成功了再拆旧的"】

**B. 注入侧（`vd.js` 的 `refreshRealSize`）**：

```
input() 顶部调 refreshRealSize()
   ↓
dumpsys window displays | grep -A2 "mDisplayId=<id> " | head -3  → 匹配 cur=(\d+)x(\d+)
   ↓
变了就更新 state.width/height，并把 lastShotHash 作废（去重基准失效）
   ↓
带 2 秒 TTL：连续操作时尺寸不会变，每次都查纯属浪费
```

【实测·源码：`vd.js:887-918`】

**为什么两边都要，而不是一处？** 因为它们是两个独立的消费者：镜像侧决定"画面画在哪"，
注入侧决定"事件落在哪"。只修一边的表现是：画面正确但点不准，或者点得准但看不到。

#### 2.6.3 判据要选对：`dumpsys display` 报的是声明尺寸

`refreshRealSize` 和 `framesrv` 都用 `dumpsys window displays` 的 `cur=WxH`，
**不用 `DisplayManagerGlobal.logicalWidth/Height`，也不用 `dumpsys display` 的尺寸**：

> `dumpsys display` 报的是虚拟屏**初始声明**尺寸（比如 720×1592），App 强制横屏后实际是 1592×720 ——
> 声明尺寸会滞后，拿它做看门狗判据**可能永远不触发**。
>
> 【实测·源码：`Main.java:216-225`】

#### 2.6.4 `square` 的取舍：一个用"旋转不变"绕开整条问题链的选项

既然尺寸变是根因，最直接的解法是**让尺寸变成旋转不变量**：720×720 转 90° 还是 720×720。

边长选 1080 而不是 720，理由是 dp 门槛（dpi 320 时 dp = px/2）：

| 边长 | dp | 问题 |
|---|---|---|
| 720 | 360dp | 低于「正常屏」门槛 470dp，部分 App 进小屏布局 |
| **1080** | **540dp** | 高于 470dp、低于平板门槛 600dp —— 两边都安全 |
| 1280 | 640dp | 触发 `sw600dp`，微信 / Chrome / 设置切平板双栏 |

【实测·源码：`vd.js:458-470`，这是一段设计推理，**不是测量**，dp 门槛数值本身我没核对 AOSP
配置，标【推断】】

**但 `square` 有明确反例，默认不要用**：16:9 的游戏会按高度算出更宽的画布，**右边被裁**
【实测·源码：`tool-spec.js` 的 `vdisplay_start` 描述】。默认值因此是 `auto`（按物理屏比例）。

---

## 三、功能全景：49 个工具，按"解决的问题"分组

### 3.0 为什么这样分组

49 个工具不是 49 个功能点。它们是**一条链路上每一环暴露出来的缺口**，
所以按"缺哪一环会失败"分组，比按字母序有意义。

数量核对（`screen/src/tool-spec.js` md5 `6c5693c8…`，注册处 `screen/src/index.js:81-128`）：

| 组 | 数量 |
|---|---|
| A 建屏与生命周期 | 8 |
| B 投屏与应用管理 | 2 |
| C 取帧、识别与等待 | 15 |
| D 输入与操作 | 4 |
| E 占用与多屏协作 | 4 |
| F 推流与展示 | 2 |
| G 安全与风控 | 4 |
| H 浏览器控制（`web` 包） | 10 |
| **合计** | **49** |

**注意工具数会漂**：`screen/README.md` 还写着"八个工具"，`web/README.md` 写"工具数 8"，
`README.md` 写 49。以实际注册名为准。

### 3.1 A 组：建屏与生命周期（8）

**这组解决的本质问题**：虚拟屏的存在是"资源"，而资源有生命周期、有归属、有上限。
没有这组工具，AI 只能"用一次建一次"，屏会随进程消失，多块屏也分不清谁是谁。

| 工具 | 解决什么 | 关键参数 |
|---|---|---|
| `vdisplay_start` | 建一块用户看不见的私有屏。**默认按物理屏比例**（最接近真机），不是写死 720×1280 | `width`/`height`/`dpi`（720/1280/320）、`orientation`（`auto` 默认 / `landscape` / `portrait` / `square`）、`hwc`（`auto`/`on`/`off`）、`systemDecorations`（默认 false）、`maxFps`（默认 60）、`keepMin` |
| `vdisplay_status` | 屏在不在跑、displayId、上面跑着什么 App、主屏焦点是什么 | — |
| `vdisplay_stop` | 销毁屏并释放 OCR/OpenCV 常驻助手（不释放会留孤儿进程） | `forceStopApps`（默认 false；DSH / Shizuku 硬跳过） |
| `screen_keepalive` | 设定"AI 停手多久后自动关屏"。空闲关屏是为了省电（空闲 framesrv 占 10.3% CPU） | `minutes` 1–360，默认 5。**判据是"连续 N 分钟没调任何工具"**，任何工具调用都会重置 |
| `screen_pool` | 池里有几块屏、哪块是活动屏 | — |
| `screen_new` | 新建一块屏，返回 `screenId`（每块 75–185MB 内存） | `orientation`、`hwc` |
| `screen_use` | 切活动屏。之后所有 `vdisplay_*` 都作用在它上面 | `screenId` |
| `screen_close` | 销毁某块屏。**屏一销毁上面的 App 就没了**，只想切走用 `screen_use` | `screenId`、`forceStopApps` |

两个值得单独说的设计决定：

- **`vdisplay_start` 活着就复用，配置不同只提示不重建。** 因为"拆掉一个正在用的屏"代价远大于
  "配置和请求不一致"，而且 `forget()` 曾有 bug 让全局 `debug.sf.enable_hwc_vds` 残留到重启
  【实测·源码：`vd.js:478-488`】。
- **`screen_keepalive` 的判据是"AI 停手"，不是"屏闲置"。** 因为 AI 思考时也停手，
  所以设太短会在思考时被关掉，设太长会白耗电 —— 按任务预估是唯一正确的做法。

### 3.2 B 组：投屏与应用管理（2）

**本质问题**：屏建好了，里面是空的。要让 App 真的跑在它上面，而且不能顺手把用户的东西顶掉。

| 工具 | 解决什么 | 关键参数 |
|---|---|---|
| `vdisplay_launch` | 把 App 投到虚拟屏。**内部先 force-stop** —— 否则主屏后台的旧任务会被拉到前台，顶掉用户正在看的。投完**只报告**主屏焦点变化，**不自动还原**（自动还原会误判：用户自己切了 App 时插件反而去改主屏） | `pkg`、`activity` |
| `vdisplay_apps` | 列第三方 App 的包名。**这个工具是因为一个很具体的缺口才有的**：`vdisplay_launch` 要包名，但之前没有任何工具能告诉模型包名是什么，模型只能猜 | — |

### 3.3 C 组：取帧、识别与等待（15）

**本质问题**：AI 没有眼睛。而"看"在工程上有三个互相冲突的约束 ——
**快**（帧率）、**准**（能不能读懂内容）、**便宜**（token 成本）。这 15 个工具是三条约束下的分工，
不是重复功能。

#### C-1 拿到画面（4）

| 工具 | 解决什么 | 关键参数 |
|---|---|---|
| `vdisplay_shot` | 主截图工具。`frames>1` 连拍拼网格看"动没动"；`region` 局部放大（**同样 token 花在更小面积 = 更清晰**） | `frames`（1/2/4/6/9/12/16）、`width`（240–720，默认 540）、`region{x,y,w,h}`、`intervalMs`、`format`（jpeg/png） |
| `screen_shot_main` | 截**主屏**。唯一用途：核对"我刚才有没有影响用户" | `dir`、`width`（默认 540）、`format` |
| `vdisplay_live` | H.264 常驻解码器的启停。常驻后读一帧是内存拷贝（<1ms），不常驻要按需解码（244ms） | `action`（start/stop/status）、`quality`（2–31） |
| `vdisplay_live_shot` | 从常驻解码器取最新帧。**两个前提**：已 start，且画面在动（静止时收不到帧） | `width`（0=原生）、`dir` |

> `vdisplay_shot` 的 `region` 为什么值得单列：token 按 ⌈宽/42⌉×⌈高/42⌉ 计费，小于 544² 按地板价收。
> 同样一笔 169 token，裁 420 见方是 1:1 像素，全屏缩到 420 宽只有 0.58x —— 清晰度差近 2 倍
> 【实测·报告：`tool-spec.js`】。

#### C-2 读懂内容（4）

> 这一组只负责"看见并认出目标"。**点下去的动作在 D 组**（`vdisplay_tap_*` 三个），
> 因为它们要处理坐标换算、注入和校验 —— 那是输入问题，不是识别问题。

| 工具 | 解决什么 | 关键参数 |
|---|---|---|
| `vdisplay_text` | OCR 读屏，返回每行文字 + 像素坐标 + `nx/ny` + 置信度。**0 图片 token**，约 1.6 秒（首次 3–5 秒加载模型）。画面没变时复用缓存 | `minConf`（默认 0.45）、`maxLines`（默认 80）、`fresh` |
| `vdisplay_find` | 只找文字，返回坐标不点击。默认"包含"匹配；找不到会给相近词建议 | `text`、`mode`（contains/exact/regex）、`nth`、`minConf` |
| `vdisplay_find_image` | 模板匹配找图案。**这是找"没有文字的东西"的唯一快路**（图标、开关、准星、血条）：OCR 读不到图形，而模板匹配 5.7ms | `template`（PNG 路径）、`threshold`（默认 0.75）、`scales`、`region` |
| `vdisplay_find_color` | 按颜色找色块（血条、按钮底色、选中边框、小地图敌我点）。**用 Lab 的 a/b 通道而不是绝对 RGB** —— HDR/色温偏移下 RGB 阈值会全失效 | `color{r,g,b}` 或 `{l,a,b}`、`tolerance`（默认 20）、`minArea`、`region` |

> **分工原则（一句记法）**：模板找"形状固定但颜色会变"的（图标），
> 颜色找"颜色固定但位置/长度会变"的（血条、点位），OCR 找文字。

#### C-3 判断"变了没"与"该等多久"（5）

**这一组的存在理由来自一次验证方法事故**：早期用"首尾截图对比"判断点击是否生效，
结论是错的 —— 瞬时弹窗（弹出又消失）看不见、终态相同（开关、聚焦）会判失败、143ms 采样太粗。
**点击一直是有效的，是验证信号在骗人**【实测：`tests/CLICK-VERIFICATION.md`】。

| 工具 | 解决什么 | 关键参数 |
|---|---|---|
| `vdisplay_fingerprint` | 64 位界面指纹（7ms）。比截图比对便宜（143ms），比 OCR 可靠（不依赖文字，游戏/图片界面也能用）。两次调用给汉明距离：0 相同、≤10 同界面、>10 不同界面 | `key`（独立记录槽位） |
| `vdisplay_diff` | 与上一张比差异，返回 `MAD` + `maxCell`。**`maxCell` 是关键**：一个数字变了，全局 MAD 可能只有 0.0012 但 `maxCell` 有 0.31 —— 只看 MAD 会漏掉小区域变化 | `before`（图片路径） |
| `vdisplay_wait_stable` | 等画面稳定（32×32 灰度判据）。实测滑动后 **121–182ms** 就稳，比固定 `sleep(500)` 快约 300ms，且截图不会撞上转场中间态 | `stableMs`（120）、`maxWaitMs`（2500）、`threshold`（0.5） |
| `vdisplay_wait_for` | 等条件成立。判据从便宜到贵：`stable` → `fingerprint_changes`(7ms) → `diff_gt`(2.3ms+截图) → `color_present`(6.8ms) → `text_appears/gone`(OCR，慢但有 `cheapFirst` 门控) | `until`、`text`/`hash`/`color`、`timeoutMs`（默认 8000，上限 30000）、`pollMs`、`cheapFirst` |
| `vdisplay_choose_method` | 量一下当前界面（边缘密度 / 颜色集中度 / 亮度对比），告诉你该用哪种识别方式。**按界面指纹缓存**，同一界面第二次直接返回 | `key`、`fresh` |

> `vdisplay_wait_for` 的账：固定等 2 秒 + OCR 2–3 秒 = 每步 4–5 秒；
> 用指纹门控（先 7ms 看画面变没变，变了才跑 OCR）= 多数 150–400ms。
> **所有"点完等加载"的地方都该用它，不要写固定 sleep**【实测·报告：`tool-spec.js`】。

#### C-4 省 token 与判死（1 + 1）

| 工具 | 解决什么 | 关键参数 |
|---|---|---|
| `vdisplay_roi` | 自动挑一块值得看的区域，返回 `region` 给 `vdisplay_shot`。选法：灰度变化包围盒 → 太大就用变化热力图挑最密集的 544² 子区 → 没有就用最近点击位置兜底 | `outputWidth`（默认 544）、`minArea`（默认 0.04） |
| `vdisplay_probe` | 探测界面适合什么识别方式，也用来识别"画面是不是空白"（FLAG_SECURE 或还没加载完） | — |

### 3.4 D 组：输入与操作（4）

**本质问题**：能看见不等于能操作。而"操作"在这里最贵的不是发送，是**确认它生效了**。

| 工具 | 解决什么 | 关键参数 |
|---|---|---|
| `vdisplay_input` | 唯一的底层注入入口。`kind`：`tap` / `swipe` / `hold` / `multitouch` / `text` / `key` / `paste` | `nx`/`ny`（0–1，推荐）或 `x`/`y`；`ms`；`jitter`（默认 2）；`driftX`/`driftY`（摇杆推）；`verify`（默认 true）；`settleMs`；`shotAfter` |
| `vdisplay_tap_text` | 找文字 → 算中心坐标 → 注入点击 → 校验，**一步完成**。价值在于把"自己算坐标"这个环节从模型手里拿掉：模型只需要说要找什么 | `text`、`mode`、`nth`、`verify`（默认 true） |
| `vdisplay_tap_image` | 模板匹配找到图案并点它。**有文字的东西用 `tap_text`（更准），没文字的用这个** | `template`、`threshold`（默认 0.75）、`region` |
| `vdisplay_tap_color` | 按颜色找到**最大**色块并点它。适合纯色按钮、纯色图标 | `color`、`tolerance`（默认 20）、`minArea`、`region` |

`vdisplay_input` 里每个参数都是踩出来的：

- **`nx`/`ny` 优先于 `x`/`y`**：`x/y` 要按"上一次截图里的像素"理解，写错不报错、只是点不到。
- **`hold` 的 60Hz 连续 MOVE + `jitter` 默认 2**：真手指不会绝对静止，设 0 会变成机器特征。
- **`verify:false` 能省约 2 秒**（两次 screencap 各约 1 秒），适合连续点同一界面。
- **`text` 只支持 ASCII**，中文走 `paste`（先写剪贴板再发 `KEYCODE_PASTE`）。
  **剪贴板是系统全局的，写它会覆盖用户自己的剪贴板** —— 这个副作用必须说。
- **`paste` 不经过输入法，所以对自绘输入框也有效**，是 `text` 失败时的首选替代。
- 虚拟屏上**不弹软键盘**（`display_ime_policy=hide` 的代价），所以"打字"这条路要绕。

### 3.5 E 组：占用与多屏协作（4）

**本质问题**：一块屏一个焦点，一个 `singleTask` App 只能在一处。**稀缺资源的分配需要协议，
不能靠自觉。** 这组的对象不是屏，是 App 在屏上的**占用权**。

| 工具 | 解决什么 | 关键参数 |
|---|---|---|
| `screen_check_app` | 这个 App 现在被谁占着。五个等级：`FREE` / `USER_BG`（用户主屏后台有）/ `USER_ACTIVE`（**绝对不能碰**）/ `AI_HELD`（在我们自己屏上）/ `FOREIGN`（外来屏，不碰） | `pkg` |
| `screen_claim_app` | 申请占用。**默认 `fail` 不抢占** —— 默认抢占会让多 AI 互相抢，默认失败才逼出"先查再决定" | `pkg`、`onConflict`（fail/wait/preempt）、`preemptible`（默认 true）、`priority`（user/agent/subagent）、`ttlSec`（默认 600）、`mode`（exclusive/readonly） |
| `screen_release_app` | 释放占用。不传 `leaseId` 就释放自己的全部 | `leaseId` |
| `screen_leases` | 看所有占用凭证：谁占着什么、还剩多久、能不能抢 | — |

两个必须说清的诚实点：

1. **宽限期只有 5 秒，而一轮 AI 往返 6–9 秒，所以"让原持有者体面收尾"在物理上做不到。**
   `preempt` 能保证的只有"它不会继续误操作"【实测·源码：`tool-spec.js` 的 `screen_claim_app`】。
2. **租约目前不跨进程共享**：每个进程各自记账，`BROKER-DESIGN.md` 里的完整 broker
   （优先级老化、wait-for 图、WAL）仍只是设计【实测·源码：`LIMITS.md` D-05】。

### 3.6 F 组：推流与展示（2）

**本质问题**：AI 在后台干活，用户看不见过程。完全不可见会带来信任问题，全可见会带来打扰问题。
这组的取舍是：**低帧率、按需、可随时关。**

| 工具 | 解决什么 | 关键参数 |
|---|---|---|
| `vdisplay_stream` | 把画面以低帧率 JPEG 推到 DSH Go 的「AI 画面」胶囊，用户点开就能看。**实测 360×640@2fps 约 0.30 核、29KB/s，全程不写任何文件** | `fps`（1–4，默认 2，上限 15）、`width`（240–720，默认 360） |
| `vdisplay_stream_stop` | 停止推流。不看时不显示画面；也不该让它空转（空闲 10.3% CPU） | — |

### 3.7 G 组：安全与风控（4）

**本质问题**：这套工具的能力边界很宽（能操作任意 App），所以**"不该做"的判断必须成为工具**，
不能只写在文档里 —— 写在文档里模型不会读。

| 工具 | 解决什么 | 关键参数 |
|---|---|---|
| `screen_user_state` | 查"用户现在在用手机吗"。判据：前台是 DSH Go（在跟 AI 对话）或 IME 正在显示 → `BUSY`。**动主屏前必须先调它** | — |
| `screen_risk` | 查目标 App 的风控等级，决定能用什么手段：`L0` 随便 / `L1` 控频 / `L2` 拟人化 / `L3` 只读、写操作必须问用户 / `L4` 银行支付只能交给人 / `L5` 技术做不到。**未知 App 按 L3 处理** | `pkg` |
| `screen_modes` | 列出四种操作方式（`shell` / `browser` / `vdisplay` / `watch`）和各自代价，让模型按任务选 | — |
| `vdisplay_probe_secure` | 黑屏探针：判 `A` 正常出画 / `B?` 疑似受保护（再查 `dumpsys` 的 FLAG_SECURE 窗口数复核）/ `C` 整屏黑（App 没渲染或没起来） | `dir` |

> `screen_user_state` 的存在理由是一次真实事故：抢键盘。那个判据本来写在
> `tools/user-busy.sh` 里，脚本是对的 —— **但它不在工具链路里，所以模型不知道要调它。**
> 把检查变成工具，比写进文档有效。这是本项目里最通用的一条经验。

**关于 `risk.json` 的规模**：工具描述写"42 个 App 已标注"，我数了当前文件是 **44 条**
（`docs/risk.json` 的 `apps` 键，2026-11-19 15:02）。**描述落后于数据，是 44 不是 42。**

### 3.8 H 组：浏览器控制（10，`web` 包）

**本质问题**：不是所有任务都该点屏幕。网页有 DOM，走 CDP 可以**零打扰 + 结构化 + 快几十倍**。
这一组的核心不是"能点网页"，而是**"不去碰用户的标签页"** —— 用户的会话、登录态、
80 多个标签是真实资产，一次误操作就没了。

| 工具 | 解决什么 | 关键参数 |
|---|---|---|
| `web_browser` | 查看/切换目标浏览器（Edge / Chrome / 红魔浏览器）。**同一时刻只能一个**，因为三者的 devtools socket 都叫 `chrome_devtools_remote` | `select`（edge/chrome/nubia） |
| `web_ensure` | 检查并修复 CDP 通道（`adb forward` 会变陈旧，表现为 `socket hang up`）。web_* 失败时先调它 | `allowForeground`（默认 false：不启动浏览器） |
| `web_open` | 开一个**本插件自己的**标签，返回 `targetId`。URL 里打 `#dsh-<marker>` 标记，崩了也能找回。**永不复用/导航用户的标签** | `url`、`reuse`（默认 true） |
| `web_attach` | 接管用户已经开着的标签。**只注册，不导航、不刷新** —— 目的是复用登录态，而不是重新登录 | `targetId`、`wake`（会调 `Target.activateTarget`，用户正看着浏览器时会切视图，要先征得同意） |
| `web_tabs` | 列所有标签，标明归属：插件开的 / 已接管 / 用户自己的。只读 | — |
| `web_read` | 读页面文字（DOM，4 千字），**不花图片 token** | `targetId`、`maxChars` |
| `web_click` | 按 CSS 选择器或可见文字点击。先滚到可见再点，所以页面滚动/布局位移不会点错 | `targetId`、`selector` 或 `text`、`touch`（默认 true 走触摸事件） |
| `web_fill` | 填表单。**逐字符 `dispatchKeyEvent`（含 Shift 配对）**，让 React/Vue 收到事件；只设 `element.value` 会让框架状态为空，页面报"还是空的" | `targetId`、`selector`、`text` |
| `web_shot` | 截图（PNG），布局重要时用 | `targetId`、`dir` |
| `web_close` | **只关自己开的标签**；关用户的标签必须 `confirm:true`。不带参数时顺手清掉 adb forward（陈旧的 forward 是后续连接挂住的根因） | `targetId`、`confirm` |

> `web_click` 的 `touch` 默认为 true 有个具体理由：手机浏览器上真人用手指，
> 而鼠标路径本身是可识别的机器特征 —— "声明支持触摸却零个 touch 事件"。
> 同理 `web_fill` 不用 `Input.insertText`：它只往 DOM 里塞文字，**不产生 keydown/keyup**，
> 会被 `input-without-keys` 这类判据抓住【实测·源码：`LIMITS.md` D-07】。

---

## 四、谁都可以复现

### 4.1 最小复现路径：30 行建一块虚拟屏

**前提**（一次准备）：

```bash
adb connect 127.0.0.1:5555          # 手机需先开无线调试并配对
adb push screen/assets/scrcpy-server.jar /data/local/tmp/dshvd/
adb shell 'chmod 444 /data/local/tmp/dshvd/scrcpy-server.jar; chmod 555 /data/local/tmp/dshvd'
```

**脚本**（`min-vdisplay.mjs`，Node 18+，**大约 30 行**）：

```js
// min-vdisplay.mjs —— 建一块用户看不见的虚拟屏，并保持它活着
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';

const T = process.env.ADB_TARGET || '127.0.0.1:5555';
const adb = (...a) => execFileSync('adb', ['-s', T, ...a], { encoding: 'utf8' });
const sh = (c) => adb('shell', c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const JAR = '/data/local/tmp/dshvd/scrcpy-server.jar';
const W = 720, H = 1600, DPI = 320;
const scid = (1 + Math.floor(Math.random() * 0x7ffffffe)).toString(16).padStart(8, '0');
const port = 28000 + Math.floor(Math.random() * 900);

console.log('ADD_TRUSTED_DISPLAY granted =',
  sh('dumpsys package com.android.shell | grep -c "ADD_TRUSTED_DISPLAY: granted=true"').trim());

adb('forward', `tcp:${port}`, `localabstract:scrcpy_${scid}`);   // 名字带下划线

const cmd = `CLASSPATH=${JAR} app_process / com.genymobile.scrcpy.Server 5.0.1 `
  + `log_level=info tunnel_forward=true display_ime_policy=hide vd_system_decorations=false `
  + `new_display=${W}x${H}/${DPI} max_fps=60 control=true audio=false scid=${scid}`;
const child = spawn('adb', ['-s', T, 'shell', cmd], { stdio: 'inherit', detached: true });

await sleep(1800);                                                // 这个等待不能省
const video = net.connect(port, '127.0.0.1'); video.on('data', () => {});       // socket #0
await sleep(500);
const control = net.connect(port, '127.0.0.1'); control.on('data', () => {});   // socket #1
await sleep(2000);

console.log(sh('dumpsys display | grep -oE "mDisplayId=[0-9]+" | sort -u'));
console.log('屏已建好。本进程不退出，屏就在；Ctrl-C 之后屏立刻消失。');

process.on('SIGINT', () => {
  adb('forward', '--remove', `tcp:${port}`);
  child.kill('SIGKILL');
  process.exit(0);
});
```

**用它**（另开一个终端）：

```bash
node min-vdisplay.mjs &
# 假设输出的新 displayId 是 613

# 投一个 App（注意：singleTask 的 App 会把主屏任务搬走）
adb shell am start --display 613 -n tv.danmaku.bili/.MainActivityV2

# 取一张静态图（要 SurfaceFlinger 的 64 位 id，不是逻辑 displayId）
SFID=$(adb shell 'dumpsys SurfaceFlinger --display-id | grep scrcpy' | grep -oE '[0-9]+' | head -1)
adb exec-out screencap -p -d "$SFID" > /tmp/vd.png

# 确认它真的存在，而且名字固定叫 scrcpy（这也是可检测特征）
adb shell 'dumpsys display | grep -i scrcpy'
```

**到这里，"用户看不见的屏"就成立了** —— 主屏没有任何变化，用户手上什么都没发生。
这就是全部的秘密，它只有 30 行。

### 4.2 需要什么

| 项 | 要求 | 备注 |
|---|---|---|
| adb | 能连上本机一个 uid 2000 的 shell | 无线调试 + `adb connect`；`adb tcpip 5555` 后可走回环，WiFi 断了也行 |
| Node | 18+（要有原生 ESM 和 `node:net`） | 或者任何能给 socket 写字节的语言 |
| 安卓机 | **Android 12+**（实测 Android 16 / 红魔 NX809J） | 关键门槛不是版本号，是下面两条 |
| `com.android.shell` 有 `ADD_TRUSTED_DISPLAY` | **必须有**。Pixel 默认没有 | 一部分机型有。没有就建不了能托管 App 的屏，这条路直接断 |
| scrcpy-server jar | v5.0.1（仓库里带，733,930 字节） | 版本要和控制协议配套 |

**一条经常被忽略的前置**：不需要 root，也不需要 `adb root`。**不要试着去提权** ——
整套设计的能力上限就是 shell 的能力上限，提权会同时带来可检测特征和不可控风险。

### 4.3 哪些简单、哪些难（诚实分级）

用户经常问"这有多难"。分层回答，因为差别是数量级的：

| 环节 | 难度 | 说明 |
|---|---|---|
| **建一块屏** | ⭐ 很简单 | 就是 §4.1 那 30 行。有 adb、有权限、jar 在，半小时能跑通 |
| 投 App 上去 | ⭐ 简单 | 一条 `am start --display`。坑只有 `singleTask` |
| 截一张图 | ⭐⭐ 中等 | 要分清 逻辑 displayId ≠ SurfaceFlinger 64 位 id。传错会截到主屏，看起来像"这块屏在镜像主屏" |
| **输入注入** | ⭐⭐⭐ 难 | 32 字节协议要逐字节对；多点触控的 index 编码必须让服务端做；坐标必须用真实尺寸换算 |
| **取帧快路** | ⭐⭐⭐⭐ 很难 | 要写 Java + 反射 `@hide` 方法 + 处理旋转重建 + 背压 + 自己当 HTTP server |
| 面向用户的预览 | ⭐⭐⭐⭐ 很难 | `app_process` 画不了窗（进程身份问题），必须做 APK、签名、装、授 overlay 权限 |
| **OCR / 视觉管线** | ⭐⭐⭐⭐ 很难 | 常驻进程（`import cv2` 328ms）、模型加载、坐标换算、token 成本 |
| **多屏归属** | ⭐⭐⭐⭐⭐ 最难 | 所有屏都叫 `scrcpy`，分不清谁是谁。现在靠 dpi 金丝雀（每块 320+i）反查 |
| 知道"什么时候不该做" | ⭐⭐⭐⭐⭐ 最难 | 见第五节。这部分只能靠事故和时间攒 |

**一句话**：建屏是周末项目，99% 的工作在"建屏之后"。

### 4.4 护城河在哪（不是技术保密）

技术本身是公开的：`DisplayManager.createVirtualDisplay` 有一个公开重载（带 `densityDpi` 的那个），scrcpy 是开源项目，
协议格式写在字节码里。**真正花时间的是这四样：**

1. **49 个工具的完整性。** 不是 49 个功能，是 49 个"缺了它这一环就失败"的补齐。
   例：没有 `screen_keepalive` 会白耗电；没有 `screen_user_state` 会抢用户键盘；
   没有 `screen_check_app` 会把用户正在看的 App 搬走；没有 `vdisplay_apps` 模型只能猜包名。
2. **多屏池 + 租约。** 稀缺资源的分配协议。虽然租约还没跨进程（§3.5），
   但"把屏当互斥资源"这个判断是对的。
3. **OCR / 视觉管线。** 常驻助手、金字塔模板匹配（5.7ms vs 全分辨率 129ms）、
   Lab 颜色空间、指纹门控（7ms 决定要不要跑 1.6 秒的 OCR）。
4. **踩过的坑 + 知道哪些"做不到"是错的。** `LIMITS.md` 25 条，
   外加一次复核发现"16 条里只有 4 条站得住"【`tests/UNKNOWN-RETEST-2026-11-19.md`】。
   **这一项才是真正难抄的** —— 因为它要求不断推翻自己。

### 4.5 明确写一句

> **这套方法属于公开知识，谁都可以做。我们开源出来就是希望更多人来用和改进。**
>
> **关于"私有接口"，必须说准确**：建屏这一步走的是 scrcpy-server，你不用自己碰隐藏 API；
> 但**快取帧那一步必须反射调用 `@hide` 的 `createVirtualDisplay(String,int,int,int,Surface)`**
> （第 4 个 int 是 `displayIdToMirror`），而且要 `setAccessible(true)`
> —— 见 `framesrv/src/com/dsh/framesrv/Main.java`。
>
> **这是本项目最脆的一环**：隐藏 API 在 Android 大版本升级时可能改签名或消失，
> 每次跨版本都要重测。我们只在 Android 16 上验证过。
>
> 不依赖的是：root、注入别人的进程、改系统分区。
> 它只是用了 Android 显示子系统本来就有的能力，以及 `adb shell` 本来就有的身份。

如果有人读完这份文档、自己写了一个更好的版本，那正是这份文档的目的。

### 4.6 一份外部复现记录（以及它的证据边界）

**2026-11-20 晚**，一个完全独立的安卓 AI 助手（Operit，`com.ai.assistance.operit`）只读了本仓库源码，
就独立复现了整个后台屏：装 adb → 连 `127.0.0.1:5555` → 自己写约 170 行 Node 脚本 →
建了一块 720×1600 虚拟屏 → 投 Settings 上去 → 用 SurfaceFlinger id 截图（78.7% 非黑）→ 清理干净，
**全程用户主屏没被打扰**。

**这条的证据等级：我说清楚它是什么、不是什么。**

- 它**不是**【实测】：`tests/` 里没有对应记录。
- 我在整个仓库里搜 `operit` / `com.ai.assistance`，**零命中** —— 这件事没有进仓库。
- 所以它在本文里的地位是：**用户陈述的一次外部复现**。按上面 0.1 的定义，这只能算【不知道】
  （不是怀疑它没发生，是**我无法在仓库内核实**）。

**它能支持什么结论、不能支持什么**：

| 能支持 | 不能支持 |
|---|---|
| 30 行的建屏路径是**可复制的**（第二个实现者不需要读我们的 Node 插件，只读源码就够） | 整套 49 个工具可复制 |
| 建屏这件事**不依赖本项目的任何私有产物** | 取帧快路 / 旋转 / 多屏可复制（他只用 `screencap` 截了一张静态图） |
| "用户主屏不受影响"是**可被别人独立观察到的**性质 | 性能数字可复制（没测帧率） |

这正好印证了 §4.3 的分级：**他复现的是"很简单"那一层，而且一次就成了。**
那 170 行里没有 `ImageReader`、没有控制通道、没有旋转看门狗、没有租约 —— 那些是 4.3 里的后四行。

---

## 五、做不到什么（按"为什么做不到"分类）

`LIMITS.md` 共 **25 条**（A 8 + B 4 + C 3 + D 7 + E 3）。

> **这个数字要打折看**：D 类 7 条是「没做但技术上能做」，不是做不到；
> B-01/B-02 已被后续实测推翻；A-08 自己写着「理由不成立」；B-03 标着「待查」。
> **真正站得住的边界大约 15-16 条。** 引用时请说「25 条边界（其中若干已推翻或待复核）」，别说「25 条做不到」。
**分类标准是原因，不是功能**。这一节按原因摘，并把变动情况标出来。

> ⚠️ **先记住一条方法论**：这份清单本身会过期。
> 2026-11-19 的独立复核发现，之前列的"16 条做不到"里**只有 4 条站得住**
> （另外 3 条被项目自己推翻但文档没同步、3 条技术理由本身是错的、6 条从没试过且有更便宜的新路）
> 【`tests/UNKNOWN-RETEST-2026-11-19.md`】。
> **所以下面的每一条，都请当成"截至某日的判断"，不是永恒事实。**

### A. 平台 / 权限决定，改不了（8 条）

| 条 | 做不到什么 | 根因 | 状态 |
|---|---|---|---|
| A-01 | 消不掉 `adb_enabled=1` 这个特征 | 整套工具依赖 adb：`screencap` 要 adb、`forward` 要 adb、scrcpy-server 要靠 adb 起的 shell 权限 | 【实测·自己写的探针 App，uid 10890 无权限读到 `1`】 |
| A-02 | 虚拟屏改不了名字，它固定叫 `scrcpy` | scrcpy-server 5.0.1 只有两个 `vd_` 参数，没有改名参数 | 【实测·源码：从 `classes.dex` 提字符串】 |
| A-03 | `FLAG_SECURE` 窗口截不到 | 系统级保护，截图 API 返回全黑 | **【推断】见下方专门说明** |
| A-04 | `getDeviceId()` 不是真实触摸屏 | `input` 挑第一个 TOUCHSCREEN 设备；scrcpy 服务端**写死 0** | 【实测·源码】 |
| A-05 | 接触面积 `PointerCoords.size` 做不出来 | **协议里没有这个字段** | 【实测·源码】 |
| A-06 | `getHistorySize()` 做不出来 | 由 `InputDispatcher` 合批产生 | 【实测·源码】 |
| A-07 | 浏览器里 `getCoalescedEvents()` 恒为 1 | CDP 和 `adb input` 两条路都造不出合并采样 | 【实测：六个靶场一直报，已从计分里拿掉】 |
| A-08 | 手机不能当 HID 从机 | **理由不成立**：`android-30.jar` 里有 `BluetoothHidDevice`（API 28+ 公开接口） | 【待复核】 |

**A-01 里最硬的一句，是整套架构的地基**：

> **没有 ADB 就没有"用户看不见的屏"。**
>
> 能跑 App 的可信虚拟屏需要 `ADD_TRUSTED_DISPLAY`（签名级），我们靠 shell 身份才拿到。
> `MediaProjection.createVirtualDisplay()` 建出来的是镜像接收端（**这条是【推断】，不是实测**，
> 见下方矛盾说明）；`android.companion.virtual` 需要 `COMPANION_DEVICE_APP_STREAMING` role，
> **只有 OEM 能授给系统 App**。

所以「关掉 ADB 换架构」不是工程量问题，是**在建屏这一步就断了**。
能做的只有降低暴露面（只开无线调试 / `adb_enabled=2`），而 `adb_enabled=2` 的代价是
**这个值在任何真实设备上都不存在**（正常只有 0/1），商业 SDK 会把"2"当成"有人改过设置" ——
**信号比 ADB 开着更强**。所以不建议用【实测：`LIMITS.md` A-01，反编译 `AdbService$AdbSettingsObserver` 确认判据是 `>0` 不是 `==1`】。

**A-03 必须单独说清，因为它是文档里唯一一处把推断写成硬边界的地方**：

- `LIMITS.md` A-03 自己写着：「【推断】本仓库**没有留实测记录** —— 没做过专门的靶场。
  这条是按 Android 文档和常识写的，**不是实测**」
- `LIMITS.md`「明确不知道的事」第 3 条也写着：「`FLAG_SECURE` 的实际表现 —— 没实测」
- 但 `vdisplay_probe_secure` 的工具描述写的是「任何截屏 API 拿到的都是纯黑 —— **这是无 root 的硬边界**」

**三者不一致。** 准确的说法是：机制上它应该是黑屏（Android 的设计目的就是让截屏拿不到），
**但本仓库从未直接测过**。工具能给的间接证据是 `dumpsys` 里 `FLAG_SECURE` 窗口计数 +
上下半亮度分布，**这是证据链，不是实测**。所以在本文里它标 **【推断】**。

### B. 物理 / 协议决定，改不了（4 条）

| 条 | 做不到什么 | 状态 |
|---|---|---|
| B-01 | `adb shell input swipe` 的 MOVE 严格等距线性 | **已解决**：改走控制通道，按缓动曲线 + 垂直抖动 + 间隔随导数变化 |
| B-02 | `adb shell input tap` 的 DOWN 和 UP 在同一毫秒（真人 >25ms） | **已解决**：控制通道能自己控 DOWN→UP 间隔（60–150ms 随机） |
| B-03 | `--axis PRESSURE` 语法接受但不生效 | 待查（AOSP 源码和实际行为矛盾）；**且 `human.js` 还在发这个参数，与结论矛盾 —— 已知内部不一致，未清理** |
| B-04 | 注入事件的时间戳间隔太整齐 | **【推断】**。控制通道能让间隔跟轨迹导数绑定（已实现），但受 JS 事件循环影响，精度仍是毫秒级，比硬件差 |

> **B-04 的推论**：这不是"调参能解决"的问题。软件侧 `sleep` 的精度低于硬件采样率，
> 所以"时间戳过于规整"这条会一直存在，只是程度问题。

### C. 需要 root / 改内核（3 条）

| 条 | 做不到什么 | 根因 |
|---|---|---|
| C-01 | `/dev/uinput` 打不开 | `untrusted_app` 域没有 uinput 权限，节点通常 `root:input 0660` |
| C-02 | `sendevent` 写真实面板节点需要权限 | 同上，input 组写权限 |
| C-03 | 伪造传感器（陀螺仪/加速度计）需要 root | 注入触摸不产生真实 sensor 事件【推断：仓库无实测记录】 |

> 这三条的共同点：它们能造出"完全真实"的输入（自定 bus/vid/pid/压力/size/history），
> **但都要求 root。** 而 root 本身是比 ADB 更重的高危特征（`LIMITS.md` 引用腾讯云等级：
> root/Magisk 属高危，ADB 只是低危加权）。**所以"用 root 换真实性"在风控场景里是亏的。**

### D. 现在没做，但技术上能做（7 条）

**这一节不是"做不到"。** 单独列出来，因为把它混进 A 类会严重误导判断。

| 条 | 现在没做 | 能做吗 | 备注 |
|---|---|---|---|
| D-01 | 结构化 UI 树（无障碍） | 能 | 无障碍能读 1000 行只要 12.7ms，我们是 OCR 约 1 秒，**差两个数量级**。但**虚拟屏上能不能读 → 【不知道】** |
| D-02 | 自己写 display host 替代 scrcpy | 理论上能 | 能解决 A-02（改名）+ 多屏归属；代价 2–4 周；**可行性未验证** |
| D-03 | 自己写 `app_process` 注入器 | 能 | 一次补齐 deviceId + size + history（A-04/05/06）。**2–3 天，性价比最高的未做项** |
| D-04 | `MediaProjection` 替代 `screencap` | 能 | 这是关掉 ADB 的前提；但**能不能托管其他 App【不知道】** |
| D-05 | 多 AI broker 完整版 | 能 | MVP 已实现（池 + 五级占用 + 租约 + 8 个工具）；缺跨进程租约、优先级老化、wait-for 图、WAL |
| D-06 | MCP server | **已实现** | `screen/bin/mcp-server.mjs` 11 个工具、手写 JSON-RPC、零依赖【实测·源码】；**在真实宿主里跑通的记录仓库没有 →【不知道】** |
| D-07 | 网页填表用真按键序列 | **已完成** | 已改逐字符 `dispatchKeyEvent`（含 Shift 配对）；文档已同步（2026-11-15） |

### E. 统计 / 原理上做不到（3 条）

| 条 | 内容 | 为什么这是原理性的 |
|---|---|---|
| E-01 | 样本量够大时，行为分布必然可分 | 任何生成过程都有自己的分布。仓库里有锚点：阈值 CV > 0.25，实测只有 **0.230**；延迟都挤在 55ms 附近时量化后只剩 4–7 帧可选，CV 被压在 **0.20** —— 这正是"生成过程的分布被量化限制"的实例【`tests/risk-sim/RESULTS.md`】 |
| E-02 | 检测器会学习，没有"最难" | 自博弈式检测器永远能再加一关。**所以"直到没有再难"只对固定检测器成立** |
| E-03 | 真实风控的标签你看不到 | 闭源 + 不透明。**自建靶场通过 ≠ 真实风控通过** —— 这句是这份文档最该记住的 |

### 五·五、汇总：按"还能不能救"重排

| 类别 | 条数 | 还能不能救 |
|---|---|---|
| A 平台/权限 | 8 | 大部分不能。A-08 理由本身错了，待复核 |
| B 物理/协议 | 4 | B-01/B-02 已解决；B-03 待查；B-04 只能改善不能消除 |
| C 需 root | 3 | 不能（也不该） |
| D 没做但能做 | 7 | **能，而且 D-03 被明确标为"性价比最高的未做项"** |
| E 原理性 | 3 | 不能，只能持续对抗 |

---

## 六、实测数据（只写有文件依据的）

### 6.1 取帧与画面

| 指标 | 数值 | 出处 | 等级 |
|---|---|---|---|
| `screencap -d` 一帧 | **143ms**（≈7fps），其中裸回读 141ms | `README.md` §3.4；`IMAGEREADER-PROBE.md` | 【实测】 |
| 加 PNG 编码 + adb 传输 | **227–243ms**（2.5fps），+98ms 编码、+71ms 传输 | `README.md` §3.4 | 【实测·报告】 |
| scrcpy H.264 流 | **34.3fps**（29ms），411 帧 / 12 秒 | `README.md` §3.4 | 【实测·报告】 |
| **ImageReader 回调到达率** | **67fps**（269 回调 / 4 秒）—— 这是**合成→回调**的速率，探针只做 32×32 采样，**不是可交付 JPEG 的速率** | `IMAGEREADER-PROBE.md` | 【实测】 |
| ImageReader 静止时 | 4 秒 **1 帧**（事件驱动，不动就不出帧） | 同上 | 【实测】 |
| MJPEG 出流 | 4 秒 **179 帧**；间隔 平均 20.6ms / 中位 **17.0ms** / P90 33.1ms | `MEASUREMENTS` M1 | 【实测】**单次 4 秒样本，未重复测量** |
| 悬浮窗与源屏一致性 | 平均像素差 **3.1**（同画面） | `MEASUREMENTS` M5 | 【实测】 |
| 悬浮窗最小化尺寸 | 117×208（= dp(36)×3.25） | `MEASUREMENTS` M3 | 【实测】 |
| 3D 游戏亮度（Minecraft） | 启动页 35.1 → 主菜单 **83.2**（完整 3D，非黑屏） | `MEASUREMENTS` M8 | 【实测】 |
| 3D 游戏需要的两个属性 | `vendor.display.vds_allow_hwc=1`（厂商）+ `debug.sf.enable_hwc_vds=1`（默认 0，要开） | 同上 | 【实测】 |

**⚠️ 有一个数字不能用**：`/status` 里的 `fps` 字段读到过 **114 / 120**，
但那两次是**虚拟屏已经死掉、framesrv 还在对空白疯狂编码**的状态（M2、M6）。
**这个字段不能当交付帧率引用。** 而 `llms.txt:26` 还写着"ImageReader 直接读虚拟屏 Surface（53-114fps）"——
**这句包含了那个已作废的 114，文档没同步，属于已知不一致。**

### 6.2 视觉与 OCR（ARM64 本机）

| 指标 | 数值 | 备注 |
|---|---|---|
| `import cv2` | **328ms** | 所以必须常驻进程，否则每次调用都付这个 |
| dHash 64bit 指纹 | **7.0ms** | 缩到 9×8 再算差分 |
| 差分 MAD + maxCell（24×24） | **2.3ms** | 比 32×32 灰度还快 |
| **模板匹配 1/4 金字塔 + 精修** | **5.7ms** | 80×60 模板 |
| 模板匹配 全分辨率（对照） | **129ms** | 慢 23 倍 |
| 颜色 Lab + 连通域 | **6.8ms** | 偶发 165.7ms（疑似 GC） |
| Canny | **0.7ms** | |
| 缩放 1/4 | **0.2ms** | |

【全部【实测】：`tests/CV-BENCHMARK-ARM.md`，图 1592×720 RGBA，每组取中位】

OCR（`rapidocr_onnxruntime`，`det_limit_side_len=320, det_limit_type=min`）：

| 配置 | 耗时 | 相对基线 |
|---|---|---|
| **基线** | **961ms** | — |
| 关 `use_cls` | 935ms | **−3%**（文字 0 行差异） |
| 关 cls + `rec_batch_num=16` | 1180ms | **+23%（更慢）** |

【【实测】：`tests/OCR-TUNING-MEASURED.md`】

**这两个数字推翻了两条"看起来该有用"的优化**：子代理估算关 cls 能省 20–30%（380–770ms），
实测只有 26ms（cls 是批处理的，且模型很小）；大 batch 在这颗 2 大 + 6 小的 8 核上
**落到小核反而慢 23%**。

`tapText` 端到端拆解（优化后 **4.1 秒**，原 6.1 秒）：

```
截图          376ms
OCR           2000-3000ms   ← 大头，占一半以上
注入          250ms
后验截图+等待  876ms
```

【【实测·报告】：`OCR-TUNING-MEASURED.md`】结论：**减少 OCR 成本唯一有效的路是缩小识别范围（ROI），
不是调参** —— 调参空间已被实测证明只有 3%。

### 6.3 资源占用

| 指标 | 数值 | 出处 | 等级 |
|---|---|---|---|
| 每块虚拟屏内存 | **75–185MB**（取决于上面跑的 App） | `README.md:847` | 【实测·报告：`dumpsys meminfo`】 |
| 悬浮窗开着时 framesrv CPU | **10.3%** | `README.md:846` | 【实测：top，2026-11-19】 |
| 推流成本 | 360×640 @2fps ≈ **0.30 核、29KB/s**，不写文件 | `tool-spec.js` | 【实测·报告】 |
| 悬浮窗 APK 安装 | **1094ms**（自动 push→install→appops→启动） | `README.md:230` | 【实测·报告】 |
| APK 体积 | 24KB | `README.md:229` | 【实测·报告】 |
| 滑动后画面稳定 | **121–182ms** | `tool-spec.js` | 【实测·报告】 |
| 多点触控（修复后） | 双指 600ms → 76 帧，`Inconsistent event: 0`，`Dropping event: 0` | `MULTITOUCH-FAILED.md` | 【实测】 |

### 6.4 明确查不到的（不要当结论用）

| 项 | 状态 |
|---|---|
| 多窗口（4 块以上）的帧率 | 【不知道】`MEASUREMENTS` 自己列为"没测到" |
| 长稳（>1 小时）内存与 CPU | 【不知道】同上 |
| 除红魔 NX809J 之外的任何机型 | 【不知道】同上 |
| 悬浮窗在不同 Android 版本的 overlay 权限差异 | 【不知道】同上 |
| 真实风控的判定权重 | 【不知道】 |
| TLS / JA3 指纹 | 【不知道】本机靶场看不到 ClientHello；"网络层 0 暴露"**只覆盖 HTTP 头** |
| `FLAG_SECURE` 的实际表现 | 【不知道】没做靶场（见 §5.A-03） |
| 虚拟屏上的无障碍树能不能读 | 【不知道】原"否证"已因测试不足被撤回（见下） |
| `MediaProjection` 建屏能不能托管 App | 【不知道】只用它截过图 |
| 本机内核有没有 `hid-multitouch` | 【不知道】决定 HID digitizer 路线通不通 |
| `screencap` 会不会拍到鼠标光标 | 【不知道】 |
| App 能不能枚举到这块 presentation display | 【不知道】按 flags 推断能，但**没写过一个真 App 去验证** |
| ImageReader + HWC 会不会让 3D 重新变黑 | 【不知道】探针文件自己列为"需要专门测" |
| `framesrv` 的真实行数 | 【实测·源码】**772 行**，而 `README.md:181` 写"600 行" —— 文档过期 |

---

## 七、我在核实中发现的、文档之间的不一致

写这份文档的过程本身就是一次交叉核对。以下 12 条是**仓库内部互相矛盾**或**已作废但仍在流传**的地方。
列出来不是为了挑错，是因为**它们会直接误导下一个复现的人**。

| # | 不一致 | 两边说法 | 该信哪边 |
|---|---|---|---|
| 1 | **托管判据的 flags** | `screen/README.md` 说需 `FLAG_OWN_CONTENT_ONLY`+`FLAG_OWN_FOCUS`；`LIMITS.md` A-02 引**同一行** `dumpsys` 输出却是 `FLAG_PRESENTATION, FLAG_TRUSTED, FLAG_OWN_DISPLAY_GROUP, FLAG_ALWAYS_UNLOCKED` | **【不知道】**。`README.md:109-119` 自己标了这个问题。**以 `am start --display` 能否成功为准** |
| 2 | **`canHost` 可能恒为 false** | 若 #1 中 `LIMITS.md` 为真，`vd.js:514/694` 的 flags 判据恒 false，而工具输出会把它当结论 | 代码没兜底，**待查** |
| 3 | **17.6% 点空率** | `README.md:571` 仍在引用；`README.md:877` 与 `tool-spec.js:588` 已标**作废**（唯一推导是约 33%，修完后的白点率【不知道】） | **已作废，不要引用**（我在写作期间看着 `tool-spec.js` 被改掉） |
| 4 | **`MediaProjection` 能不能托管 App** | `LIMITS.md` A-01 断言"建出来的是镜像接收端"；同一文件 D-04 写"没试过"；`README.md:148-149` 标【推断】 | **【不知道】**，从未测过 |
| 5 | **`FLAG_SECURE` 是不是实测** | `vdisplay_probe_secure` 描述写"无 root 硬边界"；`LIMITS.md` A-03 写"不是实测"；「明确不知道」#3 也写"没实测" | **【推断】** |
| 6 | **无障碍能不能读虚拟屏** | `tests/ACCESSIBILITY-VS-VIRTUAL-DISPLAY.md` 结论是【不知道】，但同一文件末尾表格仍写"用无障碍树替代 OCR ❌ 对虚拟屏无效"，又写"能看到虚拟屏上的 App ✅" | **【不知道】**。原"否证"已因测试不足撤回（只证明了读屏工具读主屏） |
| 7 | **`ImageReader` 帧率 53–114fps** | `llms.txt:26`；`MEASUREMENTS` M2 证明 114/120 是**屏已死**时的读数 | 用 **67fps / 15ms**（探针）或 **179 帧/4 秒**（MJPEG 出流） |
| 8 | **`risk.json` 规模** | 工具描述写"42 个 App"；文件里 `apps` 实际 **44 条** | **44** |
| 9 | **`framesrv` 行数** | `README.md:181` 写"600 行"；实际 **772 行** | 772 |
| 10 | **工具数** | `screen/README.md` 写"八个工具"、`web/README.md` 写"工具数 8"、`README.md` 写 49 | **49**（39+10，按注册名数） |
| 11 | **UHID 要不要 root** | `MULTITOUCH-FAILED.md` 说"需要 root"；`UNKNOWN-RETEST` 记录"未验证；Android 11+ scrcpy 就用 `/dev/uhid` 无需 root" | **【不知道】**，原说法未经验证 |
| 12 | **`--axis PRESSURE`** | `LIMITS.md` B-03 说"接受但不生效"，并自认"`human.js` 还在发这个参数，与结论矛盾" | 实现与结论**仍然矛盾**，未清理 |

**这 12 条的共同教训**：文档不是一次写对的。每一条"做不到"都必须带**日期和证据等级**，
否则它会变成一个永远不被复查的规则 —— 而错的规则被写进必加载文件（如 `AGENTS.md`）后，
**会被无条件执行且不再被复查**，成本比写在 `LIMITS.md` 里高一个数量级
【这条判断来自 `UNKNOWN-RETEST-2026-11-19.md`「一条系统性问题」】。

---

## 八、这份文档最薄弱的环节

按诚实要求，写的人必须指出自己哪里最站不住。

1. **§2.2 的 flags 部分只有半个答案。** 我能说清每个 flag 的机制作用，
   但**说不出本机实测到底是哪几个** —— 因为仓库里两份记录引同一行输出却互相矛盾，
   我没能回溯是哪条抄错，也没有独立核对 AOSP 源码。§2.1.4 的 `canHost` 可能恒 false 也由此而来。
   **这是全文最实质的缺口，因为它直接关系到"别人照着做能不能托管 App"。**
2. **§2.5.2「为什么不能 SF 直出」是纯推断。** 我给了三条机制理由（Presentation 方向相反 /
   MediaProjection 要授权且未验证 / 只能复制像素），但**没有一份实测或 AOSP 引用**。
   如果有人证明存在"把 display N 渲染进窗口"的公开 API，这一段就要重写。
3. **§4.6 的外部复现无法核实。** 仓库里零命中。我按证据等级只能给【不知道】，
   但用户把它当作核心论据。**我没能独立验证，也没有理由怀疑它** —— 这是"证据等级"和"事实"的差别，
   我选择了照等级标，而不是照重要性写。
4. **性能数字的样本量都很小。** 取帧数字来自**单次 4 秒、1 台设备、没有重复测量**（`MEASUREMENTS` 自己承认）；
   OCR 是 3 次取中位、单张 11 行文字的图；CV 是单机单图。
   **跨机型的外推没有任何依据。**
5. **§3 的 49 个工具会漂。** 我核对的是 `md5 6c5693c8…` 那一版，而且写作期间它被改过一次。
   工具描述里还有已知过期项（如 `risk.json` 的 42 vs 44）。

---

## 九、一句话总结

> **这套东西的全部内容是：Android 本来就能同时存在多块逻辑屏，
> 我们只是把其中一块给了 AI，并且把"看不见、不抢焦点、不抢输入法"这三件事做实。**
>
> **建屏 30 行；剩下的 99% 是让它在真实 App、真实旋转、真实风控下不出错，
> 以及知道哪些"做不到"其实做得到、哪些"做得到"其实是坑。**
>
> 方法是公开的。谁都可以做。唯一抄不走的是那份不断被自己推翻的边界清单。
