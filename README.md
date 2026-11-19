# dsh-go-second-screen · 安卓后台屏

让 AI **在后台操作手机，不抢你的屏幕**。

> **关于名字**：这个项目叫「后台屏」，因为它的实质是「一块用户看不见的屏幕」，
> 而不是「手机的第二块屏」。仓库名 `dsh-go-second-screen` 和包名 `dsh-go-plugin-screen`
> **故意没改** —— 已安装的插件是软链接，改包名会让现有安装全部失效。
> 文档和工具描述里统一叫「后台屏」。

包含三个包：一块看不见的虚拟屏（跑任意 App）、一个浏览器控制器（不点屏幕直接操作网页）、以及一个让你能偷看 AI 干了什么的胶囊。

[English](README.en.md) ｜ 中文

> **状态：实验性（v0.1.0）**。核心链路已实测跑通，但还有已知问题未解决，见文末「已知问题」。**暂不推荐普通用户使用。**

---

## 零、实测报告

**[tests/risk-sim/FULL-REPORT.md](tests/risk-sim/FULL-REPORT.md)** —— 六个本地靶场的完整实测记录。

**[LIMITS.md](LIMITS.md)** —— 这个工具**做不到**什么，56 条，按原因分五类。
**[BROKER-DESIGN.md](BROKER-DESIGN.md)** —— 多 AI 多屏的架构设计（代码未实现）。
**[tests/risk-sim/MULTI-SCREEN-FINDINGS.md](tests/risk-sim/MULTI-SCREEN-FINDINGS.md)** —— 多屏前置实验 U1-U6 实测结论。

一句话结论（**已按 2026-11-15 的复核修正**）：

> 网络层：只测了 HTTP 头，**TLS/JA3 测不了**（靶场看不到 ClientHello）。
> 行为层：网页路径 RT 全过；**但 "100/100" 的分母是 7 项不是 25 项**（样本不足的检查被跳过）。
> 环境层：6/100 是手工跑的数，自动跑分器因为点了「清空记录」按钮而不可复现。
> 系统层：**不是"碰不到"，是"还没量过"** —— 见 [LIMITS.md](LIMITS.md)。

**设备状态那一类之前完全没测过**，现在补上了：`ADB 开着`、`开发者选项开着`
这两项任何 App 读一个设置就能知道，比行为破绽致命得多。跑 `tests/risk-sim/selfcheck.mjs` 自查。

## 零·二、AI 必读：操作方式怎么选

**[OPERATION-PRIORITY.md](OPERATION-PRIORITY.md) 是给 AI 看的操作准则**，动手前先读。

一句话：

> 能后台就别前台，能用命令就别注入。抢了前台就还不回去 —— 要么不抢，要么先说清楚。
> 注入不是"模拟人"，有风控的地方别用。

## 零·三、已经做到什么（全部真机实测）

> 这一节是给第一次看的人：**哪些是真的能用了，不是设想**。

### 能操作 3D 游戏，而且是连续控制

Minecraft 从零开始建世界 → 进游戏 → **用 60Hz 的虚拟摇杆驱动角色走路**。

```
主菜单「游戏」(0.43,0.49) → 新建 (0.33,0.215) → 绿色「创建新世界」(0.50,0.14)
→ 创造模式 (0.72,0.56) → 创建 (0.168,0.637) → 关两个弹窗 → 进游戏
摇杆: hold { nx:0.10, ny:0.72, ms:2500, driftY:-60 }
```

受控对比：静置 1.5 秒画面差异 **0.64**，摇杆 2.5 秒后 **11.69**（**18 倍**）。
帧率 30-60fps。

**这一点和市面上的 AI 手机 Agent 不同** —— 它们多是「看一眼 → 点一下 → 再看」的离散循环
（2 秒一步），我们是**按住不放的连续控制**。

### 视频识别：不用播放，直接读缓存

视频画面**能**抓（2026-11-17 两次实测推翻旧结论：scrcpy 12 秒新增 411 帧=34.3fps；screencap -d <SFID> 约 7fps；ImageReader 67-76fps）。
**但绕开它更简单**：App 缓存的视频是标准 MP4，能直接 pull 出来 ffmpeg 读。

```bash
node bin/vidgrab.mjs find com.tencent.mm     # 找到 15 个缓存视频
node bin/vidgrab.mjs grab <路径> --frames 3  # 抽帧 + 抽音频
```

实测：`hevc 1280×720 + aac，29.98 秒`，抽出真实画面（含烧录字幕）和 16kHz wav。

**不用播放、没有编码器、秒级、有音频、任意时间点抽帧，而且是只读操作。**

### 感知成本：一个完整任务只花 169 图片 token

| 步骤 | 成本 |
|---|---|
| OCR 读界面（30 行带坐标）| **0 图片 token**（1.9-3.3 秒）|
| 点击 | **0**（视频包数校验，0ms）|
| 等画面稳定 | **0**（灰度传感器，121-182ms）|
| 自动选区域 | **0**（bbox + 热力图）|
| 截一张局部图 544² | **169** |

前面全部免费，只有最后那张图花钱，而且是 1:1 像素。

### 踩过的坑都记下来了

`LIMITS.md` 列了 **做不到的事**；`tests/` 里有 1500+ 行实测记录，
包括**我判断错了、后来自己推翻**的地方。比如：

- 一开始说「视频已经最优」→ 错，有个 60fps 的流被丢掉了
- 说「定时驱动不刷新」→ 错，GIF 素材太短，我采样时它早播完了
- 说「MC 的 GL 坏了」→ 错，是**手机锁屏了**
- 在 README 写「`adb tcpip` 绑回环是优势」→ 错，那会踢掉 Shizuku，已改

---

## 零·四、给 AI 看的操作手册（最重要的一份文档）

**如果你是 AI，读到这里先停下，去读 [docs/OPERATION-PLAYBOOK.md](docs/OPERATION-PLAYBOOK.md)。**

那份手册告诉你：拿到一个操作目标，怎么在 10 秒内判断「能不能做、用什么做、什么时候必须停」。
内容包括：

- **六级风控分类**：零/弱/中/强/极强/特殊，各给代表 App、检测点、推荐方式
- **十二种操作手段**：从 `adb input` 到 deeplink 到缓存读取，各给成本、隐蔽性、适用场景
- **决策树**：不碰 UI 的路优先 → 再按风控等级选方式 → 命中条件就停
- **四个必须停的硬条件**：验证码、异常提示、L3 写操作、第二次触发风控
- **拟人化参数**：点击间隔的对数正态分布、贝塞尔轨迹、微抖动、压力曲线（JSON 格式）
- **诚实边界**：哪 10 个破绽无论怎么拟人化都躲不掉
- **反面案例库**：什么做法一定会翻车

配一份机器可读的等级表 [docs/risk.json](docs/risk.json)（42 个常见 App），可以程序化查询。

**一句话总结那份手册**：
> 系统层必然暴露，所以对强风控目标「不被发现」是伪命题 ——
> 只能选「被发现前做完」或「被发现也不亏」。
> L3 以上（微信/支付/银行）只读，写操作交给人。

---

## 一、这是什么

普通做法是"截图 → 看画面 → 算坐标 → 点屏幕"，慢、容易点偏、还会打断你正在用的应用。

这个项目走另一条路：**造一块不在物理屏幕上显示的虚拟屏**，把 App 投上去，AI 在那上面操作。

| 对比 | 你在看的屏 | 这块屏 |
|---|---|---|
| 用户能看见吗 | 能 | **看不见**（不画在物理屏上） |
| 抢焦点吗 | 是 | **不抢**（`FLAG_OWN_FOCUS`） |
| 抢输入法吗 | 是 | **不抢**（焦点永远留在你的主屏） |
| 能操作哪些 App | — | 任意 App（微信、小红书、游戏、设置…） |
| 你想看的时候 | — | 点胶囊，能看到实时画面 |

实测：AI 在虚拟屏上刷小红书、读评论、翻页，你的主屏一直是你自己的东西，输入法一次都没被抢。

---

## 二、三个包，各管一段

这个仓库有三个包，**分工按"跑在哪个子系统里"划**：

| 包 | 类型 | 干什么 | 装在哪 |
|---|---|---|---|
| `screen/` | Cordis 插件 | 建看不见的虚拟屏、投 App、点击、截图、推流 | profile（给引擎注册工具） |
| `web/` | Cordis 插件 | 用 CDP 操作浏览器：读 DOM、点元素、填表单、截图 | profile（同上） |
| `watch/` | dsh-go 原生插件 | 输入框上方的胶囊 + 点开的画面板 | `$DSH_HOME/dsh-go/plugins/`（画 App 界面） |

**共同点**：三个都做到"AI 在后台干活，不打断你在用的东西"。

- `screen/` 解决**原生 App**（微信、小红书、游戏）——它们没有调试接口，只能投到虚拟屏上操作
- `web/` 解决**网页**——浏览器自带 CDP，直接读 DOM 比截图猜坐标准得多
- `watch/` 是**你的窗口**——想看一眼 AI 在干什么时点它

**为什么 `web/` 放在这个仓库而不是单开一个**：浏览器自动化是很常见的需求，单独开仓库只是多一个地址，没有独立价值。它跟 `screen/` 是同一类东西（都是"后台操作、不抢屏"），放一起更好找。

**为什么 `watch/` 不能和 `screen/` 合并**：App 只认原生插件来画界面，引擎只认 Cordis 插件来注册工具。想实现「AI 在后台干活 + 你能看到」，必须两个都装。

**这三个包就在这里开发，没有另外的独立仓库**。`screen/` 和 `web/` 各自是一份完整可安装的插件包（各自带 `package.json`、`cordis.patch.yml`、`dsh.plugin.json`），profile 里直接 `link:` 到这两个子目录即可。以前它们各自单独开过仓库，结果是两边代码漂移了 74 行——虚拟屏能跑 3D 游戏的那个修复只进了一边。所以合并成一个仓库，一处改一处生效。

### 配套插件：`dsh-go-plugin-adb`

`screen/` 需要一个能连上的 adb。它**不硬依赖** adb 插件——没有的话回退到 `127.0.0.1:5555`；装了的话会自动跟着 adb 插件的端口迁移走（读 `$DSH_HOME/plugin-adb/state.json`）。

| | `dsh-go-plugin-adb` | 本仓库 |
|---|---|---|
| 定位 | 基础设施：给 AI 一个 adb shell | 产品：看得见、可操作的虚拟屏 |
| 依赖方向 | 不依赖本仓库 | 软依赖 adb 插件 |
| 仓库 | 单独公开 | 单独私有 |

**为什么不合并**：依赖是单向的，adb 插件的其他使用者不需要虚拟屏那一套；而且 adb 插件已经有公开身份和自己的收录条目，合并会让它的定位变模糊。装后台屏时建议一起装 adb 插件，端口迁移时更稳。

**`screen/` 和 `web/` 选哪个**：

| 要操作的东西 | 用哪个 |
|---|---|
| 网页（登录、填表、点按钮、读内容） | `web/`，快且准 |
| 原生 App（微信、抖音、小红书、游戏） | `screen/`，投到虚拟屏 |
| 只是抓网页文字（不需要点） | **都不用**，DSH 自带的 `web_fetch` 就够 |

> DSH 自带的 `web_search` / `web_fetch` 只能抓文字，**不能点按钮、不能填表单、不能登录**。要交互才需要 `web/`。

## 三、安装

### 前置条件

1. **adb 可用**（硬依赖，`screen` 所有操作都靠它）
   ```bash
   apt-get update && apt-get install -y android-tools-adb
   adb connect 127.0.0.1:5555
   adb -s 127.0.0.1:5555 shell echo ok   # 返回 ok 才算通
   ```
   连不上就看 [dsh-go-plugin-adb](https://github.com/JMINN0/dsh-go-plugin-adb) 的配对流程。

2. **手机要有 `ADD_TRUSTED_DISPLAY` 权限**
   ```bash
   adb shell dumpsys package com.android.shell | grep "ADD_TRUSTED_DISPLAY: granted=true"
   ```
   有输出才能用。一部分机型没有（Pixel 和部分 Android 15 默认没有），没有就装不了。

3. **`ffmpeg`**（推流时转码用）
   ```bash
   apt-get update && apt-get install -y ffmpeg
   ```

### 装 `screen/`（Cordis 那块）

```bash
git clone https://github.com/JMINN0/dsh-go-second-screen.git
cd dsh-go-second-screen
dsh plugin --profile web add ./screen
```

### 装 `web/`（浏览器控制，可选）

```bash
dsh plugin --profile web add ./web
```

**只在需要操作网页时才装**。它需要浏览器已经在运行（插件不会主动拉起浏览器，避免打断你）。

### 装 `watch/`（原生那块）

```bash
# 必须先放到 dsh-go 插件目录，否则胶囊不会出现（放错不会报错，只是没效果）
mkdir -p "$HOME/.dsh/dsh-go/plugins"
cp -r "$(pwd)/watch" "$HOME/.dsh/dsh-go/plugins/local-screen-watch"
dsh plugin --profile web add ~/.dsh/dsh-go/plugins/local-screen-watch
```

### 装完必须重启引擎

App 内：**设置 → 引擎 → 重启引擎**。

### 验证

```bash
# ① 两个包都进 profile 了吗
python3 -c "
import json
d=json.load(open('$HOME/.dsh/profiles/web/package.json'))
b=d['dsh']['profile']['bundles']
print('screen:', 'dsh-go-plugin-screen' in b)
print('web   :', 'dsh-go-plugin-web' in b)   # 只在装了 web 时检查
print('watch :', 'local-screen-watch' in b)"

# ② 引擎有没有加载错误
grep -i "apply failed" "$HOME/.dsh/dsh-app/diagnostics.md" | grep -E "screen|watch" || echo "没有加载错误 ✅"
```

然后在对话里说一句「用 vdisplay_status 看看虚拟屏状态」，能返回状态就是装好了。
输入框上方应该能看到一条「AI 未操作」的胶囊。

---

## 四、给 AI 的安装提示（如果你是被要求安装本插件的 AI，读这段）

这个仓库里有**两个包，初始位置不对也不要紧，照下面判断**：

| 包 | 特征 | 正确位置 |
|---|---|---|
| `screen/` | `package.json` 里有 `dsh.bundle.patch` | 用 `dsh plugin --profile web add ./screen` |
| `watch/` | `package.json` 里有 `dshGo` 字段 | **必须**放到 `$DSH_HOME/dsh-go/plugins/<名字>/`，再 `dsh plugin add` 那个路径 |

**怎么区分**：看 `package.json` 里有没有 `dshGo` 字段。
- 有 `dshGo` → 原生插件，画界面的，**不能直接 `add` 仓库里的目录**，要先复制到 `dsh-go/plugins/`
- 只有 `dsh` → Cordis 插件，直接 `add` 目录

**装错的表现**：不报错，但胶囊不出现（原生插件没加载）或者 AI 说没有 `vdisplay_*` 工具（Cordis 插件没加载）。

---

## 五、工具清单

| 工具 | 作用 |
|---|---|
| `screen_modes` | 列出可用的操作方式与代价，帮你选 |
| `vdisplay_apps` | 列第三方 App 的包名（投屏前查） |
| `vdisplay_start` | 建一块私有虚拟屏 |
| `vdisplay_launch` | 把 App 投到虚拟屏（先 force-stop，避免顶掉主屏旧任务） |
| `vdisplay_text` | **OCR 读屏，返回文字 + nx/ny 坐标，0 图片 token** |
| `vdisplay_input` | 往虚拟屏注入 tap / swipe / text / key（走 scrcpy 控制通道，带真实压力） |
| `vdisplay_shot` | 截虚拟屏，返回本地图片路径（支持 frames 九格连拍、region 局部放大） |
| `screen_shot_main` | 截主屏（只读），核对有没有影响用户 |
| `vdisplay_status` | 查屏状态、上面跑着什么、主屏焦点 |
| `vdisplay_stop` | 销毁虚拟屏 |
| `vdisplay_stream` | 把画面以 2fps JPEG 推给胶囊（约 0.30 核） |
| `vdisplay_stream_stop` | 停止推流 |

多屏池（实测两块屏可同时跑不同 App，互不干扰）：

| 工具 | 作用 |
|---|---|
| `screen_pool` | 看池里有几块屏、哪块是活动屏 |
| `screen_new` | 建一块新屏，返回 screenId |
| `screen_use` | 切换活动屏（之后所有 `vdisplay_*` 作用在它上面） |
| `screen_close` | 销毁一块屏 |
| `screen_check_app` | 查某个 App 被谁占着（五级：FREE / USER_BG / USER_ACTIVE / AI_HELD / FOREIGN） |
| `screen_claim_app` | 申请占用，冲突时 fail / wait / preempt（**默认 fail，不自动抢**） |
| `screen_release_app` | 释放占用 |
| `screen_leases` | 看所有占用凭证 |

### `web/` 提供八个工具（浏览器控制）

| 工具 | 作用 |
|---|---|
| `web_browser` | 查看或切换目标浏览器（Edge / Chrome / 红魔浏览器，默认 Edge） |
| `web_ensure` | 检查并修复 CDP 通道；默认**不**启动浏览器 |
| `web_open` | 打开标签页，返回 `targetId` |
| `web_read` | 读页面文字（读 DOM，不花图片 token） |
| `web_click` | 按 CSS 选择器或可见文字点击 |
| `web_fill` | 填表单（走 `Input.insertText`，React/Vue 能收到） |
| `web_shot` | 截图 |
| `web_close` | 只关自己开的标签 |

> 浏览器必须已经在跑。插件**不会**主动启动它——你可能刚把它关掉，擅自唤醒会打断你，还会覆盖浏览器的会话恢复记录（这个事故真发生过）。

---

## 六、典型用法

```
1. vdisplay_start {}                                  → displayId=81
2. vdisplay_launch { pkg: "com.xingin.xhs", activity: ".index.v2.IndexActivityV2" }
3. vdisplay_shot {}                                   → /tmp/vd-xxx.png，用 read_image 打开看
4. vdisplay_input { kind: "tap", x: 360, y: 1042 }
5. vdisplay_input { kind: "key", key: "KEYCODE_BACK" }
6. vdisplay_stop {}
```

**要看实时画面**：`vdisplay_stream { fps: 2, width: 360 }`，然后点输入框上方的胶囊。

**操作网页**（用 `web/`，比虚拟屏快得多）：

```
1. web_ensure {}                                          → 通道就绪
2. web_open { url: "https://example.com" }                → targetId: "ABC123"
3. web_read { targetId: "ABC123" }                        → 页面文字
4. web_click { targetId: "ABC123", text: "登录" }
5. web_fill { targetId: "ABC123", selector: "#user", text: "xxx" }
6. web_close {}
```

---

## 6.5、使用建议

**⚠️ 操作期间请保持屏幕常亮**

虚拟屏依赖设备保持唤醒状态。如果设备息屏：
- 虚拟屏会断电，displayId 失效
- 息屏后需要人脸/指纹/密码解锁，AI 无法自动恢复

**如何避免**：正常的点击/滑动/输入操作会自动重置息屏计时器。只要任务在持续执行，设备不会自动息屏。

---

## 七、已知问题（公开了，但还没修完）

| 问题 | 现状 | 影响 |
|---|---|---|
| **打字只对部分 App 有效** | `input text` 在系统设置、标准输入框能用；京东这类自绘输入框注不进去 | 遇到注不进去的，可用 `paste` 输入类型（走剪贴板） |
| **深链不可靠** | 小红书那次 2 次全被系统拦（`SecurityException: not exported`） | 深链只能碰运气 |
| **每次命令行调用会重建屏** | 每个 node 进程自己建屏，进程退出屏就消失 | 只能用长驻进程或插件内调用 |
| **截屏读界面较慢** | 一轮"截图→看图→点击"中位 19.4 秒 | 不适合高频操作 |
| **每张截图约 1.1k tokens** | 且永久留在上下文 | 长任务会吃满上下文 |
| **坐标点击会静默失败** | 已加操作后校验（画面没变返回 `ok:false`），但仍有 17.6% 白点率 | 需要看返回值判断 |
| **只在一台机器验证** | nubia NX809J / Android 16 | 其他机型未测 |

---

## 八、已知限制（不是 bug）

| 限制 | 原因 |
|---|---|
| 需要 `ADD_TRUSTED_DISPLAY` 权限 | 部分机型没有，起不了虚拟屏 |
| 虚拟屏上软键盘不弹 | `display_ime_policy=hide`，为的是不抢你的输入法 |
| 虚拟屏随进程消亡 | 设计如此，不会留垃圾 |
| 读不到别人 App 的 `/data/data` | SELinux 限制（没有 root） |
| 虚拟屏空转约 +0.28 核 | 推流 2fps 再加约 0.02 核 |
| `web/` 浏览器在后台时建不了新标签 | Android 系统限制；插件不会偷偷开窗，会返回 `needsUserConfirm` |
| `web/` 两个 Chromium 浏览器不能同时用 | 它们抢同一个 `chrome_devtools_remote` socket |

---

## 九、原理

```
screen/（Cordis 插件，跑在引擎里）
  ↓ 调 scrcpy-server 的 new_display
DisplayManager.createNewVirtualDisplay(OWN_CONTENT_ONLY | OWN_FOCUS | TRUSTED)
  ↓ 不画在物理屏上、不抢焦点
虚拟屏（displayId 动态）
  ↓ am start --display 投 App，input -d 注入，screencap -d 截图
目标 App

watch/（原生插件，跑在 App 里）
  ← 每 500ms 从 screen 的本地回环 HTTP 取一帧
  → 画在输入框上方胶囊 / 面板里
```

`web/` 是另一条独立链路：

```
web/（Cordis 插件）
  ↓ adb forward tcp:<随机端口> localabstract:chrome_devtools_remote
浏览器进程的 DevTools socket
  ↓ 说 CDP 协议（WebSocket）
读写 DOM、点击、填表、截图 —— 完全不碰屏幕
```

`screen/` 没有用无障碍、也没有用公开 overlay 屏（那个会压屏、吃触摸、抢输入法）。

---

## 十、许可

**本仓库自己的代码是 MIT**（见 [LICENSE](LICENSE)）。商业使用、修改、再分发都允许，
保留版权声明即可。作者不承担任何责任。

**但 `screen/assets/scrcpy-server.jar` 不是我们的代码** —— 它是
[scrcpy](https://github.com/Genymobile/scrcpy) 的 server 端，以 **Apache-2.0** 分发。
所以这个仓库实际是 **MIT + Apache-2.0**，两部分各按自己的条款：

- 我们的代码 → MIT
- `scrcpy-server.jar` → Apache-2.0，全文见 [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0)

如果你想再分发，**两个许可的副本都要带上**。完整说明、上游归属、以及"怎么自己从源码
构建这个 jar 来确认没被改过"，见 **[THIRD-PARTY.md](THIRD-PARTY.md)**。
