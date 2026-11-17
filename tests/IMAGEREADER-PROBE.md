# ImageReader 镜像取帧：探针实测成功

> 2026-11-18。**这是实测，不是推算。**

## 结论

**能把虚拟屏镜像进 ImageReader，动态内容下 67 fps（15ms/帧）。**

对比现在的 `screencap` 143ms/帧 —— **快 9.5 倍**。

## 实测数据

探针程序：`probe/src/com/dsh/probe/Probe.java`（131 行）

```java
// 关键调用：反射 @hide 方法
Method m = DisplayManager.class.getDeclaredMethod("createVirtualDisplay",
        String.class, int.class, int.class, int.class, Surface.class);
m.setAccessible(true);
vd = (VirtualDisplay) m.invoke(null, "dsh-probe", W, H, displayId, imageReader.getSurface());
```

| 测试 | display | 时长 | 回调数 | 说明 |
|---|---|---|---|---|
| **主屏对照** | 0 | 3s | 26 | 8.7fps（主屏当时静止）|
| **虚拟屏静止** | 405 | 4s | **1** | 不变化就不出帧 |
| **虚拟屏动画** | 405 | 4s | **269** | **67 fps** ✅ |

`firstMean=76`（主屏）/ `24`（虚拟屏）—— **都不是黑屏，是真实内容。**

## 三个关键发现

### ① 权限是够的

```
CAPTURE_VIDEO_OUTPUT:      granted=true
READ_FRAME_BUFFER:         granted=true
ACCESS_SURFACE_FLINGER:    granted=true
```

2021 年 scrcpy issue #2242 说 shell 没有 `CAPTURE_VIDEO_OUTPUT` —— **在这台机器上不成立**。

### ② 镜像虚拟屏可行

AOSP 里 `DisplayManager.createVirtualDisplay(name,w,h,displayIdToMirror,surface)`
是 `@hide @SystemApi`，需要 `CAPTURE_VIDEO_OUTPUT`。
已知反例是 issue 268268869「mirroring to multiple virtual displays is not working」——
**这台设备上没有这个问题。**

### ③ ImageReader 是「事件驱动」的，不是轮询

**静止时几乎不出帧（4 秒 1 帧），动起来能到 67fps。**

这比轮询更好：
- 静止时零成本（不用重复截同一张图）
- 变化时立刻出帧（延迟 ≈ 1 vsync + 拷贝 ≈ 17-20ms）

## 延迟推算

```
内容变化 → SF 合成到镜像 Surface    0-16.7ms（平均 8.3）
合成 → ImageReader 回调             0.2-1ms
回调内 32×32 采样                    0.2-0.3ms
──────────────────────────────────
p50 ≈ 10ms，p95 ≈ 20ms
```

对比现在 `screencap` 143ms —— **快 7-14 倍**。

## 怎么复现

```bash
# 1. 编译
cd probe
javac -source 8 -target 8 -cp ../tools/sdk/android-30.jar -d build/classes src/com/dsh/probe/Probe.java
java -cp ../tools/sdk/r8.jar com.android.tools.r8.D8 --min-api 26 --release \
  --lib ../tools/sdk/android-30.jar --output build/ build/classes/com/dsh/probe/*.class

# 2. 推上去
adb push build/classes.dex /data/local/tmp/dshprobe/probe.dex

# 3. 跑（displayId 从 vdisplay_start 拿）
adb shell "CLASSPATH=/data/local/tmp/dshprobe/probe.dex app_process / com.dsh.probe.Probe --display=405 --ms=4000"
```

## 下一步：把它做成常驻服务

探针验证了可行性。要真正用起来需要：

1. **常驻 app_process 进程**（现在跑完就退）
2. **通过 LocalSocket 把帧/传感器数据传给 Node**
   - 协议：`S` 开头推 32×32 传感器包（1KB，供变化检测）
   - `J` 请求返回一帧 JPEG
   - `C` 请求返回裁剪区域（OCR 用）
3. **处理旋转**：源屏一转，镜像会重建，要监听 `DisplayManager.DisplayListener` 重新 setSurface
4. **背压**：回调里只许「采样 + close」，重活挪到别的线程；`maxImages=2`

## 已知风险

1. **HWC 冲突**：仓库里为了 3D 游戏不出黑屏开了 `debug.sf.enable_hwc_vds=1`。
   ImageReader 给的是 CPU 可读 buffer，HWC 未必愿意合成进去 —— **3D 游戏可能重新变黑**，需要专门测。
2. **内存**：1592×720×4 = 4.37MB/块，2 块 = 8.7MB（Gralloc，不占 Java heap）。
3. **多一块镜像屏**会让源屏每帧多一次合成（1.15Mpx，估 1-3ms），可能让 3D 游戏掉帧。
