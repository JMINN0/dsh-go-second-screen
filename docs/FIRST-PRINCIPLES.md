# 后台屏：第一性原理

> 这份文档不打算说服你我们做得好。它想讲清楚一件事：
> **安卓上"让 AI 操作手机但不占用用户屏幕"这个需求，为什么必然导致这个解法；
> 以及任何人照着做都能复现，我们没有任何技术保留。**

最后更新：2026-11-20。设备：红魔 NX809J / Android 16 (SDK 36) / 无 root / adb uid 2000。

---

## 一、问题的物理约束

### 1.1 起点：屏幕是独占资源

把手机拆到最底层，人机交互只有一条通路：

```
用户 → 眼睛（读屏幕） / 手指（触摸屏）
AI   → 截图（读屏幕） / 注入事件（触摸屏）
```

**屏幕是一份，读者有两个。** 这不是实现问题，是硬件的物理布局决定的 ——
一块显示面板、一片触摸层，同一时刻只能呈现一个画面、接受一套触摸坐标。

所有现有方案都在这个约束下做取舍：

| 方案 | 怎么处理争用 | 为什么不够 |
|---|---|---|
| **无障碍服务**（AccessibilityService） | App 必须在前台才能拿到节点树 | 用户一碰手机就打断；且系统会显示"正在被控制" |
| **scrcpy 主屏镜像** | 镜像 Display 0，AI 看到的就是用户看到的 | 不解决争用 —— 两个人看同一块屏，AI 的手还会在用户脸上动 |
| **Appium / UI Automator** | 同样操作 Display 0 | 同上，且需要 PC 或 root |
| **云手机 / 模拟器** | 换一台设备 | 不是用户的真机：没有已装 App、没有登录态、设备指纹全不对 |

**四种方案共同的隐含假设：必须共用那一块屏。**

### 1.2 换个问法

如果不能消除"两个人要同时用屏幕"这个事实，那么可以问：

> **能不能让他们不需要用同一块屏？**

这个问题在 PC 上早有答案（多显示器）。在安卓上，答案藏在显示子系统里。

### 1.3 Android 提供了什么原语

安卓的显示栈从下到上是：显示硬层 → **SurfaceFlinger**（合成器）→ **DisplayManager**（逻辑显示设备）→ WindowManager（窗口）。

关键事实：**SurfaceFlinger 合成的是"显示设备"这个抽象，不是"物理屏幕"。**

所以可以创建一块**只存在于系统里、没有物理输出**的显示设备（`VirtualDisplay`），它有：

- 自己的 SurfaceFlinger 图层
- 自己的窗口栈（App 可以像在主屏一样启动、布局、渲染）
- 自己的输入路由（触摸事件可以定向投给它）
- 自己的焦点

**它和 Display 0 在系统眼里是两个对等的显示设备。** 这就是解法的全部基础。

**【实测】** 本机 `dumpsys display` 里虚拟屏和内置屏并列出现，各自有独立的
`DisplayDeviceInfo` 和 `DisplayInfo`。

---

## 二、机制：怎么造这块屏

> 这一节是给人复现用的。每一步都有完整命令。

### 2.1 为什么必须用 `app_process`

创建虚拟屏的公开 API `DisplayManager.createVirtualDisplay()` 需要 `Context`，而更关键的是：
**能托管 App 的虚拟屏需要签名级权限**，普通 App 拿不到。

`app_process` 是 Android 的 Java 运行时启动器。以 **uid 2000（shell）** 身份运行它时，
继承的权限集里包含：

- `ADD_TRUSTED_DISPLAY` — 允许创建 trusted 显示设备
- `INTERNAL_SYSTEM_WINDOW` — 允许添加系统级窗口
- `CAPTURE_VIDEO_OUTPUT` 等

**【实测】** `dumpsys package com.android.shell | grep "ADD_TRUSTED_DISPLAY: granted=true"` 有输出。

这就是"无 root 也能做到"的原因：**不是绕过了权限系统，是以一个本来就有这些权限的身份运行。**

### 2.2 建屏的完整命令

我们用的是 scrcpy-server 的 `new_display` 模式（它内部调用 `DisplayManager` 的隐藏接口，并带齐了 flag）：

```bash
JAR=/data/local/tmp/dshvd/scrcpy-server.jar
adb shell "CLASSPATH=$JAR app_process / com.genymobile.scrcpy.Server 5.0.1 \
  log_level=info tunnel_forward=true \
  display_ime_policy=hide \
  vd_system_decorations=false \
  new_display=720x1592/320 \
  control=true audio=false scid=1234567"
```

各参数的作用：

| 参数 | 作用 | 不传会怎样 |
|---|---|---|
| `new_display=WxH/DPI` | 建一块该尺寸的虚拟屏 | 不建屏，只镜像主屏 |
| `display_ime_policy=hide` | 虚拟屏上不显示输入法 | 虚拟屏的输入框会抢走用户的输入法焦点，用户在主屏打字时键盘消失 |
| `vd_system_decorations=false` | 虚拟屏上不带桌面/导航栏/权限弹窗 | AI 截图会把这些系统 UI 一起截进去，误以为是目标界面 |
| `control=true` | 打开输入注入通道 | 只能看不能点 |
| `scid=...` | 会话 id，决定 socket 名 | 连不上（socket 名是 `scrcpy_<scid>`，**有下划线**） |

### 2.3 为什么这块屏用户看不见

虚拟屏创建时带这些 flag：

```
FLAG_OWN_CONTENT_ONLY     内容不跟主屏同步（不是镜像，是独立内容）
FLAG_OWN_FOCUS            不抢主屏焦点（Android 14+）
FLAG_TRUSTED              受信任显示设备
FLAG_PRESENTATION         演示类显示
FLAG_OWN_DISPLAY_GROUP    自己一个 display group
FLAG_ALWAYS_UNLOCKED      不用解锁
```

**关键在于：没有 `FLAG_PUBLIC`。**

SurfaceFlinger 只把带 `FLAG_PUBLIC` 的显示设备投到物理屏幕。没有这个 flag，
这块屏的图层就一直待在显存里，没有任何物理输出 —— **它在系统里真实存在，但用户的眼睛看不到。**

**【实测】** 建屏后用户的物理屏内容完全不变；`screencap -d <虚拟屏的 SF id>` 能把它的画面截出来。

### 2.4 怎么判断一块屏能不能托管 App

【实测·源码】判据是 `dumpsys display` 里 `DisplayDeviceInfo` 那一行同时包含：

- `FLAG_OWN_CONTENT_ONLY`
- `FLAG_OWN_FOCUS`

代码里的实现：

```js
canHost: /FLAG_OWN_CONTENT_ONLY/.test(fl) && /FLAG_OWN_FOCUS/.test(fl)
```

**不要用 `dumpsys display` 里 `real W x H` 判断尺寸** —— 那是 natural size（物理尺寸），
旋转后不变。要看 `dumpsys window displays` 里的 `cur=WxH`，那才是合成器当前在用的。

### 2.5 取帧：为什么 ImageReader 比 screencap 快一个数量级

| 方式 | 原理 | 实测耗时 |
|---|---|---|
| `screencap` | 每次走一遍 SurfaceFlinger 的截图 API，分配新 buffer，编码 PNG 到 stdout | **~143ms/次** |
| `ImageReader` | 直接把这块显示设备的输出 buffer 挂到 Surface 上，有帧就回调 | **15ms/帧（67fps）** |

**差的不是编码速度，是"每次都要重新向合成器要一张图" vs "合成完直接给我"。**

【实测】`tests/IMAGEREADER-PROBE.md`：131 行探针程序，4 秒 269 帧 = 67fps。

实现要点：
- `ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)` — 两个 buffer 轮流用
- `VirtualDisplay` 的 surface 指向这个 reader
- `onImageAvailable` 回调里 `acquireLatestImage()`，**必须 close** 否则 buffer 耗尽会卡死

### 2.6 输入注入：触摸事件怎么送进去

scrcpy 的控制通道是自定义二进制协议。触摸事件用 `INJECT_TOUCH_EVENT`（type 2）。

**这里有个必踩的坑**：多点触控的 `action` 字段编码规则。

```
Android 的 MotionEvent action 标准编码：
  action = (pointerIndex << 8) | actionType
```

但 **scrcpy 的服务端自己会做这个移位拼接**：

```smali
# Controller.smali 里的反编译结果
shl-int/lit8 v1, v10, 0x8      # action = (pointerIndex << 8)
or-int/lit8 v1, v1, 0x5        # | ACTION_POINTER_DOWN
```

如果客户端**也**按标准编码自己拼一遍（比如传 261 = 5 | (1<<8)），
服务端会再移位一次 → 数据被截断（`writeUInt8` 只保留低 8 位）→ 服务端报
`Inconsistent event`，事件被丢弃。

**正确做法：客户端只发基础 action 值 0（DOWN）/ 1（UP）/ 2（MOVE），
索引不要自己编码，交给服务端。**

【实测】`tests/MULTITOUCH-FAILED.md` 记录了完整的排查过程和修复后的验证
（`Inconsistent=0`、`Dropping=0`、76 帧送达）。

### 2.7 实时预览：为什么悬浮窗走 MJPEG 而不是 Surface

理论上可以把虚拟屏的画面直接贴到悬浮窗的 Surface 上（零拷贝）。没这么做，原因是：

1. **悬浮窗和虚拟屏属于不同 display group**，跨 group 的 Surface 合成行为不保证
2. MJPEG 让"画面"变成一份可以随意分发的字节流 —— 悬浮窗、DSH Go 的胶囊、远程客户端都能各取各的
3. 解码成本可控：400px 宽的 JPEG 解码约 10ms

【实测】帧间隔中位 17ms、P90 33ms（`tests/MEASUREMENTS-2026-11-20.md` M1）。

### 2.8 方向：一个必须处理的坑

虚拟屏带 `FLAG_ROTATES_WITH_CONTENT`。当上面的 App 强制横屏时：

| 层 | 会怎样 |
|---|---|
| DisplayInfo（逻辑尺寸） | 720×1592 → **1592×720**（交换） |
| DisplayDeviceInfo（物理尺寸） | **不变**，还是 720×1592 |
| ImageReader 的 buffer | **不变**（尺寸在 newInstance 时定死，没有 API 能改） |

结果：横屏 App 的 1592×720 内容被**等比缩放**进 720×1592 的竖屏缓冲 →
只占顶部 `720×720/1592 ≈ 325px`，**约 20%**，其余全黑。

**【实测】** 修复前截图为 400×884（竖屏比例），内容只在顶部一条；非黑像素 45%。

**解法**：每秒查一次 `dumpsys window displays` 的 `cur=WxH`，变了就重建 ImageReader + VirtualDisplay。
加去抖（连续两次读到同一新尺寸才动手）和限速（1.5 秒）避免转屏动画中间态反复重建。

**【实测】** 修复后 `srcWidth=1592 srcHeight=720`，帧变 400×180，非黑 73%。

---

## 三、功能全景：49 个工具

> 不是功能列表，是**问题列表** —— 每组工具解决一个具体障碍。

### 3.1 屏幕生命周期（8 个）

解决「怎么创建、切换、销毁一块或多块后台屏」。

| 工具 | 解决什么 |
|---|---|
| `vdisplay_start` | 建一块私有虚拟屏。默认按物理屏比例；`hwc` 控制 3D 渲染是否走硬件合成 |
| `vdisplay_stop` | 销毁，释放内存和上面的 App |
| `vdisplay_status` | 现在有没有屏、上面跑着什么、主屏是什么 |
| `screen_new` | 再建一块（屏幕池），每块能独立跑不同 App |
| `screen_use` | 切换"当前活动屏"，之后所有操作作用于它 |
| `screen_close` | 销毁指定的那块 |
| `screen_pool` | 看池里有几块、哪块是活动屏 |
| `screen_keepalive` | 设「AI 多久没操作就自动关屏」，按任务预估生命周期省电 |

### 3.2 投屏与应用管理（3 个）

解决「怎么把 App 放到那块屏上，以及会不会抢用户正在用的」。

| 工具 | 解决什么 |
|---|---|
| `vdisplay_launch` | 把 App 投到虚拟屏。内部先 force-stop —— 否则已在主屏后台跑的 App 会被拉到前台 |
| `vdisplay_apps` | 列第三方 App 拿包名（`launch` 需要包名，但没工具告诉过你包名是什么）|
| `screen_check_app` | **投之前必须查**：这个 App 主屏用户正在用吗？别的 AI 占着吗？|

### 3.3 感知：看画面（14 个）

解决「AI 怎么知道屏幕上有什么」。核心矛盾：**读得准 vs 读得便宜**。

| 工具 | 解决什么 | 成本 |
|---|---|---|
| `vdisplay_text` | OCR 读文字带坐标 | ~1.6s，**0 图片 token** |
| `vdisplay_shot` | 截图（可连拍拼九宫格看运动）| 图片 token |
| `vdisplay_find` | 找文字返回坐标（不点击）| OCR 成本 |
| `vdisplay_find_image` | 模板匹配找图案（没有文字的东西）| **5.7ms** |
| `vdisplay_find_color` | 颜色+连通域找色块（血条、按钮底色）| **6.8ms** |
| `vdisplay_fingerprint` | 64 位界面指纹，判断"还是不是同一个界面" | **7ms** |
| `vdisplay_diff` | 画面差异（MAD + 最大格差）| 截图成本 |
| `vdisplay_probe` | 量界面特征，建议用哪种识别方法 | — |
| `vdisplay_choose_method` | 同上，但按界面指纹缓存，第二次直接返回 | — |
| `vdisplay_roi` | 自动挑值得看的区域做局部放大（省 token）| — |
| `vdisplay_probe_secure` | 判断是不是 `FLAG_SECURE`（截不到的黑屏）| — |
| `vdisplay_wait_for` | 等条件成立，替代固定 sleep | 比固定等快 5-10 倍 |
| `vdisplay_wait_stable` | 等画面稳定 | — |
| `screen_shot_main` | 截主屏（确认用户在看什么）| — |

### 3.4 操作：动画面（4 个）

解决「AI 怎么点准」。**统一思路：把"找位置"交给代码，模型不碰坐标。**

| 工具 | 解决什么 |
|---|---|
| `vdisplay_input` | 底层注入：tap / swipe / text / key / paste。动作前后取哈希，画面没变返回 `changed:false` |
| `vdisplay_tap_text` | 找文字→算中心→注入→校验，一步完成 |
| `vdisplay_tap_image` | 模板匹配找图→点击 |
| `vdisplay_tap_color` | 按颜色找最大色块→点击 |

### 3.5 多 AI 协作（4 个）

解决「多个 agent 同时操作时怎么不打架」。

| 工具 | 解决什么 |
|---|---|
| `screen_claim_app` | 申请占用一个 App。**默认不抢占**（冲突时失败），逼出"先查再决定" |
| `screen_release_app` | 干完释放 |
| `screen_leases` | 看谁占着什么、还剩多久、能不能抢 |
| `screen_user_state` | **动主屏之前必须调**：用户现在在用手机吗 |

> **【实测·源码】重要限制**：租约是**协作式**的。`claim` 会拒绝第二个申请，
> 但 `vdisplay_*` 工具本身**不校验租约** —— `lease.js` 的 `check()` 在库里零调用点。
> 也就是说：守规矩的 agent 不会撞，不守规矩的挡不住。

### 3.6 展示：给人看（2 个）

| 工具 | 解决什么 |
|---|---|
| `vdisplay_stream` | 低帧率 JPEG 推到 DSH Go 的"AI 画面"胶囊，用户点开能实时看 AI 在干什么 |
| `vdisplay_stream_stop` | 停止推流 |

### 3.7 安全与风控（3 个）

| 工具 | 解决什么 |
|---|---|
| `screen_risk` | 查 App 风控等级（L0 随便操作 → L4 只能人工 → L5 做不到）|
| `vdisplay_probe_secure` | 判断内容是不是抓不到 |
| `screen_modes` | 列出四种操作方式各自的代价与适用场景 |

### 3.8 浏览器控制（10 个）

解决「操作网页不该点屏幕」。走 CDP（Chrome DevTools Protocol），零打扰。

`web_open` / `web_read` / `web_click` / `web_fill` / `web_shot` / `web_tabs` / `web_attach` / `web_close` / `web_ensure` / `web_browser`

**这条路和虚拟屏正交**：不需要虚拟屏、不需要 adb 输入、不占屏幕，读的是 DOM 不是像素。

---

## 四、谁都可以复现

> 这一节是本文档的重点。**这套方法没有任何技术保留。**

### 4.1 已经有人独立复现了

**2026-11-20 晚的实测**：一个完全独立的安卓 AI 助手（Operit，`com.ai.assistance.operit`），
只知道"有个后台屏插件，源码在那"，读了我们的代码后，自己完成了：

1. `apt-get install android-tools-adb` 装上 adb
2. `adb connect 127.0.0.1:5555` 拿到 uid 2000 shell
3. **自己写了 170 行 Node 脚本**（不是复制我们的，是按我们的参数重写）
4. 建了一块 720×1600 虚拟屏
5. `am start --display <id>` 把系统设置投上去
6. 用 `dumpsys SurfaceFlinger --display-id` 拿到 64 位 id，`screencap -d` 截图
7. 验证画面（78.7% 非黑，能看到设置界面）
8. 清理干净（虚拟屏 0、app_process 0）

**全程用户主屏没被打扰 —— 用户在 DSH Go 里聊天，另一块屏在跑设置。**

它自己还说了一句很到位的话：

> "`adb forward` 这条是虚拟屏能不能活的关键，通了。"

**这证明：门槛不在"知道怎么做"，在"把 49 个工具和所有坑填完"。**

### 4.2 最小复现路径

需要：一台能开无线调试的安卓机、adb、Node.js。**不需要 root。**

```bash
# ① 一次配对（之后不再需要）
adb pair 127.0.0.1:<配对端口>
adb connect 127.0.0.1:5555
adb tcpip 5555          # 让 5555 绑回环，WiFi 断了也能用

# ② 推 scrcpy-server 上去
adb push scrcpy-server.jar /data/local/tmp/

# ③ 建屏（后台常驻，因为屏跟进程同生共死）
adb shell "CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / \
  com.genymobile.scrcpy.Server 5.0.1 \
  new_display=720x1600/320 display_ime_policy=hide \
  vd_system_decorations=false control=true audio=false scid=1234567" &

# ④ 投个 App 上去
adb shell am start --display <虚拟屏的 displayId> -n com.android.settings/.Settings

# ⑤ 截图（注意：要用 SurfaceFlinger 的 64 位 id，不是 displayId）
SF=$(adb shell "dumpsys SurfaceFlinger --display-id" | grep scrcpy | head -1 | awk '{print $2}')
adb exec-out screencap -p -d "$SF" > shot.png
```

**【推断】** 上面这一套在一台新的 Android 12+ 设备上，只要 `ADD_TRUSTED_DISPLAY` 已授权
（`dumpsys package com.android.shell` 里能看到），就应该能跑通。我们只在红魔 NX809J /
Android 16 上验证过，**别的机型没测**。

### 4.3 哪些简单，哪些难

**简单（半小时能自己写出来）**：
- 建一块虚拟屏
- 投 App 上去
- 截图

**难（这是我们的全部工作量）**：

| 难点 | 为什么难 | 我们的解法 |
|---|---|---|
| 屏跟进程同生共死 | Node 进程一退屏就没了，一次性命令根本没法用 | 常驻守护进程 `vdisplayd` 握着屏，CLI 通过回环 HTTP 下命令 |
| 取帧速度 | `screencap` 143ms/次，做不了连续观测 | ImageReader 直取合成器 buffer，67fps |
| 多点触控 | action 编码规则反直觉，自己编码会被静默丢事件 | 发基础值，索引交给服务端 |
| 方向变化 | 屏会转，buffer 不会；内容被缩进顶部 20% | 尺寸看门狗 + 去抖 + 限速 |
| 打字 | `adb input text` 中文全废；`SET_CLIPBOARD` + `KEYCODE_PASTE` 对自绘输入框无效 | 长按 → 点"粘贴" |
| 3D 游戏 | 不开 HWC 就是黑屏 | 检测 `vds_allow_hwc` 自动开 `debug.sf.enable_hwc_vds`，用完还原 |
| 截图 token 成本 | 720×1592 一张图 684 token | OCR 读文字 0 token；局部 ROI 放大；九宫格看运动 |
| 不打扰用户 | `am start` 会抢前台；`input text` 会把字拼进用户草稿 | 虚拟屏定向注入 + 用户状态检查 |
| 多屏多窗 | 窗口重叠、尺寸算错、屏死了镜像还在 | 碰撞检测排位、尺寸跟随、存活探测 |
| 单实例 | 重复 `am start` 起两个 overlay 进程，旧窗口残留 | `singleTask` + 显式 `onNewIntent` |

**这十件事，每一件都花了实际调试时间。** 源码里每条注释都写着当时踩到了什么。

### 4.4 我们的护城河在哪

**不在技术保密 —— 技术上没有任何秘密，Operit 半小时就复现了核心链路。**

在：

1. **49 个工具的完整性** —— 从建屏到点击到验证到清理，闭环
2. **所有坑的记录** —— `LIMITS.md` 25 条、源码里几十处"实测踩到"的注释
3. **多屏池 + 租约** —— 多 agent 并发的基础设施（虽然租约还是协作式的）
4. **视觉管线** —— OCR / 模板 / 颜色 / 指纹 / 差分各司其职，按场景选
5. **悬浮窗那一层** —— 让用户能看见 AI 在干什么，这是信任的前提

**如果你只想要"AI 操作手机"，上面 4.2 那 20 行就够了。**
**如果你要"能日常用、多任务、不担心出乱子"，才需要这一整套。**

---

## 五、做不到什么（诚实边界）

从 [LIMITS.md](../LIMITS.md) 摘（完整 25 条按原因分五类）：

### 平台/权限决定，改不了
- **`FLAG_SECURE` 的内容截不到**（银行、支付、部分视频 App）—— 截图全黑，无 root 硬边界
- 虚拟屏名字固定叫 `scrcpy`，`dumpsys display` 里可见
- 注入事件的 `getDeviceId()` 不是真实触摸屏，有风控的 App 能识别

### 物理/协议决定，改不了
- `adb shell input swipe` 的 MOVE 是严格等距线性的，做不出真人手抖
- 接触面积 `PointerCoords.size` 造不出来
- `getCoalescedEvents()` 恒返回 1

### 需要 root / 改内核
- 手机不能当 HID 从机
- 改虚拟屏名字

### 现在没做，但技术上能做
- 多 AI broker 完整版（跨进程租约）
- 无障碍树能不能读虚拟屏（测了，结论是【不知道】）

### 原理上做不到
- 和一个"完全不知道屏有多大"的模型保证点准坐标 —— 这是模型的问题不是工具的问题

---

## 六、性能实测

只列有文件记录的（`tests/MEASUREMENTS-2026-11-20.md` 等）：

| 指标 | 数值 | 依据 |
|---|---|---|
| ImageReader 取帧 | **67fps，15ms/帧** | `tests/IMAGEREADER-PROBE.md` |
| MJPEG 出流 | 179 帧/4 秒 = 44.8fps，帧间隔**中位 17ms**、P90 33ms | MEASUREMENTS M1 |
| screencap 对比 | ~143ms/次 | `tests/IMAGEREADER-PROBE.md` |
| OpenCV 模板匹配 | **5.7ms**（8 尺度金字塔+精修）| `tests/CV-BENCHMARK-ARM.md` |
| OpenCV 颜色 Lab+连通域 | 6.8ms | 同上 |
| 界面指纹 | 7ms | 代码注释 |
| OCR 960px | 961ms（从 4.5s 优化下来）| `tests/OCR-TUNING-MEASURED.md` |
| 画面差异 | 2.3ms | 代码注释 |
| 最小截图 token | 169（544² 地板价）| 代码注释 |

**关于「114fps」**：这个数字出现过，但它是 `/status` 的瞬时字段，
其中两次读数是在"虚拟屏已死、镜像还在空转"的 bug 状态下取得的。
**不要引用 114fps。** 交付帧率看上面 MJPEG 那一行。

**没有测过的**：多窗口（4 块以上）帧率、长稳（>1 小时）内存与 CPU、除这台红魔之外的机型。

---

## 七、一句话

**「让 AI 操作手机不占用户屏幕」这个需求，在安卓上的必然解是"另造一块用户看不见的屏"。
这个能力属于 Android 显示子系统，不属于任何一家公司，谁都可以用。
我们做完的是把这条路铺平 —— 49 个工具、25 条边界、几十处只有踩过才知道的坑。**

想自己造，本文档够了。想直接用，装我们的插件。
