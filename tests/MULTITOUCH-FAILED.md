# 多点触控：从失败到成功 —— 完整记录

> **2026-11-19 晚更新：已修复。** 下面保留失败过程，因为根因很有价值。

## 根因（反编译 scrcpy 的 classes.dex 得到）

用 baksmali 反编译 `screen/assets/scrcpy-server.jar` 里的 `classes.dex`，
在 `com/genymobile/scrcpy/control/Controller.smali` 里看到真相：

```
:cond_8c                        # action == UP 且还有其他指针
    shl-int/lit8 v1, v10, 0x8   #   action = (pointerIndex << 8)
    or-int/lit8  v1, v1, 0x6    #   action |= 6   ACTION_POINTER_UP

:cond_93                        # action == DOWN 且还有其他指针
    shl-int/lit8 v1, v10, 0x8   #   action = (pointerIndex << 8)
    or-int/lit8  v1, v1, 0x5    #   action |= 5   ACTION_POINTER_DOWN
```

**scrcpy 服务端自己算 pointer index，并 OR 上 ACTION_POINTER_DOWN/UP。**
我们只要发基础 action（0=DOWN / 1=UP / 2=MOVE），不要自己编码 index。

## 之前为什么失败

第一版按 Android 的约定把 index 编进 action 高 8 位：`5 | (1 << 8) = 261`。
但 scrcpy 协议里 action 只有 1 字节，`261 & 0xff = 5` —— **index 被截掉**，
scrcpy 收到 5（它不处理这个值，它自己会生成）→ 事件自相矛盾 → 被丢。

## 修复后实测

```
双指 600ms → 76 帧
Inconsistent event: 0    （之前每次都有）
Dropping event:     0    （之前 4 次）
窗口：com.android.settings/.Settings 在前台
```

## 教训

我当时把失败归给「平台限制」，但**能回答这个问题的物证（scrcpy 自己的字节码）
一直躺在仓库里**（`screen/assets/scrcpy-server.jar`）。
`baksmali d classes.dex` 两条指令就给出了答案。

---

# 原始失败记录（保留）

> 2026-11-19。**这是失败记录，不是能力说明。** 记下来避免下次重踩。

## 做了什么

在 `inject.js` 里加了 `buildMultiTouch`，在 `vd.js` 的 `input()` 里加了 `kind: 'multitouch'` 分支。
按 Android 的标准多指序列发：

```
指0 DOWN(0)         pointerId=0
指1 DOWN(5|1<<8)    pointerId=1     ← index 编码在 action 高 8 位
两指 MOVE(2) × N
指1 UP(6|1<<8)
指0 UP(1)
```

## 实测结果：**失败**

发送成功（`ok:true，100 帧`），但设备侧：

```
E InputDispatcher: Inconsistent event: MotionEvent {
    action=POINTER_DOWN(0), id[0]=0, x[0]=144, y[0]=1115, id[...]
```

**三个问题，每个都足以让它不工作**：

### ① action 是 UInt8，index 编不进去

```js
// inject.js 里写的是：
buf.writeUInt8(Number(o.action) & 0xff, off);
```

我把 index 编进高 8 位：`5 | (1 << 8) = 261`。
`261 & 0xff = 5` —— **index 被截掉了**。

**scrcpy 协议里 action 只有 1 字节，传不了 index。**
scrcpy 服务端自己用 `PointersState` 算 index，所以应该**只发基础 action**，让它自己算。

### ② POINTER_DOWN 事件里只有 1 个指针

```
id[0]=0        ← 只有第一指，没有第二指
```

`ACTION_POINTER_DOWN` 的语义是「又有一个手指按下了」，事件必须**同时包含新旧两个指针**。
scrcpy 只给了 1 个 → InputDispatcher 判为 inconsistent → 丢弃。

### ③ 坐标用了错的屏幕尺寸

```
x[0]=144  = 0.2 × 720
y[0]=1115 = 0.7 × 1592
```

而我们建的屏是**横屏 1592×720**。说明 `state.width/height` 拿的是竖屏值。

可能的原因：`state.width/height` 是建屏时的初始声明（竖屏），
App 强制横屏后实际是 1592×720，但 `state` 没更新 ——
这正是 `refreshRealSize()` 要解决的事，**误诊更正**：refreshRealSize() 在 input() 顶部无条件执行（不是多指分支漏调）。真实原因是它自己的 grep 匹配太脆，失败时静默保留竖屏旧值。

## 结论

**多点触控当前不可用。** 代码保留但**必须在工具描述里说明未验证**，
不能让它看起来能用（否则模型会去用，然后失败还找不到原因）。

## 下次怎么试（如果还要做）

1. **只发基础 action（0/1/2/5/6），不编码 index** —— 让 scrcpy 自己算
2. **先调 `refreshRealSize()` 拿真实尺寸**，再用它换算 nx/ny
3. **验证手段**：`adb logcat | grep "Inconsistent event"` ——
   如果没有这条错误，才算事件被接受
4. 如果不通，**换一条路**：`adb shell input` 不支持多指，
   但 **`sendevent` 直接写 /dev/input/eventX** 可以（需要 root 或 shell 权限）
5. 或者：**用 scrcpy 的 UHID 模式**（`--uhid`）注册虚拟触摸设备，
   走的是内核输入栈，多指天然支持 —— 但需要 root

## 诚实的现状

| 能力 | 状态 |
|---|---|
| 单指 tap/swipe/hold | ✅ 实测可用 |
| **双指 multitouch** | ❌ **代码在，事件被设备拒绝** |
| 双指缩放/双手操作 | ❌ 不可用 |
