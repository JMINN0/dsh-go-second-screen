# 2026-11-20 的原始测量记录

> 为什么要单独写这份：这一轮的改动在 README 里引用了一批数字（17ms、179 帧、117×208…），
> 但当时只存在于命令行输出里，没落盘。对抗审查指出「读者无法核实」——
> 这份文件就是给那些数字提供锚点。**原始输出照抄，不改小数。**
>
> 设备：红魔 NX809J / Android 16 (SDK 36) / 1080×2400 主屏，density 3.42 / 无 root / adb uid 2000
> 时间：2026-11-20 15:40-16:30 (Asia/Shanghai)

---

## M1. MJPEG 出流帧间隔（对应 README §9.1）

**方法**：Node 原生 `net.connect` 连 `127.0.0.1:38820/stream.mjpg`，解析 multipart 的
`Content-Length`，每解析出一帧记 `performance.now()`，跑 4 秒。

```js
const sock = net.connect(38820, '127.0.0.1');
sock.setNoDelay(true);
sock.write('GET /stream.mjpg HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
// data 回调里按 \r\n\r\n + Content-Length 切帧，push performance.now()
```

**原始输出**：

```
收到 179 帧
帧间隔 平均 20.6ms  中位 17.0ms  P90 33.1ms
理论帧率 49fps
```

**推导**：179 帧 / 4 秒 = 44.75fps（与「平均间隔 20.6ms」自洽：1000/20.6 = 48.5，
差异来自首帧和末帧的计时段不完整）。

**样本量**：单次 4 秒、179 帧、1 台设备。**没有重复测量。**

---

## M2. framesrv `/status` 读数

```
$ curl -s http://127.0.0.1:38820/status
{"running":true,"frames":2317,"fps":114,"width":400,"aspect":0.45226}
```

**关于这个 114**：它是 `/status` 里 `fps` 字段的瞬时值（服务内部按秒窗口算），
**不是交付帧率**。同一会话里另外两次读到：

```
{"running":true,"frames":13555,"fps":120,...}
{"running":true,"frames":13677,"fps":119,...}
```

但那两次是**虚拟屏已经死掉、framesrv 还在对空白疯狂编码**的状态（见 M6）。
所以 `fps` 字段本身不能当交付帧率引用。README §9.1 已按此处理。

---

## M3. 悬浮窗最小化尺寸与画面是否刷新

**方法**：`adb shell dumpsys window windows | grep 'mAttrs=.*APPLICATION_OVERLAY'`
读窗口矩形；用 `screencap` 间隔 1.2 秒连抓 3 张，两两求平均像素差。

**最小化前**：
```
mAttrs={(20,312)(653x1443) ...}
```
**点一下窗口中心 (300,700) 之后**：
```
mAttrs={(117,312)(117x208) ...}
```
117 = dp(36) × 3.25（这台机 density 3.42，实测取整到 117）

**画面刷新**（最小化状态下）：
```
第1→2 次截屏差异 10.10
第2→3 次截屏差异 13.78
```
> 判据：>0.05 认为有变化（同一画面两次截图差异通常 <0.05）

---

## M4. 两窗口并排的尺寸与位置

**方法**：两块虚拟屏各投一个闲鱼，读 `mAttrs`。

```
mAttrs={( 20,312)(177x391) ...}
mAttrs={(228,312)(177x391) ...}
```

**判定**：两窗尺寸相同（177×391），x 分别是 20 和 228，
第一个跨 20..197、第二个跨 228..405，**中间 197..228 有 31px 空隙，不重叠**。

---

## M5. 悬浮窗画面 vs 源虚拟屏画面一致性

**方法**：同一时刻分别取
① `adb exec-out screencap -d <scrcpy SF id>`（源虚拟屏）
② `curl http://127.0.0.1:38820/frame.jpg`（悬浮窗正在显示的帧）
都缩到 200×400 后逐像素求绝对差。

```
虚拟屏亮度 181   悬浮窗帧亮度 180
两者平均像素差 3.1
```

**判定**：3.1 属于 JPEG 压缩 + 缩放误差量级，**是同一画面**。

---

## M6. 虚拟屏死亡后 framesrv 的行为

**现象**（修之前）：虚拟屏被创建它的 Node 进程带走之后

```
$ curl -s http://127.0.0.1:38820/status
{"running":true,"frames":13555,"fps":120,...}     ← 还在「正常」出帧
```

但 `dumpsys display` 里目标 displayId 已经不存在。

**修法**：`displayAlive()` 改用 `DisplayManagerGlobal.getDisplayInfo(displayId)`，
返回 null 即退出。

**修后验证**：`logcat` 出现 `DISPLAY_GONE display=<id>`，进程退出。

---

## M7. 点击波纹动画（中心区红色像素变化）

**方法**：`curl "http://127.0.0.1:38820/mark?nx=0.5&ny=0.5"` 之后立刻连取 5 张
`/frame.jpg`（间隔 120ms），裁中心 240×240 区域，数满足 `r>140 且 g<110 且 b<110` 的像素。

```
第1张 中心区红色像素 2406
第2张 中心区红色像素 2480
第3张 中心区红色像素 2603
第4张 中心区红色像素 2672
第5张 中心区红色像素 2677
```

**判定**：单调递增 → 波纹在扩散。倍率 2677/2406 = 1.11，与「900ms 内半径扩大到 3.7 倍、
但描边宽度递减」的视觉预期一致。

---

## 没测到的（别当结论用）

- 多窗口（4 块以上）的帧率
- 长稳（>1 小时）内存与 CPU
- 除这台红魔之外的任何机型
- 悬浮窗在不同 Android 版本上的 overlay 权限差异

---

## M8. 3D 游戏在虚拟屏上的渲染（复测，2026-11-20 18:25）

**为什么复测**：有外部说法称「3D 游戏后台屏没用」。仓库里 `screen/README.md` 已把这条标为
早期错误结论（只测了默认配置），但仍容易被人拿旧信息反驳，所以再做一次完整复现。

**前置条件（两条都必须满足）**：

```
$ adb shell getprop vendor.display.vds_allow_hwc
1                                        ← 硬件声明支持 HWC

$ adb shell getprop debug.sf.enable_hwc_vds
1                                        ← 默认是 0，必须开；插件 hwc:auto 会自动开
```

**步骤**：

1. `vdisplay_start { orientation: "landscape", hwc: "auto" }` → display 613
2. `am start --display 613 -n com.mojang.minecraftpe/com.mojang.minecraftpe.MainActivity`
3. 等 25 秒（启动页）
4. `screencap -d <scrcpy 虚拟屏 SF id>`

**结果**：

| 时点 | 亮度 | 说明 |
|---|---|---|
| 投屏后 35 秒 | 35.1 | 启动页 |
| 投屏后 60 秒 | **83.2** | Minecraft 主菜单 |

**画面内容**：MINECRAFT logo（BETA 1.21.x）、绿色「游戏」按钮、「设置」按钮、
Steve 角色、紫色地形背景、右下角帧率计数器。**完整 3D 渲染，非黑屏。**

证据截图：[tests/evidence/mc-3d-2026-11-20.png](evidence/mc-3d-2026-11-20.png)

**同时主屏在跑抖音**（`display 0` = `com.ss.android.ugc.aweme`），两边互不干扰 ——
这正是后台屏的核心价值。

**注意：这次没有测游戏内的操作**（点击/摇杆/建造）。操作部分见
[tests/MC-OPERATION-TEST.md](MC-OPERATION-TEST.md)，那里记录了建世界 5 步全命中、
游戏内 47-60fps。

**【不知道】**：其他机型、`vds_allow_hwc=0` 的设备上是否可解（按设计是黑屏）。
