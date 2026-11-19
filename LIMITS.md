# 这个工具做不到什么

> 一份诚实的边界清单。写它的理由：竞品分析指出，代码别人一两周能抄，
> 真正值钱的是「知道哪里过不去」——而工具厂商不会写这个，等于劝退客户。
>
> 每条标了证据来源。**没证据的一律标【推断】或【不知道】，不写成事实。**
>
> 最后更新：2026-11-15。设备：红魔 NX809J / Android 16 / 无 root。

---

## 怎么读这份文件

证据等级：

| 标记 | 含义 |
|---|---|
| 【实测】 | 在这台机器上跑出来的，有命令和输出 |
| 【实测·源码】 | 读了 Android / scrcpy 源码确认的行为 |
| 【实测·报告】 | 仓库里的报告里有记录，但不可在仓库内复现 |
| 【推断】 | 有机制依据但没实测 |
| 【不知道】 | 查不到，别当结论用 |

**A–E 分类是按「为什么做不到」分，不是按功能分。**
D 类是「现在没做但技术上能做」——**别把 D 当成 A**。

---

## A. 平台/权限决定，改不了

### A-01 `adb_enabled = 1` 这个特征，用这套工具就消不掉

- **现象**：普通 App 读 `Settings.Global.ADB_ENABLED` 拿到 `1`；`DEVELOPMENT_SETTINGS_ENABLED` 也是 `1`。
- **根因**：整套工具依赖 adb —— `screencap` 要 adb、`adb forward` 要 adb、scrcpy-server 要 adb 起的 shell 权限。
  而且我们用的是 `adb tcpip 5555`，**这条路的前提就是 USB 调试已开**，回环只是传输方式，不改变设置。

**证据（两层，都已核实）：**

**【实测·自己写的探针 App】** 2026-11-16 —— apktool 反编译一个 373KB 的 APK、
改包名、塞一段 smali 探针、重签名安装，以**普通 App 身份**（`myUid = 10890`，不是 shell 的 2000）读设置：

```
ADBPROBE: adb_enabled = 1
ADBPROBE: development_settings_enabled = 1
ADBPROBE: Build.TAGS = release-keys
ADBPROBE: myUid = 10890
```

**没有任何权限就读到了。**（`tests/risk-sim/selfcheck.mjs` 用 shell 读也是 1，但 shell 读得到不代表 App 读得到，所以另做了这次探针。）

**【有依据·源码/文档】** 版本差异很大，必须写清楚：

| Android 版本 | 普通 App 读 `ADB_ENABLED` | 说明 |
|---|---|---|
| ≤ 11 | 能读到真实值 | 当时没有注解检查 |
| **12–16（本机）** | **能读到真实值，无需权限** | `@Readable`，SettingsProvider 只拦 `@hide` 且非 `@Readable` 的 key |
| **17 QPR1+** | **永远返回 `0`（被 redact）** | `@Readable(redactedValue="0")`，commit `5d466bf`；不抛异常，静默返回 0 |

**所以这条会随时间自己变好** —— 但我们这台是 Android 16，现在仍然读得到。

**别的检测路径（比 ADB_ENABLED 更麻烦）：**

| 路径 | 普通 App 能否 | 证据 |
|---|---|---|
| `getprop init.svc.adbd` | **能**（`init_service_status_prop` 对所有域开放） | 【有依据·SELinux property_contexts】 |
| `Settings.Global.ADB_WIFI_ENABLED` | **能**，且 Android 17 也没 redact 它 | 【有依据·源码】 |
| 端口探测 `127.0.0.1:5555` | 能（只要 INTERNET 权限） | 【有依据】 |
| `Build.TAGS` | 能，但本机是 `release-keys`，正常 | 【实测】 |
| `Debug.isDebuggerConnected()` | 能，但只在真有调试器附着时 true | 【有依据】 |

**这意味着：就算把 `adb_enabled` 弄成 0，`init.svc.adbd` 和 `ADB_WIFI_ENABLED` 仍会露。**
单靠改一个设置骗不过做组合检测的。

**关 ADB 能不能保住能力？** 不能 —— 见 [BROKER-DESIGN.md](BROKER-DESIGN.md) 和下面这条：

:::
**关键结论：没有 ADB 就没有「用户看不见的屏」。**

`MediaProjection.createVirtualDisplay()` 建出来的是**镜像接收端**（只能接主屏画面，
不能往上面启动别的 App）；能跑 App 的可信虚拟屏需要 `ADD_TRUSTED_DISPLAY`
（signature|privileged，我们是靠 shell 身份才拿到的）；系统里唯一完整的替代
`android.companion.virtual` 需要 `COMPANION_DEVICE_APP_STREAMING` role，
**只有 OEM 能授给系统 App**。

所以「关 ADB 换架构」这条路在建屏这一步就断了，不是工程量问题。
:::

**那还有什么可做的（便宜且真实）：**

| 做法 | 效果 | 代价 | 状态 |
|---|---|---|---|
| 改成「只开无线调试、关 USB 调试」 | `adb_enabled=0`，adbd 仍跑 | `adb_wifi_enabled=1` 仍可读；有常驻通知；端口随机 | 【有依据·源码】未实测 |
| `adb_enabled=2` | `AdbService` 判断 `>0` 才启 adbd，所以服务照跑；用 `==1` 判断的 App 会认为关了 | 用 `!=0` 判断的仍识破；观察者能看到写入；重启失效 | 【有依据·源码+社区】未实测 |
| 等 Android 17 QPR1+ 的 redaction | 系统级、最干净 | 只有那个版本以上有效，且不覆盖 WiFi/init.svc | 【有依据】 |

#### 两条替代路径的实测结果（2026-11-16）

**① `adb_enabled = 2`：能做，但只骗过一部分，而且我给的建议是别用。**

从 `services.jar` 反编译 `AdbService$AdbSettingsObserver`，判定逻辑是：

```smali
invoke-static {p1, p2, v0}, Landroid/provider/Settings$Global;->getInt(...)I
if-lez p1, :cond_34        # if (value <= 0) → 关闭
```

**是 `> 0` 不是 `== 1`**，所以设成 2 时布尔值仍是 true，`setAdbEnabled` 提前返回，
**adbd 完全不动**。实测：设成 2 之后连接、adbd、所有命令都正常。

再写探针 App 验证普通 App 读到什么：

```
raw getInt = 2
```

从这 2 就能推：

| App 的判定写法 | 读到 2 | 被骗过 |
|---|---|---|
| `== 1` | false | ✅ |
| `!= 0` | true | ❌ |
| `> 0` | true | ❌ |

**但最终我还是改回了 1。** 理由：**正常设备上这个值只可能是 0 或 1，2 是一个不存在于任何
真实设备的状态。** 商业 SDK 的字段文档（数美 `adbEnabled`）写的就是 0/1；
如果采集端把原始 int 上报，服务端看到 2，那不是「没开调试」，是「有人改过这个设置」——
**信号比 ADB 开着更强**。用一个小收益换一个更重的可疑标记，不划算。

**② 无线调试：纯命令行开不起来。**

- `settings put global adb_wifi_enabled 1` —— 写进去了，但 `service.adb.tls.port` 始终为空，
  TLS 服务没启动（`dumpsys adb` 里也没有无线调试端口）
- `cmd adb enable-wifi` —— 不存在，`cmd adb` 只有 `is-wifi-supported` / `is-wifi-qr-supported`
- `setprop persist.adb.tls_server.enable 1` —— **被 SELinux 拒绝**
  （`Failed to set property ... See dmesg for error reason`）

无线调试的开关由 Settings UI 走 `AdbManager` 的服务调用触发，shell 没有那条路径。
**要开必须由人在「开发者选项 → 无线调试」里点一下。**

#### 结论

| 做法 | 全自动 | 骗过 `==1` | 骗过 `!=0` | 是否引入新可疑点 |
|---|---|---|---|---|
| 保持 `=1`（现状） | — | ❌ | ❌ | 无（只是普通开发者状态） |
| 设成 `=2` | ✅ 一条命令 | ✅ | ❌ | **⚠️ 值是 2，真实设备不存在** |
| 只开无线调试 | ❌ 要人点 | ✅（USB 那个变 0） | ❌（`adb_wifi_enabled=1`） | 常驻通知 |
| 等 Android 17 redaction | 系统自动 | ✅ | ✅（对 settings 这条路） | 无 |

**建议：除非确认目标 App 只用 `==1` 判，否则保持 `=1`，把精力放在注入质量上。**

- **状态**：本机（Android 16）无解。不是"以后能解开"，是**要在「能用」和「不暴露」之间选一个**。

### A-02 虚拟屏的名字固定叫 `scrcpy`

- **现象**：`dumpsys display` 里 `DisplayDeviceInfo{"scrcpy": uniqueId="virtual:com.android.shell,2000,scrcpy,<n>"}`。
- **根因**：scrcpy-server 5.0.1 只有两个 `vd_` 参数（`vd_destroy_content`、`vd_system_decorations`），
  **没有改名参数**。
- **证据**：【实测】从 `assets/scrcpy-server.jar` 的 `classes.dex` 里提取字符串，`vd_` 开头的只有那两个。
- **影响**：`uniqueId` 里还带 `com.android.shell,2000` —— 连建屏用户的 uid 都写在那里。
- **绕过**：自己写 display host（app_process 调 `VirtualDisplay`），可以自定名字。
  **但这条路可行性未验证。**
- **可见性**：这块屏**没有 `FLAG_PUBLIC`**（【实测】flags 是
  `FLAG_PRESENTATION, FLAG_TRUSTED, FLAG_OWN_DISPLAY_GROUP, FLAG_ALWAYS_UNLOCKED`），
  所以普通 App 的 `DisplayManager.getDisplays()` 默认看不到；
  但 `getDisplays(DISPLAY_CATEGORY_PRESENTATION)` **能看到**。【推断】

### A-03 `FLAG_SECURE` 窗口截不到

- **现象**：银行、支付、部分 DRM 视频的窗口设了 `FLAG_SECURE`，`screencap` 只能拿到黑图。
- **根因**：系统级保护，截图 API 直接返回全黑。
- **证据**：【推断】本仓库**没有留实测记录** —— 没做过专门的靶场。
  这条是按 Android 文档和常识写的，**不是实测**。
- **影响**：这类界面 AI 完全看不见。
- **绕过**：无。这是 Android 的设计目的。

### A-04 `MotionEvent.getDeviceId()` 不是真实触摸屏

- **现象**：注入事件的 deviceId 可能返回 0，或某个 `bus=0x0000 vendor=0x0000` 的设备。
- **根因**：分两条路 ——
  - `adb shell input`：AOSP 的 `getInputDeviceId()` 挑**第一个 supportsSource(TOUCHSCREEN)** 的设备；
  - scrcpy 控制通道：服务端**写死 0**。
- **证据**：【实测·源码】AOSP `cmds/input/.../Input.java`；scrcpy `Controller.injectTouch`。
- **影响**：App 一行代码就能判定：`InputDevice.getDevice(id).isVirtual()` 或 `getDevice(id) == null`。
- **绕过**：
  - `adb shell input` → 如果系统里有真实触摸屏，它**可能**挑对（取决于枚举顺序）
  - 控制通道 → 改不了，除非自己写注入器
  - 物理 HID 设备 → 能给真实 deviceId（但要买硬件）

### A-05 接触面积 `PointerCoords.size` 做不出来

- **现象**：`MotionEvent.getSize()` 恒为 1.0（adb input）或 0（控制通道/鼠标）。
- **根因**：**scrcpy 的触摸报文里根本没有 size 字段**（32 字节布局里没有位置）。
  HID 鼠标报文的 report descriptor 里也没有压力和面积。
- **证据**：【实测·源码】scrcpy `ControlMessageReader.parseInjectTouchEvent` 的字段表。
- **影响**：真实触摸屏的 size 是 0.01–0.1 之间变化的，恒定值是个明显特征。
- **绕过**：自写 app_process 注入器（用 `MotionEvent.obtain` 能自己填 size），
  或做 HID digitizer（协议支持）。两者都未验证。

### A-06 `getHistorySize()` 做不出来

- **现象**：注入事件的 `getHistorySize()` 恒 0。
- **根因**：历史采样是 `InputDispatcher` 在合批时产生的，客户端控制不了。
- **证据**：【实测·源码】同上。
- **绕过**：自写注入器用 `MotionEvent.addBatch()` 造历史点。未验证。

### A-07 `getCoalescedEvents()` 恒返回 1

- **现象**：浏览器里 `event.getCoalescedEvents().length` 恒为 1。
- **根因**：CDP 和 adb input 两条路都造不出合并采样。
- **证据**：【实测】六个靶场里 probe 一直报这一条，两条路都验证过。
- **影响**：probe 靶场这一项**永远过不了**。所以我们把它从计分里拿掉了（只记录不判分）。
- **绕过**：无。

### A-08 手机不能当 HID 从机

- **现象**：想让手机冒充蓝牙鼠标去操作别的设备 —— 不行。
- **根因**：Android 原生只做 HID Host，做 Device 要改蓝牙栈。
- **证据**：【有依据】**【理由不成立】** android-30.jar 里有 BluetoothHidDevice / HID_DEVICE 角色（API 28+ 公开接口）。20 分钟可判本机 ROM 支不支持：getProfileProxy(HID_DEVICE) 是否返回非 null。
- **绕过**：无。

---

## B. 物理/协议决定，改不了

### B-01 `adb shell input swipe` 的 MOVE 是严格等距线性的

- **现象**：每个 MOVE 之间间隔 1ms 级、位移完全相等。
- **根因**：AOSP `sendSwipe()` 用 `lerp` 等分。
- **证据**：【实测·源码】AOSP `Input.java` 的 `sendSwipe`。
- **影响**：比"没有 MOVE"更假 —— 人是先加速后减速的。
- **绕过**：**已解决** —— 改成走 scrcpy 控制通道，按缓动曲线走 + 垂直抖动 + 间隔随导数变化。
  见 `src/inject.js` 的 `buildSwipe`。

### B-02 `adb shell input tap` 的 DOWN 和 UP 在同一毫秒

- **现象**：`getEventTime() - getDownTime()` 约等于 0。
- **根因**：两次 `injectInputEvent` 之间没有插入等待。
- **证据**：【实测】靶场 `st.f.reaction` 一类检查会抓这个。
- **影响**：真人点击 >25ms。
- **绕过**：**已解决** —— 控制通道能自己控制 DOWN 到 UP 的间隔（60-150ms 随机）。

### B-03 `--axis PRESSURE` 语法接受但不生效

- **现象**：`input motionevent --axis PRESSURE ...` 不报错，但压力不生效。
- **根因**：待查（AOSP 源码和实际行为矛盾）。
- **证据**：【实测·报告】`tests/risk-sim/RESULTS.md` 有记录，但**代码里 `human.js` 还在发这个参数**，
  跟结论矛盾 —— 这是个已知的内部不一致，尚未清理。
- **绕过**：用控制通道的 pressure 字段（已实现）。

### B-04 时钟抖动救不了「事件时间戳过于规整」

- **现象**：注入事件的时间戳间隔太整齐。
- **根因**：软件侧 sleep 的精度比硬件采样低。
- **证据**：【推断】
- **绕过**：控制通道能让间隔跟轨迹导数绑定（已实现），但受 JS 事件循环影响，
  精度仍是毫秒级，比硬件差。

---

## C. 需要 root / 改内核

### C-01 `/dev/uinput` 打不开

- **现象**：`open("/dev/uinput")` 报 Permission denied。
- **根因**：`untrusted_app` 域没有 uinput 权限，节点通常是 `root:input 0660`。
- **证据**：【有依据】SELinux 策略 + 文件权限。
- **影响**：这条路能造"完全真实"的虚拟触摸屏（自定 bus/vid/pid/压力），但用不了。
- **绕过**：有 root 才行。

### C-02 `sendevent` 写真实面板节点需要权限

- **现象**：`sendevent /dev/input/eventN ...` 被拒。
- **根因**：同上，input 组写权限。
- **证据**：【实测·报告】之前试过被符号链按拒绝。
- **绕过**：root，或把当前用户加进 input 组（也要 root）。

### C-03 伪造传感器（陀螺仪/加速度计）需要 root

- **现象**：虚拟屏上的触摸在动、设备本身没动 —— 传感器相关性是断的。
- **根因**：注入触摸不产生真实 sensor 事件。
- **证据**：【推断】物理上成立，但本仓库没有实测记录。
- **绕过**：root + Xposed，但合成信号自身也可检。

---

## D. 现在没做，但技术上能做

> **⚠️ 别把这一节当成 A。** 这些是"还没写"，不是"写不了"。

### D-01 结构化 UI 树（无障碍）

- **现状**：完全没有。靠 OCR + 截图。
- **能做吗**：能，但要接 `AccessibilityService` 并保持常驻连接。
- **难点**：`uiautomator dump` 在本机**实测崩溃**（`UiAutomationService` 被占用）。
  而且 `uiautomator` 和 `a11y-cli` **只读默认屏** —— 虚拟屏上能不能读未验证。
- **收益**：phonedriver 类工具实测读 1000 行只要 12.7ms，我们是 OCR 1.6 秒。**差两个数量级。**
- **代价**：1-2 周 + 可能根本读不到虚拟屏。

### D-02 自己写 display host 替代 scrcpy

- **现状**：用 scrcpy-server。
- **能做吗**：理论上 —— app_process 直接调 `VirtualDisplay` API，可以自定名字、自定 flags。
- **好处**：解决 A-02（名字暴露）+ 多屏归属（现在所有屏都叫 scrcpy，分不清谁是谁）
- **代价**：要处理屏幕合成、编码、输入转发的全套，2-4 周。
- **未知**：可行性未验证。

### D-03 自己写 app_process 注入器

- **现状**：走 scrcpy 控制通道，pressure 有了，但 deviceId 和 size 还是假的。
- **能做吗**：能 —— 照抄 `input` 的 `getInputDeviceId()` 拿真实触摸屏 id，
  用 `MotionEvent.addBatch()` 造历史采样，`MotionEvent.obtain` 自己能填 size。
- **好处**：一次补齐 deviceId + size + history 三块（A-04/A-05/A-06）。
- **代价**：2-3 天。**性价比最高的未做项。**

### D-04 MediaProjection 替代 screencap

- **现状**：截图要 adb。
- **能做吗**：能，普通 App 加用户授权一次就行。
- **好处**：**这是关掉 ADB 的前提**（见 A-01）。如果连输入也换成物理 HID，
  就能做到"完全不用 ADB"。
- **未知**：MediaProjection 建的虚拟屏能不能托管其他 App；每帧开销如何。

### D-05 多 AI 多屏（broker + 租约）

- **现状**：**已实现 MVP** —— `screen/src/pool.js`（屏池 + dpi 金丝雀 + 上下文切换）、
  `src/occupancy.js`（占用检测五级）、`src/lease.js`（租约 + 抢占）、
  对应 8 个工具（`screen_pool/new/use/close/check_app/claim_app/release_app/leases`）。
  daemon 也加了 single-flight 互斥（防两个 MCP 进程同时建屏）。
  **未实现的是**：跨进程租约共享（每进程各自记账）、屏池与 `BROKER-DESIGN.md` 里的
  完整 broker（优先级老化、wait-for 图、WAL）—— 那些仍只是设计。
- **能做吗**：能，**设计已完整落库：见 [BROKER-DESIGN.md](BROKER-DESIGN.md)**。
  前置实验见 `tests/risk-sim/MULTI-SCREEN-FINDINGS.md`（U1-U6 已跑）。
- **难点**：**屏归属** —— 所有 scrcpy 屏都叫 `scrcpy`，分不清谁是谁。
  可行方案是 dpi 金丝雀（每块屏 320+i，从 `DisplayInfo.density` 反查）【实测 U4 可行】。
- **代价**：MVP 2.5-4 天。

### D-06 MCP server

- **现状**：只有 CLI 和 DSH 插件，别的 agent 宿主用不了。
- **能做吗**：能，包一层协议即可，一两百行。
- **收益**："给多少 AI 用"这个问题的第一道门槛。

### D-07 网页填表用真按键序列

- **现状**：`web_fill` 已改成逐字符 `dispatchKeyEvent`（Shift 配对齐全）。
- **但文档落后**：`web/STABILITY.md:47` 和 `web/src/cdp.js:12` 还写着
  "填表用 Input.insertText / 填值必须 Input.insertText"，
  而 `web/src/cdp.js:979` 已经写清了反例：「不用 Input.insertText：它只往 DOM 里塞文字，
  **不产生 keydown/keyup**」。
- **影响**：照文档实现会写出能被 `input-without-keys`（权重 18）判定的填表。
- **动作**：✅ **已清理（2026-11-15）** —— 两处文档都改成了"逐字符 dispatchKeyEvent（含 Shift 配对）"，
  并说明了为什么不用 insertText。这里从"待办"改成"已完成"。

---

## E. 统计/原理上做不到

### E-01 样本量够大时，行为分布必然可分

- **现象**：任何生成过程都有自己的分布，检测器样本够多就能拟合。
- **根因**：统计原理。
- **证据**：【推断】但仓库里有锚点：`tests/risk-sim/RESULTS.md:76` 记录
  「阈值 CV > 0.25，实测只有 0.230」—— 分数就卡在这个临界值上；
  `RESULTS.md:80` 还记了「延迟都挤在 55ms 附近时，量化后只剩 4~7 帧可选，CV 被压在 0.20」。
  这正是"生成过程的分布被量化限制"的实例。
- **影响**：`getHistorySize`、`getCoalescedEvents` 这类"恒为常数"的检查，
  样本越多越确定。
- **绕过**：只能持续改生成过程，没有终点。

### E-02 检测器会学习，没有"最难"

- **现象**：自博弈式检测器永远能针对你当前最好的轨迹再加一关。
- **根因**：对手在动。
- **影响**：**所以"直到没有再难"这个说法只对固定检测器成立。**
  靶场应该做成两套：静态天梯（有顶，用来通关）+ 自博弈无尽（无顶，只出曲线）。
- **绕过**：无。

### E-03 真实风控的标签你看不到

- **现象**：不知道真实风控用什么权重、什么阈值。
- **根因**：闭源 + 不透明。
- **影响**：**自建靶场通过 ≠ 真实风控通过。** 这是这份文档最该记住的一句。
- **绕过**：只能用代理指标（TPR@FPR、外部基准、真实目标的触发率），三个都是代理，不是等号。

---

## ADB 这个信号到底多重（按目标分）

之前的说法「ADB 是一票否决」**只说对了一半**，按目标分是这样：

| 目标类型 | ADB 的份量 | 依据 |
|---|---|---|
| **纯网页 + 行为风控** | **几乎无关** —— 网页读不到 `Settings.Global`，平台隔离 | 【有依据·平台隔离】 |
| 普通 App + 商业风控 SDK | **低危加权，不是否决** | 腾讯云推荐等级把「开发者模式/调试模式（ADB）」列为**低危（3）**，高危是模拟器/注入/HOOK/重打包/系统劫持 |
| 银行 / 金融 | **硬条件，会被拒** | 越南 Circular 77/2025 点名 debugger/模拟器/ADB/hook/repack/root 必须「自动退出或停止」；Vietcombank 错误码 91822 就是 ADB |
| 微信 / 支付宝 | **不确定** | 公开证据只到 root/hook/模拟器/多开层面；**专门查 `adb_enabled` 没有公开证据** —— 【不知道】 |

**这条很重要**：如果你的目标是普通 App 的行为风控，那么**把 ADB 关掉的收益远小于把注入做得像人**。
反过来说，如果是银行类，那 ADB 是第一个拦路的，注入做得再好也过不去。

**真正的一票否决项（比 ADB 更致命）：**

模拟器/云手机、注入/HOOK/Xposed/Frida、重打包/改机、root/Magisk、
设备信息篡改（IMEI/OAID/IMSI）、系统劫持 —— 这些在腾讯云等级里都是**高危**，
微信/支付宝也会直接封。**而这几项我们一个都没碰**（无 root、不改机、不注入别人进程）。

## 不要碰的目标

按「几秒钟内就能判定」排序：

### 红：不要浪费时间

| 特征 | 为什么 | 判据 |
|---|---|---|
| 有 Play Integrity 强校验 | 硬件背书，无 root 拿不到 | 【推断】本仓库零实测（`Integrity\|SafetyNet\|attestation` 全库零命中） |
| 银行 / 支付类 | 检测 ADB、root、多开、模拟器 | A-01 那条已经过不去 |
| 微信 / 支付宝 | 设备指纹一致性 + 账号历史 + 关系网络 | 【推断】没实测过 |
| `FLAG_SECURE` 界面 | 截图全黑 | A-03 |

### 黄：能试但别指望

| 特征 | 说明 |
|---|---|
| 普通网页行为风控 | 这是**唯一**我们做了完整测量的地方。但仍要看它检不检查 ADB |
| 游戏反作弊（ACE 等） | 必然检测，【推断】没实测 |
| 有 DRM 的视频 | 截不到 |

### 绿：我们的靶场覆盖到了

| 特征 | 依据 |
|---|---|
| 浏览器环境指纹 | probe 靶场 17 项 |
| 浏览器行为统计 | strict 靶场 25 项 |
| 网络层头顺序 | net 靶场（**但 TLS/JA3 测不了，见下**） |

---

## 明确不知道的事

1. **真实风控的判定权重** —— 完全不知道。
2. **TLS/JA3 指纹** —— 本机靶场**看不到 ClientHello**，网络层只能测到 HTTP 头。
   所以"网络层 0 暴露"这句话**只覆盖 HTTP 头，不覆盖 TLS**。
3. **`FLAG_SECURE` 的实际表现** —— 没实测。
4. **虚拟屏上的无障碍树能不能读** —— 没试过。
5. **MediaProjection 建屏能不能托管其他 App** —— 没试过。
6. **本机内核有没有 `hid-multitouch`** —— 决定 HID digitizer 路线通不通，没查。
7. **`screencap` 会不会拍到鼠标光标** —— 没试过（有鼠标才能试）。
8. **NX809J 支持 OTG + 同时充电吗** —— 没试过。
9. **App 能不能枚举 `DisplayManager` 看到 presentation display** —— 按 flags 推断能，
   但**没写过一个真 App 去验证**。

---

## 什么会过期

| 类别 | 多久变 | 变了会怎样 |
|---|---|---|
| Android 版本（16 → 17） | 一年 | 输入注入行为、显示 API、权限模型都可能变 |
| 浏览器版本（Edge/Chrome） | 几周 | 指纹项、CDP 行为、`getCoalescedEvents` 表现 |
| scrcpy 版本 | 几个月 | 控制协议格式可能变（v2.0 到 v5.0.1 没变，但不保证） |
| 目标方风控策略 | **随时** | 权重、阈值、新信号 |
| 本机状态（ADB/开发者选项） | 每次改设置 | `selfcheck.mjs` 一跑就知道 |

**建议**：
- `selfcheck.mjs` **每次用前跑一遍**（只读，2 秒）
- 靶场基线**每月重跑一次**
- 这份文档里的【推断】项，**每验证一条就改成【实测】**

---

## 一句话

> **这个工具在「网页 + 普通行为风控」范围内，做了完整的测量和优化。**
>
> **在「App + 强风控」范围内，它连测量都还没做完 —— 而且 ADB 那一关过不去。**
>
> **把这两件事分开说，比笼统说"拟人化做到极限了"诚实得多。**
