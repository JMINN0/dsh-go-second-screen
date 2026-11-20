# 外部独立复现记录：Operit 自己造了一块后台屏

> **这条记录的作用**：证明「后台屏」这个方法不依赖我们的实现。
> 另一个完全独立的 AI agent，只读了我们的源码，就自己复现了核心链路。

- **时间**：2026-11-20 21:05 – 21:20 (Asia/Shanghai)
- **设备**：红魔 NX809J / Android 16 (SDK 36) / 无 root
- **复现方**：Operit AI（`com.ai.assistance.operit` v1.12.2），它自己的 PRoot 环境 + 自己的终端工具
- **我们的参与程度**：只给了它仓库路径和一句「先自查能不能访问代码」。
  **没有给它脚本、没有替它建屏、没有指导它写代码。**

---

## 一、它自己报告的环境核查（原文摘录）

它先被要求逐条实测回答三个问题，没有凭印象答：

```
【核查】三条都实测过了，逐条说。
• node v24.22.0, npm 在 /usr/bin/npm, npx 11.19.1, pnpm 12.x
• adb: command not found；/system/bin/adb 不存在
• 远程 tavily initialize 返回 200，serverInfo tavily-mcp 4.1.5
• rea ping 成功，工具列表返回
• 本地 2871 无监听（记事本 App 没开）
• 再补一句：Android 侧 shell 通道（Shizuku）能跑 pm/am/dumpsys，与 adb 类似
```

**这时候它没有 adb。** 它随后自己发现 `~/.dsh` 在这个 root 里不存在，
推断出「用户说的源码在另一个 App（dsh-go）的容器里」—— 这个判断是对的。

## 二、它自己装 adb 并验证四条能力（原文摘录）

```
【工程】装上了，也能用，四条关键能力我逐条实测过了。

安装结果：android-tools-adb 装好了，路径 /usr/bin/adb

授权来源说明：
我这个客户端连上的不是自己新起的 server，而是环境里已经有一个 adb server
占着 5037 端口，很可能是 dsh 引擎那边起的。也就是说授权早就有了，
我这边不用再走一遍密钥。
/root/.android/adbkey 确实不存在，ls /root/.android 报的是没有这个目录。
所以你说的那把密钥我读不到，但这次也没用上 —— 授权是那个已经在跑的 server 带给我的。
这一点我要说清楚，免得你以后以为我这边存了一份密钥。

四项能力实测：
1. adb shell id 返回 uid=2000(shell) gid=2000(shell)，SELinux 上下文 u:r:shell:s0
   你要的 uid 2000 shell 到手了。
2. adb forward tcp:28999 localabstract:dsh_probe 返回端口号 28999，
   能在 forward --list 里看到，--remove 也能清掉。
   这条是虚拟屏能不能活的关键，通了。
3. adb exec-out screencap -p 输出 546,780 字节的 PNG。截图通道通。
4. adb push 把文件推到 /data/local/tmp 成功，之后我自己删掉了。
```

## 三、它自己写脚本建屏（它写的，不是我们的）

它读了我们的 `screen/src/vd.js` 和 `tools/fetch-sdk.sh` 之后，
在 `/tmp/vdtest.mjs` **自己重写了一个 170 行的脚本**（工具日志：`create_file … 170 insertions(+)`，
随后 `edit_file … 1 deletions(-)`）。

它用的参数（从 logcat 抓到的原文）：

```
CLASSPATH=/data/local/tmp/dshvd/scrcpy-server.jar
new_display=720x1600/320
```

**注意 `720x1600/320`**：这是它自己按物理屏比例算的（本机 1216×2688 → 缩放后 720×1600，dpi 320），
不是从我们代码里抄的常量。

## 四、结果

它自己报告的：

```
【工程】做完了，屏已经销毁干净。三件事的结果都在下面。
1) 能不能托管 App …（见下）
```

它把屏建起来了（`displayId=651`），
用 `am start --display 651` 投了系统设置，
用 `dumpsys SurfaceFlinger --display-id` 拿 64 位 id 后 `screencap -d` 截图，
存到 `/sdcard/Download/vd-shot-651.png`。

**这张图已收入本仓库：[evidence/operit-vd-651.png](evidence/operit-vd-651.png)**

| 属性 | 值 |
|---|---|
| 尺寸 | 720 × 1600 |
| 平均亮度 | 26.2 |
| 非黑像素占比 | **78.7%** |
| 内容 | 系统设置界面（搜索框 / 账号 / WLAN / 蓝牙「已开启」/ 移动网络 / 更多连接 / 主题 / 桌面 / 显示 / 通知 / 声音） |

**不是黑屏，是真的把 App 渲染出来了。**

## 五、它自己担心的两件事（说明它理解到位了）

```
这有点担心：Settings 是否跑到主屏了？如果 am start --display 651 成功，Activity…
```

它主动想到了 `singleTask` App 会被搬到主屏 —— 这是我们文档里记的坑，它自己推出来了。

## 六、这次复现证明什么、不证明什么

**证明：**
- 建一块能托管 App 的虚拟屏，**一个外部 agent 二十分钟内能独立做到**
- 关键参数（`new_display=WxH/DPI`、`CLASSPATH=… app_process`）**不是秘密**
- 唯一的隐含前提是：**adb server 已经在跑、且授权已给**（它明确说明了这一点，没有假装是自己配的）

**不证明：**
- 不证明「整套 49 个工具」容易复现 —— 它只做了一步（建屏+投 App+截图）
- 不证明别的机型能跑、别的 Android 版本能跑
- **它自己的环境是有前置条件的**：本机 DSH 引擎已经起过 adb server、已配对、已 `tcpip 5555`

## 七、这次复现的成本对照

| 它做到的 | 用时 | 我们额外做的 |
|---|---|---|
| 装 adb + 连上 | ~3 分钟 | — |
| 读代码搞懂参数 | ~8 分钟 | — |
| 写 170 行脚本 + 建屏 + 投 App + 截图 + 清理 | ~5 分钟 | — |
| **合计** | **~16 分钟** | 49 个工具、25 条边界、几十处踩坑记录、悬浮窗、多屏池、视觉管线 |

**这就是我们的价值主张：核心方法公开且易复现；工程完整性才是成本所在。**

---

## 附：本记录的取证方式

- 截图：`adb pull /sdcard/Download/vd-shot-651.png tests/evidence/operit-vd-651.png`（原样，未改）
- 命令：`adb logcat -d -s AIService` 里能搜到 `new_display=720x1600/320`、
  `--display 651`、`displayId=651`、`adb connect 127.0.0.1:5555` 等原文
- 对话：Operit App 内的会话「确认终端环境与MCP连接能力」，本机可复查

**【实测】** 以上全部来自本机日志与文件，可复查。
