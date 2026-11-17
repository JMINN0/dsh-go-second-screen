# 常驻取帧服务（ImageReader）

**76 fps，对比 screencap 的 2.5 fps —— 快 30 倍。**

## 为什么需要它

`screencap` 每次都要做一次完整的 Surface 回读，实测：

| 环节 | 耗时 | 说明 |
|---|---|---|
| **Surface 回读（裸 RGBA）** | **141ms** | ← 不可优化的固有开销 |
| PNG 编码 | +98ms | 裸截图 141ms → PNG 239ms |
| 传输 4.37MB | 71ms | 走 adb 回环 |

**总共 227-243ms/帧 = 2.5fps。** 那个 141ms 的回读是 screencap 的工作方式决定的，改不了。

`ImageReader` 从合成器**直接拿 buffer**，没有回读开销：

```
实测（虚拟屏 720×1592）：
{"running":true,"frames":182,"fps":76,"width":400,"aspect":0.452}
/frame.jpg: HTTP 200, 35KB, 2.6ms
```

## 架构

```
虚拟屏（scrcpy 建的，用户看不见）
    ↓ 反射 DisplayManager.createVirtualDisplay(name,w,h,displayIdToMirror,surface)
ImageReader（本进程，直接从合成器拿帧）
    ↓ 本进程自己 serve HTTP（不经 Node 中转）
Overlay APK / 胶囊 / 任何 HTTP 客户端
```

**关键设计**：服务自己当 HTTP 服务器，所以 Overlay 直接连它，延迟链最短。

## 端点

| 路径 | 说明 |
|---|---|
| `/frame.jpg` | 当前帧（JPEG，35KB）|
| `/status` | `{"running":true,"frames":N,"fps":76,"width":400,"aspect":0.452}` |
| `/stream.mjpg` | MJPEG 长连接 |
| `/quit` | 退出 |

## 用法

```bash
# 1. 编译
cd framesrv
javac -source 8 -target 8 -cp ../tools/sdk/android-30.jar -d build/classes src/com/dsh/framesrv/Main.java
java -cp ../tools/sdk/r8.jar com.android.tools.r8.D8 --min-api 26 --release \
  --lib ../tools/sdk/android-30.jar --output build/ build/classes/com/dsh/framesrv/*.class

# 2. 推上去
adb push build/classes.dex /data/local/tmp/dshframe/frame.dex

# 3. 跑（displayId 从 vdisplay_start 拿）
adb shell "CLASSPATH=/data/local/tmp/dshframe/frame.dex app_process / \
  com.dsh.framesrv.Main --display=417 --port=38820 --width=400 --size=720x1592"
```

## 已知问题

1. **JPEG 编码在回调里** —— 会拖慢回调，可能触发背压。应该挪到单独线程。
   实测 76fps 还够用，但高负载场景要改。
2. **旋转没处理** —— 源屏一转，镜像会重建，还没监听 `DisplayManager.DisplayListener`。
3. **进程死了帧就没了** —— 还没做自愈重启。
4. **HWC 冲突未验证** —— 3D 游戏可能因为开 HWC 而黑屏，需要专门测。

## 关键前提（实测）

```
android.permission.CAPTURE_VIDEO_OUTPUT:   granted=true
android.permission.READ_FRAME_BUFFER:      granted=true
android.permission.ACCESS_SURFACE_FLINGER: granted=true
```

2021 年 scrcpy issue #2242 说 shell 没有 `CAPTURE_VIDEO_OUTPUT` —— 在这台机器上不成立。
