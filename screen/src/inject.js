/**
 * inject.js — 通过 scrcpy 控制通道发 INJECT_TOUCH_EVENT，替代 `adb shell input tap`。
 *
 * ## 为什么要换掉 `adb shell input`
 *
 * `input` 那条路的破绽是结构性的，改不动：
 *   · 每次起一个子进程，30-80ms 开销
 *   · 压力恒 1.0（`MotionEvent.obtain(..., pressure=1.0f, size=1.0f, ...)`）
 *   · `getHistorySize()` 恒 0
 *   · `swipe` 的 MOVE 是严格线性等距、间隔 1ms 级 —— 比没有更假
 *   · deviceId 取"第一个支持 TOUCHSCREEN 的设备"，可能挑中某个虚拟触屏
 *
 * scrcpy 的 INJECT_TOUCH_EVENT 不一样：**pressure 是报文里的独立字段**，
 * 服务端原样写进 `MotionEvent.PointerCoords.pressure`，系统不会重算。
 * 路径（上游源码，已核对）：
 *   ControlMessageReader.parseInjectTouchEvent → Controller.injectTouch
 *   → pointer.setPressure → PointersState.update → MotionEvent.obtain
 *   → Device.injectEvent（隐藏 API InputManager.injectInputEvent）
 *
 * ## 报文格式（scrcpy 5.0.1，32 字节定长，全大端）
 *
 *   type            u8   = 2
 *   action          u8   0=DOWN 1=UP 2=MOVE 3=CANCEL
 *   pointerId       i64  BE
 *   x               i32
 *   y               i32
 *   screenWidth     u16
 *   screenHeight    u16
 *   pressure        u16  定点：0xFFFF = 1.0
 *   actionButton    i32
 *   buttons         i32
 *
 * v2.0 起就是这个格式，v3.3.4 / v4.1 / v5.0.1 逐字节一致（v1.25 少 actionButton）。
 *
 * ## 仍然修不掉的（诚实记录）
 *
 *   · deviceId 服务端写死 0 → `InputDevice.getDevice(0)` 可能返回 null
 *   · 接触面积 size 协议里**根本没有这个字段** → PointerCoords.size 恒 0
 *   · x/y 只能是整数
 *   · getHistorySize() 靠 InputDispatcher 合并，客户端控制不了
 *
 * 要连 size 和 history 一起解决，只能自己写 app_process 注入器（照 input 的
 * getInputDeviceId 拿真实触摸屏 id，用 MotionEvent.addBatch 造历史采样）。
 */

const TYPE_INJECT_TOUCH = 2;

export const ACTION = { DOWN: 0, UP: 1, MOVE: 2, CANCEL: 3 };

export const BUTTON_PRIMARY = 1;

/** 压力转定点：0..1 → 0..65535 */
export function toFixedPressure(p) {
  const v = Math.max(0, Math.min(1, Number(p)));
  return Math.round(v * 0xffff) & 0xffff;
}

/**
 * 生成一条 INJECT_TOUCH_EVENT 报文。
 *
 * @param {object} o
 * @param {number} o.action  ACTION.DOWN / UP / MOVE / CANCEL
 * @param {number|bigint} [o.pointerId=0]  0 表示用鼠标指针（单指）
 * @param {number} o.x
 * @param {number} o.y
 * @param {number} o.screenW  必须是虚拟屏的真实宽（**不匹配服务端会静默丢弃**）
 * @param {number} o.screenH
 * @param {number} [o.pressure=1]  0..1
 * @param {number} [o.actionButton=0]
 * @param {number} [o.buttons=0]
 * @returns {Buffer} 32 字节
 */
export function buildTouch(o) {
  const buf = Buffer.alloc(32);
  let off = 0;

  buf.writeUInt8(TYPE_INJECT_TOUCH, off); off += 1;
  buf.writeUInt8(Number(o.action) & 0xff, off); off += 1;

  // pointerId 是 i64。scrcpy 用 -1 表示鼠标指针；这里默认 -1，跟它的约定一致。
  const pid = o.pointerId === undefined ? -1n : BigInt(o.pointerId);
  buf.writeBigInt64BE(pid, off); off += 8;

  buf.writeInt32BE(Math.round(Number(o.x) || 0), off); off += 4;
  buf.writeInt32BE(Math.round(Number(o.y) || 0), off); off += 4;

  buf.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(Number(o.screenW) || 0))), off); off += 2;
  buf.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(Number(o.screenH) || 0))), off); off += 2;

  buf.writeUInt16BE(toFixedPressure(o.pressure === undefined ? 1 : o.pressure), off); off += 2;

  buf.writeInt32BE(Number(o.actionButton) | 0, off); off += 4;
  buf.writeInt32BE(Number(o.buttons) | 0, off); off += 4;

  return buf;
}

/**
 * 生成一次完整点按的报文序列（DOWN → 若干 MOVE → UP）。
 *
 * **压力沿轨迹变化**是这条路的真正价值：`input tap` 只能给恒定的 1.0，
 * 而真实手指按下去时压力是先升后降的。这里按正弦包络模拟。
 *
 * @param {object} o
 * @param {number} o.x
 * @param {number} o.y
 * @param {number} o.screenW
 * @param {number} o.screenH
 * @param {number} [o.holdMs=95]   按下到抬起的总时长
 * @param {number} [o.moves=0]     中间插几个 MOVE
 * @returns {{bufs:Buffer[], totalMs:number}}
 */
export function buildTap(o) {
  const { x, y, screenW, screenH } = o;
  const holdMs = Number(o.holdMs) || 95;
  const moves = Math.max(0, Number(o.moves) || 0);
  const bufs = [];

  // DOWN：压力不是从 1.0 开始，真实触摸是逐渐压实
  bufs.push(buildTouch({
    action: ACTION.DOWN, x, y, screenW, screenH,
    pressure: 0.42 + Math.random() * 0.12,
    actionButton: BUTTON_PRIMARY, buttons: BUTTON_PRIMARY,
  }));

  // 中间 MOVE：压力按正弦包络走（先升后降），坐标带亚像素抖动
  for (let i = 1; i <= moves; i += 1) {
    const t = i / (moves + 1);
    const env = 0.42 + Math.sin(Math.PI * t) * 0.5;          // 0.42 → 0.92 → 0.42
    bufs.push(buildTouch({
      action: ACTION.MOVE,
      x: x + (Math.random() - 0.5) * 1.2,
      y: y + (Math.random() - 0.5) * 1.2,
      screenW, screenH,
      pressure: Math.max(0.2, Math.min(0.95, env + (Math.random() - 0.5) * 0.06)),
      actionButton: BUTTON_PRIMARY, buttons: BUTTON_PRIMARY,
    }));
  }

  // UP：压力已经衰减
  bufs.push(buildTouch({
    action: ACTION.UP, x, y, screenW, screenH,
    pressure: 0.18 + Math.random() * 0.1,
    actionButton: BUTTON_PRIMARY, buttons: 0,
  }));

  return { bufs, totalMs: holdMs };
}

/**
 * 生成一次滑动的报文序列，带**变速**（真人滑动是先加速后减速，不是匀速）。
 *
 * `adb input swipe` 的 MOVE 是严格等距的，这一点在行为统计里很明显。
 *
 * @param {object} o
 * @param {number} o.x1 @param {number} o.y1
 * @param {number} o.x2 @param {number} o.y2
 * @param {number} o.screenW @param {number} o.screenH
 * @param {number} [o.ms=300]
 * @param {number} [o.steps=14]
 * @returns {{bufs:Buffer[], totalMs:number, delays:number[]}}
 */
/**
 * 生成一次「按住」的报文序列（长时间保持按下，手指几乎不动）。
 *
 * ## 为什么需要
 *
 * `swipe` 是「从 A 划到 B」，起点和终点不同。但有两类操作它不是：
 *
 *   ① **游戏虚拟摇杆** —— 按住左下角不放，角色持续行走。摇杆的位移很小
 *      （几十像素内），但必须**持续**送 MOVE，引擎才认为手指还在推。
 *   ② **长按菜单 / 挖方块** —— 按住同一位置一段时间。
 *
 * ## 关键：MOVE 必须够密
 *
 * 实测教训：原来 `buildSwipe` 固定 14 步，300ms 时是 47Hz 还行，
 * 但「按住 5 秒」就退化成 3Hz —— 游戏直接把手指当成没动。
 *
 * 这里按 **60Hz** 出 MOVE（16.7ms 一帧），并且叠一点微小抖动模拟真人手指。
 * 摇杆的抖动不能太大，否则角色会走歪；默认半径 2px 以内。
 *
 * @param {object} o
 * @param {number} o.x @param {number} o.y       按住的位置
 * @param {number} o.screenW @param {number} o.screenH
 * @param {number} [o.ms=1000]    按住多久
 * @param {number} [o.jitter=2]   手指抖动半径（px），0 = 完全不动
 * @param {number} [o.driftX=0]   持续偏移方向 x（摇杆推方向用）
 * @param {number} [o.driftY=0]   持续偏移方向 y
 * @returns {{bufs:Buffer[], totalMs:number, delays:number[]}}
 */
export function buildHold(o) {
  const { x, y, screenW, screenH } = o;
  const totalMs = Math.max(80, Number(o.ms) || 1000);
  const steps = Math.max(2, Math.min(600, Math.round(totalMs / 16.7)));   // ~60Hz
  const jitter = Math.max(0, Number(o.jitter) || 0);
  const driftX = Number(o.driftX) || 0;
  const driftY = Number(o.driftY) || 0;

  const bufs = [];
  // 按下
  bufs.push(buildTouch({
    action: ACTION.DOWN, x, y, screenW, screenH,
    pressure: 0.45 + Math.random() * 0.1,
    actionButton: BUTTON_PRIMARY, buttons: BUTTON_PRIMARY,
  }));

  const delays = [];
  const stepMs = totalMs / steps;
  for (let i = 1; i <= steps; i += 1) {
    // 沿 drift 方向缓慢推过去（摇杆推满需要一点时间），再叠抖动
    const t = i / steps;
    const px = x + driftX * t + (Math.random() - 0.5) * jitter * 2;
    const py = y + driftY * t + (Math.random() - 0.5) * jitter * 2;
    bufs.push(buildTouch({
      action: ACTION.MOVE, x: px, y: py, screenW, screenH,
      pressure: Math.max(0.3, Math.min(0.9, 0.6 + (Math.random() - 0.5) * 0.1)),
      actionButton: BUTTON_PRIMARY, buttons: BUTTON_PRIMARY,
    }));
    // 间隔带一点随机，但不偏离 60Hz 太多
    delays.push(Math.max(8, Math.round(stepMs * (0.85 + Math.random() * 0.3))));
  }

  // 抬起（位置是最后的落点）
  const endX = x + driftX;
  const endY = y + driftY;
  bufs.push(buildTouch({
    action: ACTION.UP, x: endX, y: endY, screenW, screenH,
    pressure: 0.2 + Math.random() * 0.1,
    actionButton: BUTTON_PRIMARY, buttons: 0,
  }));

  return { bufs, totalMs, delays };
}

export function buildSwipe(o) {
  const { x1, y1, x2, y2, screenW, screenH } = o;
  const totalMs = Math.max(60, Number(o.ms) || 300);
  /*
   * **步数必须跟时长匹配，不能固定 14。**
   *
   * 固定 14 步只在 300ms 左右合理（≈47Hz，够用）。
   * 但「按住摇杆 5 秒」时 14 步 = 2.8Hz —— 游戏会当成手指根本没动，
   * 因为触摸帧率掉到个位数，引擎的摇杆采样读不到连续位移。
   *
   * 目标 ~60Hz（16.7ms 一帧），上限 400 步防止极端时长把报文撑爆。
   * 调用方显式传 steps 时以调用方为准。
   */
  const steps = o.steps != null
    ? Math.max(3, Number(o.steps))
    : Math.max(3, Math.min(400, Math.round(totalMs / 16.7)));
  const bufs = [];

  // 缓动：真人手指是"快起 - 匀 - 缓停"，用 easeInOutQuad
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

  bufs.push(buildTouch({
    action: ACTION.DOWN, x: x1, y: y1, screenW, screenH,
    pressure: 0.45 + Math.random() * 0.1,
    actionButton: BUTTON_PRIMARY, buttons: BUTTON_PRIMARY,
  }));

  const delays = [];
  let prevT = 0;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const e = ease(t);
    // 坐标沿缓动曲线走，再叠一点垂直抖动（真人滑动不会完美直线）
    const x = x1 + (x2 - x1) * e + (Math.random() - 0.5) * 1.5;
    const y = y1 + (y2 - y1) * e + (Math.random() - 0.5) * 2.5;
    const p = 0.5 + Math.sin(Math.PI * t) * 0.35;
    bufs.push(buildTouch({
      action: ACTION.MOVE, x, y, screenW, screenH,
      pressure: Math.max(0.25, Math.min(0.95, p + (Math.random() - 0.5) * 0.05)),
      actionButton: BUTTON_PRIMARY, buttons: BUTTON_PRIMARY,
    }));
    // 每步的时间间隔按缓动导数走：中间快、两头慢
    delays.push(Math.max(4, Math.round((t - prevT) * totalMs * (0.6 + Math.random() * 0.8))));
    prevT = t;
  }

  bufs.push(buildTouch({
    action: ACTION.UP, x: x2, y: y2, screenW, screenH,
    pressure: 0.2 + Math.random() * 0.1,
    actionButton: BUTTON_PRIMARY, buttons: 0,
  }));

  return { bufs, totalMs, delays };
}

/* ═══════════════════════════════════════════════════════════════════
 * 多点触控（双指）
 *
 * ## 为什么之前没有
 *
 * `buildTouch` 本来就带 pointerId 字段，但一直只发单指。
 * 游戏里双手操作（一边走一边转视角、双指缩放、同时按两个技能）
 * 全都需要两指同时按下。
 *
 * ## **关键：不要自己编码 ACTION_POINTER_DOWN**
 *
 * 第一版我按 Android 的约定把 index 编进 action 高 8 位（5 | 1<<8 = 261），
 * 结果设备报 `InputDispatcher: Inconsistent event`。
 *
 * 反编译 scrcpy-server 的 classes.dex（baksmali 到 smali）后看到真相：
 *
 *   :cond_8c                        # action == UP 且还有其他指针
 *       shl-int/lit8 v1, v10, 0x8   #   action = (pointerIndex << 8)
 *       or-int/lit8  v1, v1, 0x6    #   action |= 6  → ACTION_POINTER_UP
 *   :cond_93                        # action == DOWN 且还有其他指针
 *       shl-int/lit8 v1, v10, 0x8   #   action = (pointerIndex << 8)
 *       or-int/lit8  v1, v1, 0x5    #   action |= 5  → ACTION_POINTER_DOWN
 *
 * **scrcpy 服务端自己算 index 并 OR 上 5/6。**
 * 我们只要发基础 action（0=DOWN / 1=UP / 2=MOVE），它负责转换。
 * 自己编码反而被截断成 5，scrcpy 收到不认识的值 → 事件被丢。
 *
 * ## 序列（全部用基础 action）
 *
 *   指0 DOWN(0)   pointerId=0
 *   指1 DOWN(0)   pointerId=1   ← scrcpy 自动转成 POINTER_DOWN
 *   两指 MOVE(2)  各发一条
 *   指1 UP(1)     pointerId=1   ← scrcpy 自动转成 POINTER_UP
 *   指0 UP(1)     pointerId=0
 */

export const ACTION_MULTI = {
  DOWN: 0, UP: 1, MOVE: 2, CANCEL: 3,
  POINTER_DOWN: 5, POINTER_UP: 6,
};

/** 把「第几指」编进 action。 */
function withIndex(action, index) {
  return (action | (index << 8)) & 0xffff;
}

/**
 * 生成双指手势的报文序列。
 *
 * @param {object} o
 * @param {{x:number,y:number}} o.p1 第一指（比如摇杆位置）
 * @param {{x:number,y:number}} o.p2 第二指（比如视角滑动起点）
 * @param {{x:number,y:number}} [o.p2To] 第二指的终点（滑动）
 * @param {number} o.screenW
 * @param {number} o.screenH
 * @param {number} [o.ms=600] 总时长
 * @param {number} [o.p1DriftX=0] 第一指期间横向漂移
 * @param {number} [o.p1DriftY=0] 第一指期间纵向漂移
 * @param {boolean} [o.releaseP1=true] 结束时抬不抬第一指
 */
export function buildMultiTouch(o) {
  const { p1, p2, p2To, screenW, screenH } = o;
  const totalMs = Math.max(120, Number(o.ms) || 600);
  const steps = Math.max(4, Math.min(240, Math.round(totalMs / 16.7)));  // ~60Hz
  const driftX = Number(o.p1DriftX) || 0;
  const driftY = Number(o.p1DriftY) || 0;
  const to = p2To || p2;
  const bufs = [];
  const delays = [];

  const P1 = 0n, P2 = 1n;          // pointerId
  const btn = BUTTON_PRIMARY;

  // ① 第一指按下
  bufs.push(buildTouch({
    action: ACTION.DOWN, x: p1.x, y: p1.y, screenW, screenH,
    pointerId: P1, pressure: 0.45, actionButton: btn, buttons: btn,
  }));
  delays.push(30);

  // ② 第二指按下（ACTION_POINTER_DOWN，index=1）
  bufs.push(buildTouch({
    action: ACTION.DOWN, x: p2.x, y: p2.y, screenW, screenH,   // scrcpy 自动转 POINTER_DOWN
    pointerId: P2, pressure: 0.45, actionButton: btn, buttons: btn,
  }));
  delays.push(30);

  // ③ 两指同时 MOVE
  const frameMs = Math.max(8, Math.round(totalMs / steps));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    // 第一指：缓慢漂移（摇杆推方向）
    const x1 = p1.x + driftX * t + (Math.random() - 0.5) * 2;
    const y1 = p1.y + driftY * t + (Math.random() - 0.5) * 2;
    // 第二指：从 p2 线性走到 p2To（转视角）
    const x2 = p2.x + (to.x - p2.x) * t;
    const y2 = p2.y + (to.y - p2.y) * t;
    const env = 0.45 + Math.sin(Math.PI * t) * 0.45;
    bufs.push(buildTouch({
      action: ACTION.MOVE, x: x1, y: y1, screenW, screenH,
      pointerId: P1, pressure: env, actionButton: btn, buttons: btn,
    }));
    bufs.push(buildTouch({
      action: ACTION.MOVE, x: x2, y: y2, screenW, screenH,
      pointerId: P2, pressure: env, actionButton: btn, buttons: btn,
    }));
    delays.push(frameMs);
  }

  // ④ 第二指抬起（ACTION_POINTER_UP，index=1）
  bufs.push(buildTouch({
    action: ACTION.UP, x: to.x, y: to.y, screenW, screenH,   // scrcpy 自动转 POINTER_UP
    pointerId: P2, pressure: 0.3, actionButton: 0, buttons: 0,
  }));
  delays.push(30);

  // ⑤ 第一指抬起
  if (o.releaseP1 !== false) {
    bufs.push(buildTouch({
      action: ACTION.UP, x: p1.x + driftX, y: p1.y + driftY, screenW, screenH,
      pointerId: P1, pressure: 0.2, actionButton: 0, buttons: 0,
    }));
  }

  return { bufs, delays, totalMs };
}
