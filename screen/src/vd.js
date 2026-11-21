/**
 * vd.js — 私有虚拟屏（headless virtual display）的核心。
 *
 * 原理：用 uid 2000 调 scrcpy-server 的 `new_display`，它走
 * DisplayManager.createNewVirtualDisplay，带回这些标志：
 *   FLAG_OWN_CONTENT_ONLY  内容不跟主屏同步（不是镜像）
 *   FLAG_OWN_FOCUS         不抢主屏焦点（Android 14+ 才有）
 *   FLAG_TRUSTED / FLAG_OWN_DISPLAY_GROUP / FLAG_PRESENTATION …
 * 关键：**没有 FLAG_PUBLIC**，所以这块屏不画在物理屏幕上，用户完全看不见。
 *
 * 四个实测坑（都会让人白折腾半天）：
 * 1. socket 名是 `scrcpy_<scid>`，**有下划线**。写成 scrcpy<scid> 会连不上，
 *    server 卡在 accept 不建屏，日志只打到 "Device:" 那一行。
 * 2. screencap -d 要的是 SurfaceFlinger 的 64 位 display id，不是逻辑 displayId。
 *    传逻辑 id 会报 "Display Id '64' is not valid"；不带 -d 就截到主屏，
 *    于是看起来像"这块屏在镜像主屏"，其实是截图截错了。
 * 3. scrcpy-server 启动后会删自己的 jar（unlinkSelf），所以要放在 chmod 555 的目录里。
 * 4. 客户端一断，server 退出、屏立刻消失。必须常驻一个哑客户端。
 *
 * 判据：`dumpsys display` 里看 **DisplayDeviceInfo** 那一行，
 * 同时有 FLAG_OWN_CONTENT_ONLY + FLAG_OWN_FOCUS 才是"能托管 App"的屏。
 * mBaseDisplayInfo 那一段永远不带这两个标志，别拿它判断（我踩过）。
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adbTarget } from './target.js';

const pexec = promisify(execFile);
const ADB = process.env.ADB_BIN || 'adb';
const REMOTE_DIR = '/data/local/tmp/dshvd';
const REMOTE_JAR = `${REMOTE_DIR}/scrcpy-server.jar`;
const SERVER_VER = '5.0.1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


/**
 * watchFrames —— 高密度采样视频流帧计数，返回「变化时间线」
 *
 * ## 为什么需要它
 *
 * 现在 input() 里的 waitChanged 只回答「有没有变」，回答不了：
 *   - **什么时候变的**（点击后 50ms 就变，还是 800ms 才变）
 *   - **变了多久**（瞬时弹窗 300ms，还是一直保持）
 *   - **变化了几次**（弹出来又消失 = 两次变化）
 *
 * 「弹出又消失」这类瞬时状态，用首尾截图对比永远看不见。
 * 帧计数是 **0 成本、约 30ms 分辨率**（34fps 流），采样它就能还原时间线。
 *
 * ## 返回
 *
 * ```
 * {
 *   totalFrames: 期间新增总帧数,
 *   samples: [{ t, frames, delta }],   // 时间线
 *   bursts: [{ startMs, endMs, frames }],  // 连续重绘段
 *   firstChangeMs: 第一次重绘的时间点（相对开始）,
 *   changed: bool
 * }
 * ```
 */
export async function watchFrames(ms = 2000, intervalMs = 40) {
  // **用 state.videoReader.frames（单调递增），不是 packets.length。**
  // packets 数组有 PACKET_KEEP=400 上限，跑久了会饱和，饱和后 delta 恒为 0，
  // 看起来像「画面不动」—— 这个坑之前踩过。
  const rd = () => (state.videoReader ? state.videoReader.frames : 0);
  const t0 = Date.now();
  const samples = [];
  let prev = rd();
  while (Date.now() - t0 < ms) {
    await sleep(intervalMs);
    const cur = rd();
    samples.push({ t: Date.now() - t0, frames: cur, delta: cur - prev });
    prev = cur;
  }
  // 把连续有增量的采样合并成「重绘段」
  const bursts = [];
  let curBurst = null;
  for (const sm of samples) {
    if (sm.delta > 0) {
      if (!curBurst) curBurst = { startMs: sm.t, endMs: sm.t, frames: 0 };
      curBurst.endMs = sm.t;
      curBurst.frames += sm.delta;
    } else if (curBurst) {
      // 允许 200ms 的空档，超过才算一段结束
      if (sm.t - curBurst.endMs > 200) { bursts.push(curBurst); curBurst = null; }
    }
  }
  if (curBurst) bursts.push(curBurst);
  const totalFrames = samples.reduce((a, b) => a + b.delta, 0);
  return {
    totalFrames,
    samples,
    bursts,
    firstChangeMs: bursts.length ? bursts[0].startMs : null,
    changed: totalFrames > 0,
  };
}

export async function adb(args, timeout = 30000) {
  try {
    // 目标地址每次现取：adb 插件会把 adbd 迁到别的端口并写在 state.json 里。
    const target = await adbTarget();
    const { stdout, stderr } = await pexec(ADB, ['-s', target, ...args], { timeout, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, out: stdout || '', err: stderr || '' };
  } catch (e) {
    const out = typeof e.stdout === 'string' ? e.stdout : '';
    const err = typeof e.stderr === 'string' && e.stderr ? e.stderr : String(e.message || e);
    return { ok: false, out, err };
  }
}

export async function shell(cmd, timeout = 30000) {
  const r = await adb(['shell', cmd], timeout);
  return `${r.out}${r.err}`.trim();
}

/** 插件自带的 jar 路径（打包在 assets 里）。 */
function localJar() {
  // import.meta.url 在常规 ESM 下是有的，但宿主用 bundle 方式加载插件时会是 undefined，
  // 实测表现：vdisplay_start 直接报
  //   The "path" argument must be of type string or an instance of URL. Received undefined
  // 这是发布版必须兜住的坑——不能假设宿主一定按 ESM 文件加载。
  // 三级兜底，取第一个真实存在的：
  //   ① 常规 ESM：从模块自身位置往上找 assets/
  //   ② 环境变量 DSH_SCREEN_JAR（给特殊部署留的口子）
  //   ③ 从 DSH_HOME 推 profile 里的安装位置
  const cands = [];
  try {
    const u = import.meta?.url;
    if (typeof u === 'string' && u) {
      cands.push(join(dirname(fileURLToPath(u)), '..', 'assets', 'scrcpy-server.jar'));
    }
  } catch { /* import.meta.url 不可用，走后面的兜底 */ }
  if (process.env.DSH_SCREEN_JAR) cands.push(process.env.DSH_SCREEN_JAR);
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  // 不写死 profile 名：别人可能装在 web / desktop / 自建 profile 下，逐个扫一遍。
  const profilesDir = join(home, 'profiles');
  try {
    for (const p of readdirSync(profilesDir)) {
      cands.push(join(profilesDir, p, 'node_modules', 'dsh-go-plugin-screen', 'assets', 'scrcpy-server.jar'));
    }
  } catch { /* 没有 profiles 目录就跳过 */ }

  for (const c of cands) {
    try { if (existsSync(c)) return c; } catch { /* ignore */ }
  }
  return cands[0];   // 一个都不存在时返回首选，交给调用方报清晰的错
}

/** 确保设备上有 jar，且在 555 目录里（防自杀）。 */
export async function ensureJar() {
  const local = localJar();
  let localSize = 0;
  try {
    const { stat } = await import('node:fs/promises');
    localSize = (await stat(local)).size;
  } catch { /* 见下面的报错 */ }

  // 目录必须可写才推得进去。早期版本推完会把目录 chmod 555「保护」起来，
  // 结果是**永远无法升级 jar**，而且一旦目录已是 555 又缺 jar，就直接死锁
  // （实测 push 报 Permission denied）。所以每次先确保可写。
  await shell(`mkdir -p ${REMOTE_DIR} 2>/dev/null; chmod 777 ${REMOTE_DIR} 2>/dev/null`);

  const remoteSize = await shell(`stat -c '%s' ${REMOTE_JAR} 2>/dev/null || echo 0`);
  const have = Number(String(remoteSize).trim()) || 0;

  if (!localSize) {
    if (have > 0) {
      // **必须把 jar 设成 444 并且目录设成 555。**
      // scrcpy-server 启动时会 unlinkSelf（删自己），目录可写就删得掉 ——
      // 然后下一次启动就 Aborted，而报错只有一句「Aborted」，极难定位。
      // 这个坑代码注释里写着，但实现一直用 chmod 777 目录，等于没防。
      await shell(`chmod 444 ${REMOTE_JAR} 2>/dev/null; chmod 555 ${REMOTE_DIR} 2>/dev/null`);
      return { ok: true, existed: true, remote: REMOTE_JAR, hint: '插件包里没有 jar，用设备上已有的（版本可能与客户端不匹配）' };
    }
    return { ok: false, hint: `设备上没有 jar，插件包里也没有：${local}（需要 scrcpy-server-v${SERVER_VER}，可从 GitHub 下载放进 assets/）` };
  }

  // 大小一致就当作同一个版本，跳过推送（省一次 700KB 传输）
  if (have === localSize) {
    // **必须把 jar 设成 444 并且目录设成 555。**
      // scrcpy-server 启动时会 unlinkSelf（删自己），目录可写就删得掉 ——
      // 然后下一次启动就 Aborted，而报错只有一句「Aborted」，极难定位。
      // 这个坑代码注释里写着，但实现一直用 chmod 777 目录，等于没防。
      await shell(`chmod 444 ${REMOTE_JAR} 2>/dev/null; chmod 555 ${REMOTE_DIR} 2>/dev/null`);
    return { ok: true, existed: true, remote: REMOTE_JAR };
  }

  const p = await adb(['push', local, REMOTE_JAR], 120000);
  if (!p.ok) return { ok: false, hint: `推送 jar 失败：${p.err}` };
  // 文件本身设只读（防误改），目录保持可写（否则下次升级又会失败）
  // **必须把 jar 设成 444 并且目录设成 555。**
      // scrcpy-server 启动时会 unlinkSelf（删自己），目录可写就删得掉 ——
      // 然后下一次启动就 Aborted，而报错只有一句「Aborted」，极难定位。
      // 这个坑代码注释里写着，但实现一直用 chmod 777 目录，等于没防。
      await shell(`chmod 444 ${REMOTE_JAR} 2>/dev/null; chmod 555 ${REMOTE_DIR} 2>/dev/null`);
  return { ok: true, existed: false, remote: REMOTE_JAR, hint: have > 0 ? 'jar 版本已更新' : '' };
}

/** 列出当前的 displayId 集合，用于差集。 */
/**
 * 读屏 id 列表。
 * **查询失败时返回 null**，而不是空集合——空集和"屏真的没了"无法区分，
 * 早期版本因此把一次 adb 抖动当成"虚拟屏消失"，直接把正常屏拆了重建
 * （复核实测：单次失败 3.6 秒后重建、旧屏上 App 的上下文全丢）。
 */
async function displayIds() {
  const out = await shell(`dumpsys display 2>/dev/null | grep -oE "mDisplayId=[0-9]+" | sort -u`);
  if (!String(out || '').trim() || /error|not found|failed/i.test(String(out))) return null;
  return new Set(out.split('\n').map((s) => s.replace('mDisplayId=', '').trim()).filter(Boolean));
}

async function sfIds() {
  // 不要先 grep 再判空：grep 无匹配时输出为空，和"dumpsys 查询失败"长得一模一样，
  // 于是屏真的没了也会被当成"查询失败"，alive() 保守判活，start() 复用一块死屏，
  // 最后 am start --display 抛 SecurityException（性能测试那路实测踩到）。
  // 现在拿全量输出：只要里面有 Display 行，就说明 dumpsys 正常工作过，
  // 此时"没有 scrcpy 行"= 确实不存在虚拟屏，返回空集合。
  const out = await shell(`dumpsys SurfaceFlinger --display-id 2>/dev/null`);
  const text = String(out || '');
  if (!/Display\s+\d+/.test(text)) return null;   // 一行 Display 都没有 → 查询失败
  const ids = new Set();
  for (const line of text.split('\n')) {
    if (!/scrcpy/i.test(line)) continue;
    const m = line.match(/Display\s+(\d+)/);
    if (m) ids.add(m[1]);
  }
  return ids;   // 空集合 = 确实没有 scrcpy 虚拟屏，不是查询失败
}

/* ═══ 虚拟屏状态持久化 ═══
 *
 * 为什么必须做：state 是进程内的。DSH 引擎重启、插件热重载、或者任何一个
 * 新 Node 进程调工具时，state.displayId 都是 null → alive() 直接判死 →
 * start() 又建一块新屏。
 *
 * 实机表现（用户报的）：
 *   · display 号一路涨：448 → 452 → 453 → 457 → 460
 *   · framesrv/悬浮窗还指着旧屏 → 画面看起来"变成前台画面"
 *   · 屏越积越多，stop 也停不对
 *
 * 修法：把 displayId/sfId/scid 写盘，模块加载时读回来。
 */
const VD_STATE_FILE = join(homedir(), '.dsh', 'plugin-screen', 'vdisplay.json');
let _vdRestored = false;

function loadPersistedState() {
  if (_vdRestored) return;
  _vdRestored = true;
  try {
    const j = JSON.parse(readFileSync(VD_STATE_FILE, 'utf8'));
    if (j && j.displayId) {
      state.displayId = j.displayId;
      state.sfId = j.sfId || null;
      state.scid = j.scid || null;
      if (j.width) state.width = j.width;
      if (j.height) state.height = j.height;
      state.startedAt = j.startedAt || 0;
    }
  } catch { /* 没有或读坏了就算了 */ }
}

function savePersistedState() {
  try {
    mkdirSync(dirname(VD_STATE_FILE), { recursive: true });
    writeFileSync(VD_STATE_FILE, JSON.stringify({
      displayId: state.displayId, sfId: state.sfId, scid: state.scid,
      width: state.width, height: state.height, startedAt: state.startedAt,
      at: Date.now(),
    }));
  } catch { /* ignore */ }
}

function clearPersistedState() {
  try { rmSync(VD_STATE_FILE, { force: true }); } catch { /* ignore */ }
}

/**
 * 一块屏的完整上下文。
 *
 * **为什么改成工厂函数**：多屏需要 N 份独立的 state（各自的 displayId、sockets、
 * 截图缓存）。原来 `const state = {...}` 是模块级单例，148 处引用全都指着它。
 *
 * 改成「一个可切换的当前上下文」是改动最小的做法：
 *   · 所有 148 处 `state.xxx` 逻辑一行不用动
 *   · pool 切换时执行 `setActive(ctx)`，之后的调用自然作用在那块屏上
 *   · 没有并发问题，因为 daemon 已经把有副作用的命令串行化了
 */
/**
 * 清掉「上一次截图」留下的全部坐标基准。
 *
 * **必须一次清全 8 个字段。** 原来 stop() 只清 3 个（hash/path/imgWidth），
 * 漏了 lastShotRegion 和 lastShotImgHeight —— 于是 `shot(region) → stop → start → 点击`
 * 会拿上一块屏的 region 偏移和缩放比去换算，点歪（对抗审查 S15）。
 *
 * forget() 当时清了 region，stop() 没清，两处不一致本身就是 bug 的温床。
 */
/**
 * 清理 /tmp 里过期的截图。
 *
 * **为什么必须有**：每次截图写一个 vd-<时间戳>.png（720×1592 约 1-1.5MB），
 * 从不删除。`/tmp` 在 proot 里是 tmpfs —— 占的是内存。
 * 几十次视觉调用后就是几十上百 MB 常驻，用户只看到"内存怎么越来越少"。
 *
 * 策略：每次截图后顺手清一次，只留最近 20 个、且删除超过 10 分钟的。
 * 同步操作很快（一个目录枚举 + 若干 unlink），不影响截图延迟。
 */
let lastJanitorAt = 0;
function cleanShotDir(dir = '/tmp') {
  const now = Date.now();
  if (now - lastJanitorAt < 30_000) return;   // 最多 30 秒清一次
  lastJanitorAt = now;
  try {
    const names = readdirSync(dir).filter((f) => /^(vd|main)-\d+\.png$/.test(f));
    if (names.length <= 20) {
      // 数量不多时只删超龄的
      for (const f of names) {
        try {
          const st2 = statSync(`${dir}/${f}`);
          if (now - st2.mtimeMs > 600_000) rmSync(`${dir}/${f}`, { force: true });
        } catch { /* ignore */ }
      }
      return;
    }
    // 按名字里的时间戳排序（就是生成顺序），删最老的
    const sorted = names.slice().sort((a, b) => {
      const ta = Number((a.match(/(\d+)\.png$/) || [])[1] || 0);
      const tb = Number((b.match(/(\d+)\.png$/) || [])[1] || 0);
      return ta - tb;
    });
    for (const f of sorted.slice(0, sorted.length - 20)) {
      try { rmSync(`${dir}/${f}`, { force: true }); } catch { /* ignore */ }
    }
  } catch { /* 清理失败不影响截图 */ }
}

function resetShotBasis() {
  state.lastShotHash = null;
  state.lastShotPath = null;
  state.lastShotImgWidth = 0;
  state.lastShotImgHeight = 0;
  state.lastShotW = 0;
  state.lastShotH = 0;
  state.lastShotRegion = null;
  state.lastShotCacheKey = null;
}

function makeState() {
  return {
  child: null,
  sockets: [],
  // 视频流解析状态（src/video.js）。以前 socket[0] 的数据是直接丢掉的，
  // 现在喂给它 —— 实测这条流是 720x1592 的 H.264，约 25fps。
  videoReader: null,
  scid: null,
  port: null,
  displayId: null,
  sfId: null,
  width: 720,
  height: 1280,
  startedAt: 0,
  lastShotHash: null,
  lastShotPath: null,
  lastShotImgWidth: 0,
  systemDecorations: false,
  hwc: null,                                   // 建屏时请求的 hwc 值（'auto'/'on'/'off'）。
                                               // **之前没有这个字段**，导致 :292 的
                                               // `state.hwc !== hwc` 恒真 —— 复用一块
                                               // 已经开着 HWC 的屏时也会报"请求 hwc=on，实际 undefined"。
  dpi: 320,                                    // 建屏时用的 dpi，池用来做身份金丝雀
  launchedPkgs: [],
  // HWC 虚拟屏：部分 Qualcomm 设备的 HWC 支持合成虚拟屏，能让 3D 游戏不再黑屏。
  // hwcPrev 记的是开启前的原值，hwcChanged 表示这次是不是我们改的——只恢复自己改过的。
  hwcPrev: null,
  hwcChanged: false,
    lastSizeCheckAt: 0,
};
}

/** 当前活动的屏幕上下文。pool 通过 setActive() 切换它。 */
let state = makeState();

/** 取出当前上下文（pool 用，用来保存/恢复） */
export function getActive() { return state; }

/**
 * 切换当前活动屏。
 * @param {object} ctx 之前的 getActive() 返回值，或新的 makeState()
 */
export function setActive(ctx) {
  state = ctx || makeState();
}

/** 新造一个空上下文（pool 建新屏时用） */
export function newContext() { return makeState(); }

/** 建一块私有虚拟屏。返回 {ok, displayId, sfId} */
export async function start({ width = 0, height = 0, dpi = 320, systemDecorations = false, orientation = 'auto', hwc = 'auto', maxFps = 60, imePolicy = 'hide' } = {}) {
  // 记下调用方有没有显式传尺寸 —— square 分支靠它决定用默认值还是尊重传入值
  const explicitSize = width > 0 && height > 0;

  // **尺寸自动探测**：不传 width/height 时按物理屏比例生成同比例的虚拟屏。
  // 虚拟屏是合成的（scrcpy new_display），跟物理屏大小无关，但比例会影响 App 的
  // 布局判断（平板/手机模式、横竖屏）。写死 720x1280 在 9:19.4 的屏上窄 25%，
  // 少数 App 会进错布局。默认值从设备真实比例推，换手机也适用。
  if (!width || !height) {
    let pw = 0;
    let ph = 0;
    try {
      const r = await shell('wm size 2>/dev/null');
      const m = String(r || '').match(/(\d+)x(\d+)/);
      if (m) { pw = Number(m[1]); ph = Number(m[2]); }
    } catch { /* 拿不到就用兜底 */ }
    if (pw > 0 && ph > 0) {
      // 宽度基准 720，长边不超过 1600（太高的屏会拖慢截图和编码）
      const scale = Math.min(720 / pw, 1600 / ph);
      width = Math.max(320, Math.round(pw * scale));
      height = Math.max(320, Math.round(ph * scale));
    } else {
      width = 720; height = 1280;
    }
  }

  // 处理 orientation 参数：landscape 时自动交换宽高
  let finalWidth = width;
  let finalHeight = height;
  if (orientation === 'landscape') {
    // 横屏：确保宽 > 高
    if (width < height) {
      finalWidth = height;
      finalHeight = width;
    }
  } else if (orientation === 'portrait') {
    // 竖屏：确保高 > 宽
    if (width > height) {
      finalWidth = height;
      finalHeight = width;
    }
  } else if (orientation === 'square') {
      /* **正方形：旋转不变的尺寸。**
       *
       * 虚拟屏带 FLAG_ROTATES_WITH_CONTENT —— App 强制横屏时屏的**尺寸会真的变**
       * （720×1592 → 1592×720），而取帧服务的镜像是建的时候定死的，
       * 结果投横屏游戏时画面挤在顶部一条、其余全黑（2026-11-20 实测）。
       *
       * 720×720 转 90° 还是 720×720，**尺寸不变**，从根上绕开这个问题。
       *
       * 边长取「短边」再夹在 720~1080：太小横屏游戏看不清，太大拖慢编码。
       */
      /* **边长 1080px，不是短边。**
       *
       * dpi 320 时 dp = px/2：
       *   720×720   = 360dp  ⚠️ 低于「正常屏」门槛 470dp，部分 App 进小屏布局
       *   1080×1080 = 540dp  ✅ 高于 470dp、低于平板门槛 600dp —— 唯一两边都安全
       *   1280×1280 = 640dp  ⚠️ 触发 sw600dp，微信/Chrome/设置切平板双栏
       *
       * 之前按「短边」算，720 宽的屏上会给出 720×720，正好踩进风险区。
       * 调用方显式传了 width/height 就尊重它（夹在 720~1080）。
       */
      const side = explicitSize
        ? Math.min(1080, Math.max(720, Math.min(width, height)))
        : 1080;
    finalWidth = side;
    finalHeight = side;
  }
  // 如果 orientation 是具体数值（旋转角度），这里暂时不处理，
  // 因为 scrcpy new_display 不直接支持旋转参数，只支持尺寸。
  // 旋转由 App 自己根据屏幕尺寸判断（横屏 App 看到宽>高的屏会自动横屏）。
  if (state.displayId) {
    /* **只要屏还活着就复用，配置不同只提示不重建。**
     *
     * 以前的逻辑只比较 systemDecorations，尺寸/DPI/方向全不比 —— 于是：
     *   · 有人显式建了带装饰的屏，别处一句 start()（默认 false）就把它拆了，
     *     屏上的 App 一起没了，工具还报"就绪"
     *   · 更糟的是 forget() 不清 hwcPrev，重建时 getprop 已经是 1，
     *     于是 hwcPrev 被记成 '1'，stop 时又恢复成 1，全局 HWC 残留到重启
     *
     * 现在的取舍：**拆掉一个正在用的屏，代价远大于配置和请求不一致**。
     * 所以活着就复用，把差异如实说出来，让调用方自己决定要不要 stop 再建。
     */
    // **复用检查带 1.5 秒 TTL**：连着截图时省掉 3 次 dumpsys（实测省 ~250ms/次）。
    const nowReuse = Date.now();
    const reuseFresh = lastReuseResult && (nowReuse - lastReuseCheckAt) < REUSE_TTL_MS;
    const isAlive = reuseFresh ? lastReuseResult.alive : await alive();
    if (!reuseFresh) { lastReuseCheckAt = nowReuse; lastReuseResult = { alive: isAlive }; }
    if (isAlive) {
      const fl = reuseFresh && lastReuseResult.fl
        ? lastReuseResult.fl
        : await shell('dumpsys display 2>/dev/null | grep "DisplayDeviceInfo.*scrcpy" | head -1');
      if (!reuseFresh) lastReuseResult.fl = fl;
      const wantW = width; const wantH = height;
      const diff = [];
      if (wantW && wantH && (wantW !== state.width || wantH !== state.height)) {
        diff.push(`请求 ${wantW}x${wantH}，实际 ${state.width}x${state.height}`);
      }
      if (state.systemDecorations !== systemDecorations) {
        diff.push(`请求 decorations=${systemDecorations}，实际 ${state.systemDecorations}`);
      }
      if (state.hwc !== hwc && hwc !== 'auto') {
        diff.push(`请求 hwc=${hwc}，实际 ${state.hwc}`);
      }
      savePersistedState();   // 复用也刷新一下，保证文件里的值是最新的
    return {
        ok: true, displayId: state.displayId, sfId: state.sfId, reused: true,
        width: state.width, height: state.height,
        canHost: /FLAG_OWN_CONTENT_ONLY/.test(fl) && /FLAG_OWN_FOCUS/.test(fl),
        flags: (fl.match(/FLAG_[A-Z_]+/g) || []).join(' '),
        // 复用分支以前不返回 hwc，调用方只能当'未开启'，于是一个 HWC 开着的屏
        // 会被报成'3D 游戏会黑屏'；实际开没开要看真实属性，不是猜。
        hwc: (await shell('getprop debug.sf.enable_hwc_vds').catch(() => '')).trim() === '1',
        // 配置和请求不一致时明确告诉调用方，不要假装按请求建了
        configMismatch: diff.length ? diff.join('；') : null,
      };
    }
    // 走到这里说明记着有屏但实际已经没了（server 被回收 / adb 断开 / 被 pkill），
    // 或者是调用方明确要换配置。清干净重来，别继续报"已就绪"骗调用方。
    forget('旧屏已失效，重建');
  }

  const jar = await ensureJar();
  if (!jar.ok) return { ok: false, hint: jar.hint };

  // 权限前提：shell 必须有 ADD_TRUSTED_DISPLAY（本机有，Pixel 没有）
  const perm = await shell(`dumpsys package com.android.shell 2>/dev/null | grep -c "ADD_TRUSTED_DISPLAY: granted=true"`);
  if (Number(perm.trim()) === 0) {
    return { ok: false, hint: '这台机器的 com.android.shell 没有 ADD_TRUSTED_DISPLAY 权限，私有虚拟屏起不来（scrcpy 官方 issue #5523）。这条路只在一部分机型上可用。' };
  }

  // displayIds/sfIds 查询失败会返回 null，这里兜底成空集合（start 时还没有旧屏可比）
  const before = (await displayIds()) || new Set();
  const beforeSf = (await sfIds()) || new Set();

  // scid 会被 scrcpy 用 Integer.parseInt(radix 16) 解析，必须是**有符号 32 位**内的正整数。
  // 用 0xffffffff 随机会得到 cd7bccd6 这种超范围值，server 直接 NumberFormatException 退出（踩过）。
  // ---- HWC 虚拟屏（让 3D 游戏不再黑屏）----
  // 背景：虚拟屏默认走 GPU 软件合成，SurfaceView 拿不到硬件叠加层 → 3D 游戏全黑。
  // 实测 REDMAGIC NX809J（Adreno 8 Gen 3）：vendor.display.vds_allow_hwc=1 但
  // debug.sf.enable_hwc_vds=0，把它置 1 后王者荣耀在虚拟屏正常渲染。
  //
  // 这是**全局** SurfaceFlinger 属性，会影响整台设备，所以：
  //   1. 只在硬件声明支持（vds_allow_hwc=1）时才开，不盲开；
  //   2. 记下原值，stop() 时只恢复我们自己改过的那种；
  //   3. 任何一步失败都静默降级，不能因为开不了 HWC 就建不了屏。
  // 它是 debug.* 属性，重启设备自动复原，不会留下永久改动。
  if (hwc !== 'off') {
    const allow = (await shell('getprop vendor.display.vds_allow_hwc')).trim();
    if (allow === '1' || hwc === 'on') {
      const prev = (await shell('getprop debug.sf.enable_hwc_vds')).trim() || '0';
      state.hwcPrev = prev;
      if (prev !== '1') {
        await shell('setprop debug.sf.enable_hwc_vds 1');
        const now = (await shell('getprop debug.sf.enable_hwc_vds')).trim();
        state.hwcChanged = now === '1';
      }
    }
  }

  const scid = (1 + Math.floor(Math.random() * 0x7ffffffe)).toString(16).padStart(8, '0');
  const port = 28000 + Math.floor(Math.random() * 900);
  state.scid = scid;
  state.port = port;

  const target = await adbTarget();
  await adb(['forward', `tcp:${port}`, `localabstract:scrcpy_${scid}`]);

  const cmd = `CLASSPATH=${REMOTE_JAR} app_process / com.genymobile.scrcpy.Server ${SERVER_VER} `
    // display_ime_policy 三个取值（从 scrcpy-server dex 挖出来的）：
    //   hide             默认，虚拟屏上没有输入法，打字打不进去
    //   local            输入法渲染到这块虚拟屏上，打字能用
    //   fallback_display 回退到默认屏
    //
    // 默认 hide 是必须的：不加这个，虚拟屏上的输入框会把系统输入法焦点
    // 抢过去（实测 mDisplayIdToShowIme 会变成虚拟屏的 id），用户在主屏打字时键盘就没了。
    // 代价：虚拟屏上也打不了字（没有输入法连接），所以文字要么用深链带参数进去，要么用坐标点选。
    // vd_system_decorations=false（scrcpy ≥3.1）：不加这个，虚拟屏上会自带
    // 二级桌面 launcher、导航栏和权限弹窗——AI 截图会把这些系统 UI 一起截进去，
    // 以为是自己要操作的界面。实测关掉后屏上窗口数=0，画面干净。
    + `log_level=info tunnel_forward=true display_ime_policy=${imePolicy} vd_system_decorations=${systemDecorations ? 'true' : 'false'} new_display=${finalWidth}x${finalHeight}/${dpi} `
    + `control=true audio=false scid=${scid}`
    // **max_fps 以前从来没传过 —— 等于无限帧率。**
    // 实测 MC 跑起来视频流 145fps（远超 60），CPU 和带宽都白烧。
    // 默认限到 60：够流畅，又不浪费。
    + (maxFps > 0 ? ` max_fps=${maxFps}` : '');
  // 把 server 的输出落到日志文件：出问题时没有日志只能瞎猜（刚踩过：服务秒退却不知道为什么）
  const logPath = '/tmp/dsh-vd-server.log';
  const { openSync } = await import('node:fs');
  let fd = 'ignore';
  try { fd = openSync(logPath, 'w'); } catch { /* 写不了就用 ignore */ }
  state.logPath = logPath;

  const cleanupForward = async () => {
    try { await adb(['forward', '--remove', `tcp:${port}`]); } catch { /* 清不掉不影响返回 */ }
  };

  // ---- 这里是整个插件唯一能把引擎进程带崩的调用 ----
  // Node 行为：spawn 找不到可执行文件（ENOENT）时 emit 'error'；没有 'error' 监听
  // 就是 Unhandled 'error' event → uncaughtException → 进程直接退出
  // （本机 node 24.22.1 实测 exit 1）。环境升级清空过 apt 装的 adb，这场景真实发生过。
  // 所以做两层：① 同步 try/catch 兜 spawn 自身的参数/stdio 错误；
  //            ② 等 spawn/error 落定，失败就返回可读 hint，绝不把异常抛出去。
  let child;
  try {
    child = spawn(ADB, ['-s', target, 'shell', cmd], { detached: true, stdio: ['ignore', fd, fd] });
  } catch (e) {
    await cleanupForward();
    return { ok: false, hint: `无法启动 adb（${ADB}）：${e?.message || e}。先装 android-tools-adb（apt-get install -y android-tools-adb）` };
  }
  let spawnError = null;
  child.on('error', (e) => { if (!spawnError) spawnError = e; state.child = null; });
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    child.once('spawn', done);
    child.once('error', done);
    setTimeout(done, 3000).unref?.();
  });
  if (spawnError) {
    try { child.kill('SIGKILL'); } catch { /* 没起来就没什么可杀 */ }
    await cleanupForward();
    return {
      ok: false,
      hint: `启动 adb 失败（${ADB}）：${spawnError?.message || spawnError}\n`
        + '先装 android-tools-adb（apt-get install -y android-tools-adb）再重试。',
    };
  }
  state.child = child;
  child.unref?.();

  // 这个固定等待**不能省**：试过改成"能连上就往下走"，结果连太早 server 还没准备完，
  // 屏建不出来（实测 10.6 秒后失败）。1800ms 是 server 初始化 + new_display 的时序要求。
  await sleep(1800);

  // 两个客户端：video（第 0 个）+ control（第 1 个）。断开即销毁整个屏。
  //
  // **第 0 个不是「哑客户端」** —— 它传的是实时 H.264。以前这里写
  // `s.on('data', () => {})` 把数据丢了，于是所有截图只能走 screencap（7fps）。
  // 现在喂给 video.js 解析，能用的时候就有 25fps 的实时帧。
  const videoMod = await import('./video.js');
  state.videoReader = videoMod.createReader();

  const connect = (isVideo) => new Promise((res) => {
    const s = net.connect(port, '127.0.0.1', () => res(s));
    s.on('error', () => res(null));
    if (isVideo) {
      s.on('data', (d) => { try { videoMod.push(state.videoReader, d); } catch { /* 解析出错不能影响连接 */ } });
    } else {
      s.on('data', () => {});
    }
  });
  const s1 = await connect(true);
  await sleep(500);
  const s2 = await connect(false);
  state.sockets = [s1, s2].filter(Boolean);
  state.startedAt = Date.now();

  // 等屏出现（差集）
  for (let i = 0; i < 20; i += 1) {
    await sleep(400);
    const now = await displayIds();
    if (!now) { await sleep(300); continue; }   // 查询失败这一轮跳过，别误判成屏没出来
    const added = [...now].filter((d) => !before.has(d));
    if (added.length) {
      state.displayId = added[0];
      state.width = finalWidth; state.height = finalHeight;
      state.dpi = dpi;                          // 记录给池认身份用
      state.hwc = hwc;                          // 记下请求值，复用分支的差异对比要用
      state.systemDecorations = systemDecorations;
      break;
    }
  }
  if (!state.displayId) {
    await stop();
    return { ok: false, hint: 'server 起来了但没等到新屏出现。常见原因：socket 名没带下划线、客户端没连上、或者权限不足。' };
  }

  for (let i = 0; i < 10; i += 1) {
    await sleep(300);
    const nowSf = await sfIds();
    if (!nowSf) { await sleep(300); continue; }
    const added = [...nowSf].filter((d) => !beforeSf.has(d));
    if (added.length) { state.sfId = added[0]; break; }
  }

  // 校验能力标志
  const flags = await shell(`dumpsys display 2>/dev/null | grep "DisplayDeviceInfo.*scrcpy" | head -1`);
  const canHost = /FLAG_OWN_CONTENT_ONLY/.test(flags) && /FLAG_OWN_FOCUS/.test(flags);

  // **建屏成功就落盘**：之后任何进程都能复用这块屏，不会重复建。
  savePersistedState();
  return {
    ok: true,
    displayId: state.displayId,
    sfId: state.sfId,
    canHost,
    width: state.width, height: state.height,
    flags: (flags.match(/FLAG_[A-Z_]+/g) || []).join(' '),
    // HWC 是否生效：true 表示这次的屏有硬件合成，3D 游戏能正常渲染
    hwc: state.hwcChanged || state.hwcPrev === '1',
  };
}

/**
 * **同步**把 HWC 属性恢复原值。只给进程退出钩子用 —— 那里不能 await。
 *
 * 为什么必须有：debug.sf.enable_hwc_vds 是全局 SurfaceFlinger 属性，
 * 开着的时候整台设备的合成策略都变了。正常路径 stop() 会恢复它，
 * 但守护进程被 SIGKILL / OOM 杀掉时 stop() 根本不会执行 ——
 * 属性就永远停在 1，直到手机重启。
 *
 * SIGKILL 抓不到，所以这个函数也只能覆盖 SIGTERM/正常退出。
 * 但对 OOM 和时间超时这两种最常见的情况是有效的。
 */
export function restoreHwcSync() {
  if (!state.hwcChanged) return false;
  let target = process.env.ADB_TARGET || '127.0.0.1:5555';
  try {
    const dir = process.env.DSH_ADB_STATE_DIR
      || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugin-adb');
    const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    const port = Number(st?.port);
    if (Number.isInteger(port) && port > 0 && port < 65536) target = `127.0.0.1:${port}`;
  } catch { /* 读不到就用默认回环地址 */ }

  const ADBBIN = process.env.ADB_BIN || 'adb';
  try {
    execFileSync(ADBBIN, ['-s', target, 'shell',
      `setprop debug.sf.enable_hwc_vds ${state.hwcPrev || '0'}`], { timeout: 5000 });
    state.hwcChanged = false;
    return true;
  } catch {
    return false;
  }
}

/** 销毁虚拟屏。 */
export async function stop({ forceStopApps = false } = {}) {
  const pkgList = [...(state.launchedPkgs || [])];
  const killed = [];
  // 默认**不杀**投过的 App：里面有可能是 DSH、Shizuku、微信这类不能随便杀的。
  // 需要清后台时调用方显式传 forceStopApps:true，并且自己判断这个包该不该杀。
  if (forceStopApps) {
    for (const pkg of pkgList) {
      // 硬保护：这些包杀了会直接影响用户（DSH 就是当前 App 本身）
      if (/^(io\.github\.ccch1mneyyy\.dsh_app|moe\.shizuku\.)/.test(pkg)) continue;
      await shell(`am force-stop ${pkg}`);
      killed.push(pkg);
    }
  }
  // 逐个包判断：以前只要有一个命中就把整个列表都报成"还在跑"（复核实测）。
  const still = [];
  for (const pkg of pkgList) {
    // 用 pidof 精确匹配进程名：grep 子串会命中同类包
    // （实测 com.android.settings 已 force-stop，却因为命中
    //   com.android.settings.intelligence 而误报"仍在后台"）。
    const pid = await shell(`pidof ${pkg} 2>/dev/null || true`);
    if (String(pid || '').trim()) still.push(pkg);
  }
  const scid = state.scid;
  if (scid) await shell(`pkill -f '${scid}' 2>/dev/null`);
  // 清掉本次用的 adb forward：以前从不清，复核实测攒了 9 条残留。
  if (state.port) await adb(['forward', '--remove', `tcp:${state.port}`], 10000).catch(() => {});
  // 不能用 --remove-all：那会删掉别的插件（比如 web_* 的 CDP）的 forward。只删自己那条。
  for (const sk of state.sockets || []) { try { sk?.destroy(); } catch { /* ignore */ } }
  if (state.child) { try { state.child.kill('SIGKILL'); } catch { /* ignore */ } }
  // 恢复 HWC 属性。只恢复这次由我们改成的那个值——
  // 如果开机时它本来就是 1，说明用户或别的工具故意开着，我们不去动它。
  if (state.hwcChanged) {
    await shell(`setprop debug.sf.enable_hwc_vds ${state.hwcPrev || '0'}`);
    state.hwcChanged = false;
  }
  state.hwcPrev = null;
  state.sockets = [];
  state.videoReader = null;
  state.child = null;
  state.displayId = null; state.sfId = null; state.scid = null; state.port = null;
  resetShotBasis();             // **8 个字段一次清全**（原来只清 3 个，region 会漏）
  state.launchedPkgs = [];
  return {
    ok: true,
    killed,
    stillRunning: still,
    hint: still.length
      ? `虚拟屏已销毁。这些 App 仍在后台运行：${still.join('、')}。如果要清掉，下次 stop 时传 forceStopApps:true（DSH 和 Shizuku 会被跳过）。`
      : '虚拟屏已销毁，没有需要清理的后台 App。',
  };
}

/**
 * 虚拟屏是不是**真的**还活着。
 * 只看 state.displayId 会撒谎：server 被系统回收、adb 断开、用户手动 pkill 之后，
 * state 里还留着旧的 displayId，于是 status 报"运行中"、start 报"已就绪"、
 * shot 报原始的 "Display Id is not valid"（复核实测踩到）。
 * 这里用两个客观信号交叉验证：屏还在不在 displayIds 里、SF id 还在不在 sfIds 里。
 */
/**
 * 重新解析当前 scrcpy 虚拟屏的 SurfaceFlinger display id。
 *
 * 为什么需要：屏幕一转向（游戏强制横屏就会），SurfaceFlinger 会**重建**这块虚拟屏
 * 并分配一个新的 SF display id，而逻辑 displayId 保持不变。实测证据：
 *
 *   逻辑 id 110 / 空屏   → SF …8400646736，图层 0，截图 0% 非黑
 *   逻辑 id 110 / MC 起  → SF …9638300942，图层 4，截图 95.45% 非黑
 *   逻辑 id 110 / 转屏后 → SF 换新，缓存里的旧 id 不在列表里
 *
 * 早期版本把「缓存的 sfId 不在列表里」当成「屏已死」，于是每次截图都 forget() 杀掉
 * scrcpy server 再重建一块空屏，结果永远是全黑——**根本不是 3D 渲染不出来**。
 *
 * @returns {Promise<string|null>} 唯一确定的 scrcpy SF id；0 个或多个时返回 null
 */
async function resolveScrcpySfId() {
  const out = await shell(`dumpsys SurfaceFlinger --display-id 2>/dev/null | grep scrcpy`);
  if (!String(out || '').trim()) return null;
  const ids = [];
  for (const line of String(out).split('\n')) {
    // 形如：Display 11529215048987737530 (Virtual display): displayName="scrcpy"
    const m = line.match(/Display\s+(\d+).*scrcpy/);
    if (m) ids.push(m[1]);
  }
  if (ids.length !== 1) return null;   // 多个时分不清，宁可不更新
  return ids[0];
}

/** 确保 state.sfId 是当前有效的；变了就更新，**不重建屏**。 */
/**
 * `start()` 的复用检查缓存。
 *
 * **为什么必须有**：实测 `shot()` 单张 623ms，而 screencap 本身只要 225ms。
 * 差的 400ms 里，大头是 `start()` 每次都要:
 *   alive() → displayIds() + sfIds()     = 2 次 dumpsys
 *   复用分支 → DisplayDeviceInfo          = 1 次 dumpsys
 * 同一个操作序列里连着截图/OCR/模板匹配，这些查询全是重复的。
 *
 * 缓存 1.5 秒：正常操作节奏（每步几百毫秒）内不会过期；
 * 真转屏/屏死时，screencap 失败会触发强制刷新（captureAndConvert 有兜底）。
 */
const REUSE_TTL_MS = 1500;
let lastReuseCheckAt = 0;
let lastReuseResult = null;

/**
 * 刷新 SurfaceFlinger id。
 *
 * **实测：这个函数每次调用要 ~150-400ms**（内部 dumpsys + grep），
 * 而 `vd.shot()` 每张截图都会调它 → 单张截图从 225ms 涨到 623ms。
 * 所有基于截图的工具（OCR、模板匹配、指纹）都被这个拖慢。
 *
 * 加 2 秒 TTL：同一个操作序列里连着截图不会重复查。
 * 转屏时 id 会变，但下次 TTL 过期就会重新解析；而且 screencap 失败时
 * 会强制刷新（下面 captureAndConvert 里有兜底）。
 */
const SFID_TTL_MS = 2000;
let lastSfIdCheckAt = 0;

async function refreshSfId(force = false) {
  const now = Date.now();
  if (!force && state.sfId && (now - lastSfIdCheckAt) < SFID_TTL_MS) {
    return state.sfId;                      // **缓存命中，省掉 150-400ms 的 dumpsys**
  }
  lastSfIdCheckAt = now;
  if (!state.sfId) { const r = await resolveScrcpySfId(); if (r) state.sfId = r; return state.sfId; }
  const cur = await resolveScrcpySfId();
  if (!cur) return state.sfId;              // 查不到（可能刚好在转屏瞬间）→ 先用旧的
  if (cur !== state.sfId) {
    state.sfId = cur;                       // 转屏导致 id 变了 → 更新即可，不要杀 server
  }
  return state.sfId;
}

/**
 * 刷新"当前实际渲染尺寸"。
 *
 * **为什么必须做**：`dumpsys display` 报的是虚拟屏的**初始声明**尺寸（比如 720x1592），
 * 但 App 强制横屏后实际画面会变成 1592x720。`nx/ny` 如果按 state.width/height 换算，
 * 点「设置」会落到屏幕外面 —— 实测表现是"点了没反应"，很容易误判成按钮不可点。
 *
 * `dumpsys window displays` 里的 `cur=1592x720` 才是当前真实尺寸。
 * 实测代价约 50ms，比多截一张图（133-240ms）便宜。
 */
/**
 * 刷新虚拟屏真实尺寸。
 *
 * **带 2 秒 TTL。** 原来每次 input() 都调它，等于每步多一次 `dumpsys window displays`
 * （150-300ms）。连续操作时尺寸根本不会变，重复查纯属浪费。
 *
 * 实测账：一次 input 里有 5 次 adb 往返（alive 两次 + dumpsys display + getprop +
 * refreshRealSize），150-300ms/次 → 0.75-1.5s。真正注入只要 20-50ms。
 * 加 TTL 后连续操作可以省掉绝大部分。
 */
async function refreshRealSize(force = false) {
  if (!state.displayId) return false;
  const now = Date.now();
  if (!force && state.lastSizeCheckAt && (now - state.lastSizeCheckAt) < 2000) {
    return false;   // 2 秒内查过了，直接用缓存值
  }
  state.lastSizeCheckAt = now;
  try {
    const out = await shell(`dumpsys window displays 2>/dev/null | grep -A2 "mDisplayId=${state.displayId} " | head -3`);
    const m = String(out || '').match(/cur=(\d+)x(\d+)/);
    if (!m) return false;
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w > 0 && h > 0 && (w !== state.width || h !== state.height)) {
      state.width = w;
      state.height = h;
      state.lastShotHash = null;      // 尺寸变了，旧的去重基准作废
      return true;
    }
  } catch { /* 查不到就用旧值 */ }
  return false;
}

async function alive() {
  if (!state.displayId) return false;
  const [ids, sf] = await Promise.all([displayIds(), sfIds()]);
  // null = 查询失败（adb 抖动），不能据此判定屏没了 → 保守认为还活着
  if (!ids || !sf) return true;
  const hasDisplay = ids.has(String(state.displayId));
  if (!hasDisplay) return false;                 // 逻辑屏真没了 → 确实死了
  if (state.sfId && sf.has(String(state.sfId))) return true;   // 缓存的 SF id 还有效
  // 逻辑屏在、但缓存的 SF id 不在列表里 → **多半是转屏换了 id**，重新解析而不是判死
  const fresh = await resolveScrcpySfId();
  if (fresh) { state.sfId = fresh; return true; }
  return false;
}

/** 状态不一致时，把内存状态清干净，免得后面每个工具都报假消息。 */
function forget(reason) {
  // **清 hwcPrev 之前必须先恢复 HWC。** 上一版只清了记录，没恢复实际属性：
  // 重建时 getprop 还是 '1'，于是 hwcPrev 又被记成 '1'，stop 再写回 1，
  // 全局 debug.sf.enable_hwc_vds 就残到重启，原始值 '0' 永远丢了。
  try { restoreHwcSync(); } catch { /* 恢复失败也不能挡住重建 */ }
  const dead = { displayId: state.displayId, sfId: state.sfId, port: state.port };
  try { state.child?.kill('SIGKILL'); } catch { /* ignore */ }
  for (const sk of state.sockets || []) { try { sk?.destroy(); } catch { /* ignore */ } }
  state.child = null; state.sockets = [];
  state.displayId = null; state.sfId = null; state.scid = null; state.port = null;
  // **8 个字段一次清全**（原来只清 4 个：ImgHeight/W/H/cacheKey 会漏，和 stop() 不一致）
  resetShotBasis();
  state.lastInputAt = null;      // pickRoi 的兜底 ROI 用它，不清会拿上一块屏的坐标当中心
  lastReuseResult = null;        // **复用检查缓存也作废**，否则新建屏后还在用旧的判定
  lastReuseCheckAt = 0;
  clearPersistedState();         // **盘上的记录也清掉**，否则下个进程会去复用死屏
  // **hwcPrev 必须清掉**：不清的话，重建时 getprop 已经是 1，于是 hwcPrev 被记成 '1'，
  // stop 时又恢复成 1，全局 debug.sf.enable_hwc_vds 残到重启（对抗审查 S1）。
  state.hwcPrev = null;
  state.hwc = null;
  state.systemDecorations = false;
  return { ...dead, reason };
}

/** 取虚拟屏上当前前台 App 的窗口串（胶囊用来显示"AI 在操作 XX"）。 */
export async function focusedApp() {
  if (!state.displayId) return '';
  const r = await shell(`dumpsys window displays 2>/dev/null | grep -A30 "mDisplayId=${state.displayId}" | grep -m1 mCurrentFocus`);
  return String(r || '').trim();
}

export async function status() {
  const ids = await displayIds();
  const sf = await sfIds();
  const app = state.displayId ? await shell(`dumpsys window displays 2>/dev/null | grep -A20 "mDisplayId=${state.displayId}" | grep -m1 mCurrentFocus`) : '';
  return {
    running: await alive(),
    displayId: state.displayId,
    sfId: state.sfId,
    uptimeSec: state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0,
    dpi: state.dpi,                              // 池的金丝雀身份（U8 实测 320/321 可区分）
    width: state.width, height: state.height,   // 转屏后这两个值会变，坐标空间跟着变
    allDisplays: ids ? [...ids].sort((a, b) => a - b) : null,   // null 表示查询失败，不是没有屏
    scrcpyScreens: sf ? [...sf] : null,
    focusedApp: app.trim(),
  };
}

/**
 * 把 App 投到虚拟屏。
 *
 * 必须先 force-stop：如果这个 App 已经跑在主屏后台，`am start --display N` 只会把
 * 那个已有任务拉到前台（实测踩过：计算器就是这么跑到主屏、把用户的视频顶掉的）。
 * 投完还要**校验主屏焦点没变**，变了立刻切回去——「不影响主屏」是硬要求。
 */
export async function launch(pkg, activity) {
  const s = await start();
  if (!s.ok) return { ok: false, hint: s.hint };

  const mainBefore = await mainFocus();

  await shell(`am force-stop ${pkg}`);
  if (!state.launchedPkgs.includes(pkg)) state.launchedPkgs.push(pkg);
  await sleep(600);

  // 省略 activity 时不能只写 `-n <pkg>`——实测报 Bad component name。
  // 先用 resolve-activity 查出默认入口，查不到再退回 monkey 的 launcher intent。
  let comp;
  if (activity) {
    comp = `-n ${pkg}/${activity}`;
  } else {
    const res = await shell(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg} 2>/dev/null | tail -1`);
    const m = String(res).trim().match(/^([\w.]+)\/([\w.$]+)$/);
    comp = m ? `-n ${m[1]}/${m[2]}` : `-a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${pkg}`;
  }
  const out = await shell(`am start --display ${state.displayId} ${comp}`);
  await sleep(2000);

  // 校验是不是真的落在虚拟屏上
  const onVd = await shell(`dumpsys window displays 2>/dev/null | grep -A30 "mDisplayId=${state.displayId}" | grep -m1 mCurrentFocus`);
  const landedOnVd = onVd.includes(pkg);

  // 校验主屏
  const mainAfter = await mainFocus();
  // 只有**两边都测到**且真的不同，才算"主屏被抢"。空值代表"没测到"，不能当变化——
  // 之前用空值比较，导致前后都是 B 站却报"主屏被抢、已切回"（假报警，踩过）。
  const bothKnown = Boolean(mainBefore) && Boolean(mainAfter);
  // **绝对不对主屏做任何操作。**
  // 以前这里会在"判定主屏被抢"时跑 monkey 把原来的 App 拉回来，
  // 但那个判定在"用户自己在这 2 秒里切了 App"时会误判——于是插件反过来
  // 用 monkey 改了用户的主屏，比它要防的问题更打扰人（复核实测踩到）。
  // 现在只观察、只报告，让调用方决定。
  const mainChanged = bothKnown && mainAfter !== mainBefore;
  const restored = false;

  return {
    ok: landedOnVd && !restored,
    displayId: state.displayId,
    landedOnVd,
    mainFocusBefore: mainBefore,
    mainFocusAfter: mainAfter,
    mainChanged,
    restoredMain: false,
    out: out.trim() || (landedOnVd ? '已在虚拟屏上启动' : '没落在虚拟屏上'),
  };
}


/**
 * 取当前虚拟屏的一帧，只算哈希，不落盘。
 *
 * 为什么要这个：之前的 input() 只要 adb 不报错就返回 ok:true，**点空了也算成功**。
 * 实测（隔壁对线会话 15 张截图里有 5 张与上一张逐像素相同）意味着 一定比例 的操作是白点的，
 * 而调用方完全看不出来，只能靠额外交一张截图 + 模型看图才可能发现。
 * 所以每个输入动作前后各取一次哈希，变了才算真生效。
 */
/**
 * 往 scrcpy 的控制 socket 发一条控制消息。
 *
 * 为什么值得做：现在所有输入都走 `adb shell input`，那条路对中文必抛 NPE
 * （实测 `input text 中文` → java NPE），而且每次起一个子进程要 30–50ms。
 * scrcpy 的控制通道支持 SET_CLIPBOARD，实测设置页能粘进 `abc中文测试abc`，
 * 所以中文输入的正解是「写剪贴板 → KEYCODE_PASTE」。
 *
 * SET_CLIPBOARD 报文（scrcpy 5.x）：
 *   type=9 (1B) | sequence (8B i64) | paste (1B bool) | length (4B i32) | text (utf8)
 */
/**
 * 控制通道当前是否可用。返回 socket 或 null。
 *
 * tap/swipe 用它决定走 scrcpy 控制通道还是退回 adb input。
 * 注意：**必须检查 destroyed**，socket 断了但对象还在的情况实测会出现。
 */
function sendControlRaw() {
  const ctl = state.sockets?.[1];
  if (!ctl || ctl.destroyed) return null;
  return ctl;
}

function sendControl(buf) {
  const ctl = state.sockets?.[1];
  if (!ctl || ctl.destroyed) return false;
  try { ctl.write(buf); return true; } catch { return false; }
}

let clipSequence = 0;

/** 把文字写进设备剪贴板。返回是否发成功。 */
export function setClipboard(text) {
  const body = Buffer.from(String(text ?? ''), 'utf8');
  const buf = Buffer.alloc(1 + 8 + 1 + 4 + body.length);
  let off = 0;
  buf.writeUInt8(9, off); off += 1;              // TYPE_SET_CLIPBOARD
  clipSequence += 1;
  buf.writeBigInt64BE(BigInt(clipSequence), off); off += 8;
  buf.writeUInt8(1, off); off += 1;              // paste = true（让设备侧标记为可粘贴）
  buf.writeInt32BE(body.length, off); off += 4;
  body.copy(buf, off);
  return sendControl(buf);
}

/**
 * 从视频流里拿一张实时画面。
 *
 * ## 和 `shot()` 的区别（实测数据）
 *
 * ```
 * shot()        screencap   143 ms/帧   7 fps   每次一次 adb 往返
 * liveShot()    视频流解码    4 ms/帧  25 fps   不占 adb 通道
 * ```
 *
 * 但 liveShot 有个**严格前提**：画面必须在他妈的动，scrcpy 才会发帧。
 * 静止的屏（空虚拟屏、纯黑）一个包都收不到，这时会返回 `ok:false`，
 * 调用方应该回退到 `shot()`。
 *
 * ## 为什么不是「更快就无脑用它」
 *
 * 它是**编解码后的画面**，可能比 screencap 少几个像素的精度（H.264 有损），
 * 而且要求画面有变化。所以策略应该是：
 *   · 要快的连续观察 → liveShot
 *   · 要一张确定准确的定帧 → shot
 *
 * @param {object} [o]
 * @param {string} [o.dir='/tmp']  输出目录
 * @param {number} [o.width=0]     缩放宽度，0=原生
 * @returns {Promise<{ok:boolean, path?:string, width?:number, height?:number, ms?:number, fps?:number, hint?:string}>}
 */
export async function liveShot(o = {}) {
  const mod = await import('./video.js');
  const rd = state.videoReader;
  if (!rd) return { ok: false, hint: '视频流没接上（屏可能没起，或者用了不支持的 server 配置）' };

  const st = mod.stats(rd);
  if (!st.headerDone) return { ok: false, hint: `视频流头部还没到（已收 ${st.bytes} 字节）` };
  if (st.headerError) return { ok: false, hint: st.headerError };
  if (!st.hasKeyframe) {
    return {
      ok: false,
      hint: `视频流有 ${st.frames} 帧但缓冲里还没有关键帧（SPS/PPS），解不出来。`
        + '等画面变化出下一个关键帧，或者用 vdisplay_shot。',
      fps: st.fps,
    };
  }
  if (!st.frames) {
    return {
      ok: false,
      hint: `视频流已连上（${st.width}x${st.height}）但还没收到画面 —— `
        + 'scrcpy 只在画面变化时发帧，静止的屏收不到。这种情况用 vdisplay_shot。',
      fps: 0,
    };
  }

  const dir = String(o.dir || '/tmp').replace(/\/+$/, '') || '/tmp';
  const stamp = Date.now();
  const out = `${dir}/vd-live-${stamp}.jpg`;

  // **有常驻解码器就直接读内存**，实测远低于 1ms；没有才回退到按需解 GOP（约 240ms）
  const cached = mod.latestJpeg(rd);
  if (cached && cached.length) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(out, cached);
    const dec = mod.decoderStats(rd);
    return {
      ok: true,
      path: out,
      width: Number(o.width) || st.width,
      height: st.height,
      ms: 0,
      fps: st.fps,
      decoderFrames: dec.frames,
      frameAgeMs: dec.ageMs,
      displayId: state.displayId,
      source: 'persistent-decoder',
    };
  }

  const r = await mod.grabJpeg(rd, { out, width: Number(o.width) || 0 });
  if (!r.ok) return { ok: false, hint: r.hint };
  return {
    ok: true,
    path: r.path,
    width: Number(o.width) || st.width,
    height: st.height,
    ms: r.ms,
    fps: st.fps,
    displayId: state.displayId,
    source: 'on-demand',
  };
}

/** 拿到当前这块屏的视频流解析器（给 video.js 的常驻解码器用） */
export function videoReader() {
  return state.videoReader;
}

/**
 * P0-2：**等画面稳了再截图。**
 *
 * ## 为什么比固定 sleep 强
 *
 * 原来点完之后 `sleep(500)` 再截图。撞上转场/动画中间态就会截到：
 * 半截页面、半透明叠层、运动模糊的字 —— 贵（一张 230-684 token）而且读不准，
 * 模型会判断"页面坏了"，然后做错决策。
 *
 * 现在用 32×32 灰度信号盯：**连续 stableMs 内 tailMad 都低于阈值**才截图。
 * 这个信号免费（本来就在收），粒度 25Hz，比 sleep 准得多。
 *
 * ## 和固定 sleep 的实测差别
 *
 * 固定 500ms：可能还在动（滑动惯性 800ms+），也可能早就稳了（白等）。
 * 这里：稳了立刻截，没稳就等，上限兜底。
 *
 * @param {object} [o]
 * @param {number} [o.stableMs=120]   要连续稳多久才算稳
 * @param {number} [o.maxWaitMs=2500] 最多等多久，超了就用当前帧
 * @param {number} [o.threshold=0.5]  tailMad 低于它算稳（实测滑动时 8-9，静止 0）
 * @returns {Promise<{waitedMs:number, stable:boolean}>}
 */
export async function waitStable(o = {}) {
  const mod = await import('./video.js');
  const st = state.videoReader;
  const stableMs = Number(o.stableMs) || 120;
  const maxWait = Number(o.maxWaitMs) || 2500;
  const th = Number(o.threshold) || 0.5;
  const t0 = Date.now();

  // 没有视频流就别等了，直接返回（调用方按老路走）
  if (!st || !st.sensor || !st.sensor.length) {
    return { waitedMs: 0, stable: null, hint: '没有灰度信号，无法判断稳定性' };
  }

  let quietSince = null;
  for (;;) {
    const m = mod.motion(st, { recent: 8 });
    const now = Date.now();
    if (m.tailMad !== null && m.tailMad < th) {
      if (quietSince === null) quietSince = now;
      if (now - quietSince >= stableMs) {
        return { waitedMs: now - t0, stable: true, tailMad: m.tailMad };
      }
    } else {
      quietSince = null;   // 又动了，重新计时
    }
    if (now - t0 >= maxWait) {
      return {
        waitedMs: now - t0,
        stable: false,
        tailMad: m.tailMad,
        hint: `等了 ${maxWait}ms 还没稳（tailMad=${m.tailMad}），直接截当前帧`,
      };
    }
    await sleep(60);
  }
}

/**
 * P0-3：**自动挑 ROI（局部放大）。**
 *
 * ## 为什么值得
 *
 * token 计价是 `⌈宽/42⌉ × ⌈高/42⌉`，低于 544×544 按地板价 169-180 收。
 * 所以同样 171 token：
 *   · 全屏 720 缩到 360 宽 → 只有 0.5x 像素（字糊）
 *   · 裁一块 360 宽原生 → **1:1 像素**（字清楚）
 *
 * 一倍清晰度的差价，就在这里。
 *
 * ## 怎么挑
 *
 * 优先级：
 *   ① 灰度 bbox（哪里在动）—— 0 成本
 *   ② 最近一次交互坐标 ±120px
 *   ③ 都不可用 → 返回 null，调用方走全屏
 *
 * 然后把区域扩 15% 边距，并保证**不超出屏幕**、**面积不超过整屏 35%**
 * （太大就没有裁剪的意义了）。
 *
 * @param {object} [o]
 * @param {number} [o.minArea=0.04]  区域至少占整屏多少（太小没信息）
 * @param {number} [o.maxArea=0.35]  超过这个比例就不裁了，直接全屏
 * @returns {{x:number,y:number,w:number,h:number,src:string}|null}
 */
export async function pickRoi(o = {}) {
  const mod = await import('./video.js');
  const st = state.videoReader;
  const W = state.width;
  const H = state.height;
  if (!(W > 0 && H > 0)) return null;

  const minArea = Number(o.minArea) || 0.04;
  // 输出宽度：裁剪区超过它就得不到放大收益，就是该往细里挑的信号
  /*
   * **默认输出宽度 544，不是 420。**
   *
   * token 计价是 ceil(w/42)*ceil(h/42)，544 以下全部按地板价 169 收。
   * 所以 420 见方和 544 见方**同一个价钱**，但 544 多了 29.5% 边长、68% 面积。
   *
   * 之前默认 420 是白扔分辨率 —— 纯粹是浪费，没有任何好处。
   * 544 = ceil(544/42)=13 → 13*13=169，正好卡在地板价线上。
   */
  const outW = Number(o.outputWidth) || 544;

  let box = null;
  let src = '';

  // ① 灰度 bbox：32×32 分辨率下 1 格 = 屏宽/32 ≈ 22px
  if (st && st.sensor && st.sensor.length) {
    const m = mod.motion(st, { recent: 10 });
    if (m.lastBbox) {
      const gx = W / 32;
      const gy = H / 32;
      box = {
        x: m.lastBbox.minX * gx,
        y: m.lastBbox.minY * gy,
        w: (m.lastBbox.maxX - m.lastBbox.minX + 1) * gx,
        h: (m.lastBbox.maxY - m.lastBbox.minY + 1) * gy,
      };
      src = 'sensor-bbox';
    }
  }

  // ② 回退：最近一次交互坐标
  if (!box && state.lastInputAt) {
    const { x, y } = state.lastInputAt;
    const r = 120;
    box = { x: x - r, y: y - r, w: r * 2, h: r * 2 };
    src = 'last-input';
  }

  if (!box) return null;

  // 扩 15% 边距（别把控件边缘切掉）
  const mx = box.w * 0.15;
  const my = box.h * 0.15;
  let x = Math.max(0, Math.round(box.x - mx));
  let y = Math.max(0, Math.round(box.y - my));
  let w = Math.round(box.w + mx * 2);
  let h = Math.round(box.h + my * 2);

  // 贴边修正
  if (x + w > W) w = W - x;
  if (y + h > H) h = H - y;
  if (w < 40 || h < 40) return null;

  const area = (w * h) / (W * H);
  if (area < minArea) {
    // 太小了，扩到最小面积（以中心扩）
    const need = Math.sqrt(minArea * W * H);
    const cx = x + w / 2;
    const cy = y + h / 2;
    w = Math.min(W, Math.round(need));
    h = Math.min(H, Math.round(need));
    x = Math.max(0, Math.min(W - w, Math.round(cx - w / 2)));
    y = Math.max(0, Math.min(H - h, Math.round(cy - h / 2)));
  } else if (w > outW) {
    /*
     * **判据是「裁剪后能不能 1:1」，不是「面积有没有超过某个比例」。**
     *
     * 第一版用 `area > 0.35` 判断该不该裁 —— 实测横屏 B站首页拿到 720×517、
     * 面积 0.32，刚好没超阈值于是原样返回，输出 420 宽时放大率只有 0.58x，
     * 白丢裁剪红利。
     *
     * 正确的判据：输出宽度是 outW 时，裁剪区宽度**超过 outW 就没有放大收益了**。
     * 这时候应该在包围盒里挑一块 outW 见方（且不超过 544 地板价上限）的子区，
     * 挑变化最密集的位置。这样无论画面动得多散，都能拿到 1:1 像素。
     */
    // 544 是地板价上限；再大就开始按面积收费了（560² = 196 token）
    const side = Math.min(Math.max(outW, 64), 544, W, H);
    const winCells = Math.max(1, Math.round((side / W) * 32));
    const hot = mod.densestCellWindow(st, winCells);
    if (!hot) return null;                      // 没有热力图数据，只能放弃
    const gx = W / 32;
    const gy = H / 32;
    w = side;
    h = side;
    x = Math.max(0, Math.min(W - w, Math.round(hot.cx * gx - w / 2)));
    y = Math.max(0, Math.min(H - h, Math.round(hot.cy * gy - h / 2)));
    src = `${src}+hotspot`;
  }

  return { x, y, w, h, src, area: Math.round(((w * h) / (W * H)) * 100) / 100 };
}

/**
 * 黑屏探针：判断这块屏上「视频/受保护内容」是不是抓不到。
 *
 * ## 为什么这条最要紧
 *
 * Android 对受保护内容（DRM 视频、银行界面）会给窗口设 `FLAG_SECURE`，
 * 任何截屏 API 拿到的都是**纯黑**。这不分 screencap / scrcpy 流 / MediaProjection
 * —— 全是黑的，是无 root 的硬边界。
 *
 * 所以它决定三条产品线的生死：
 *   · 会员长视频（腾讯/爱奇艺 VIP）
 *   · 微信视频号
 *   · 游戏过场动画
 *
 * ## 三态判定（必须分开记，不能混成「通过/失败」）
 *
 *   A 正常出画     → 视频区有内容，可以做
 *   B 视频区黑但 UI 可读 → FLAG_SECURE，结构性不可做
 *   C 整屏黑/App 拒启动  → 虚拟屏不支持这个 App
 *
 * B 和 C 的区别很重要：B 是「内容受保护」，C 是「这个 App 不认虚拟屏」。
 *
 * ## 判据
 *
 * 用灰度统计，不看像素内容：
 *   · 整屏 max == 0            → C（全黑）
 *   · 下半屏 max 很小、上半屏正常 → B（视频区黑，UI 可读）
 *   · 两半都有内容             → A
 *
 * @returns {Promise<{verdict:'A'|'B'|'C'|'?', ...}>}
 */
export async function probeSecure(o = {}) {
  const mod = await import('./video.js');
  const st = state.videoReader;

  // 先拿一张全尺寸帧做像素级统计（不走 OCR，快）
  const shotR = await shot(o.dir || '/tmp', { width: 360 });
  if (!shotR.ok) return { ok: false, verdict: '?', hint: `截图失败：${shotR.hint}` };

  const { execFile } = await import('node:child_process');
  // 用 ffmpeg 把图缩成 16x16 灰度，读原始像素 —— 比装图像库轻
  const raw = await new Promise((resolve) => {
    const p2 = execFile('ffmpeg', [
      '-v', 'error', '-i', shotR.path,
      '-vf', 'scale=16:16:flags=area,format=gray',
      '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ], { encoding: 'buffer', maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : stdout));
    if (!p2) resolve(null);
  });
  if (!raw || raw.length < 256) {
    return { ok: false, verdict: '?', hint: '读不出像素（ffmpeg 失败）' };
  }

  // 分上下两半统计（视频一般在上，UI 在下；这里只做粗判）
  const half = 128;   // 16x16 的上半 8 行 = 128 像素
  let upMax = 0, downMax = 0, upSum = 0, downSum = 0;
  for (let i = 0; i < 256; i += 1) {
    const v = raw[i];
    if (i < half) { upSum += v; if (v > upMax) upMax = v; }
    else { downSum += v; if (v > downMax) downMax = v; }
  }
  const upMean = upSum / half;
  const downMean = downSum / half;
  const wholeMax = Math.max(upMax, downMax);

  /*
   * 三态判定。
   *
   * **这里踩过一个假阳性，值得写下来。**
   *
   * 第一版规则是「上黑下亮 = FLAG_SECURE」。实测遇到一个「打开方式」选择器弹窗
   * （底部 bottom sheet + 黑色背景），上 max=0 下 max=189，被误判成 B。
   * 截图一看根本不是受保护内容，就是个选择器。
   *
   * 所以现在 B 判得更严：**必须同时**
   *   ① 上黑下亮，且
   *   ② 黑色区域占比很大（不是薄薄一条），且
   *   ③ 下半部有明显内容（说明 App 确实在渲染，只是上半部被屏蔽）
   *
   * 而且 B 只作为**怀疑**，最终确认要靠窗口标志（`secureWindows()`）。
   */
  let verdict = '?';
  let why = '';
  let confidence = 'low';
  if (wholeMax === 0) {
    verdict = 'C';
    why = '整屏纯黑 —— App 可能拒绝在虚拟屏渲染，或者根本没起来';
    confidence = 'high';
  } else if (upMax <= 6 && downMax > 40) {
    // 上黑下亮：可能是 FLAG_SECURE，也可能是底部弹窗，需要进一步确认
    verdict = 'B?';
    why = '上半屏纯黑、下半屏有明显内容 —— 疑似 FLAG_SECURE，但底部弹窗也会这样，需核对窗口标志';
    confidence = 'low';
  } else if (upMax > 20 && downMax > 20) {
    verdict = 'A';
    why = '上下都有内容，出画正常';
    confidence = 'high';
  } else {
    verdict = '?';
    why = `分不清（上 max=${upMax} 下 max=${downMax}）`;
    confidence = 'low';
  }
  // 顺便查一下窗口标志 —— 这才是 FLAG_SECURE 的权威证据
  let secureWins = null;
  try {
    const w = await shell('dumpsys window windows 2>/dev/null | grep -c "FLAG_SECURE"');
    secureWins = Number(String(w).trim()) || 0;
  } catch { /* 查不到就算了 */ }

  // 有窗口标志这个权威证据时，用它纠正 B?
  if (verdict === 'B?' && secureWins !== null) {
    if (secureWins === 0) {
      verdict = 'A?';
      why += '（但 dumpsys 里没有任何 FLAG_SECURE 窗口，所以大概率不是受保护内容，而是弹窗）';
    } else {
      confidence = 'high';
      why += `（dumpsys 里有 ${secureWins} 个 FLAG_SECURE 窗口，支持这个判断）`;
    }
  }

  return {
    ok: true,
    verdict,
    confidence,
    secureWins,
    why,
    upMax, downMax, upMean: Math.round(upMean), downMean: Math.round(downMean),
    path: shotR.path,
    displayId: state.displayId,
    hint: verdict === 'B'
      ? '这块屏上的受保护内容抓不到（FLAG_SECURE）。换非 DRM 内容，或者接受这条线做不了。'
      : undefined,
  };
}

/** 视频流的现状（给诊断用） */
export async function videoStats() {
  const mod = await import('./video.js');
  const st = state.videoReader;
  const base = mod.stats(st);
  return { ...base, decoder: mod.decoderStats(st) };
}

/**
 * 起常驻解码器。之后 liveShot 直接读内存，不再等解码。
 *
 * 冷启动要等一个关键帧（实测约 10 秒），期间 `liveShot` 会返回「还没关键帧」。
 * 想立刻有画面就先调一次 `shot()`。
 */
export async function startLive(o = {}) {
  const mod = await import('./video.js');
  if (!state.videoReader) return { ok: false, hint: '视频流没接上（屏可能没起）' };
  return mod.startDecoder(state.videoReader, o);
}

/** 停常驻解码器 */
export async function stopLive() {
  const mod = await import('./video.js');
  if (!state.videoReader) return { ok: true, stopped: false };
  return mod.stopDecoder(state.videoReader);
}

/**
 * 一次「画面现在变了多少」的廉价探测。
 *
 * ## 为什么不能用 frameHash 做输入校验
 *
 * 原来 input() 用 `frameHash()` 前后各截一张图比哈希：**两次 screencap = 286ms**，
 * 而且实测会误判 —— 明明视频流涨了 8 帧（画面确实变了），哈希却判"没变"，
 * 于是 `ok:false`，调用方以为没生效就重试，造成重复操作。
 *
 * ## 用视频流包数当信号
 *
 * scrcpy 的编码器**只在画面变化时出帧**。所以「包数涨没涨」就是最直接的
 * 「画面变了没」的证据，而且：
 *   · 免费（包本来就在收）
 *   · 即时（一次内存读取，0ms）
 *   · 更灵敏（25fps 粒度 vs screencap 的 143ms 粒度）
 *
 * 视频流不可用时才回退到 screencap 哈希。
 */
function frameTick() {
  const st = state.videoReader;
  // **必须用单调递增的 frames，不能用 packets.length。**
  // packets 缓冲上限 400，16 秒后饱和不再增长 → 每次 input 都以为"画面没变"，
  // 退化成两次 screencap，单次输入从 243ms 涨到 2 秒以上。
  // 审计发现：watchFrames 的注释写过这个坑，但 frameTick 没改。
  if (st && typeof st.frames === 'number') return { kind: 'frames', v: st.frames };
  if (st && st.packets) return { kind: 'packets', v: st.packets.length };
  return { kind: 'none', v: 0 };
}

/** 等画面变化：返回 true 表示在 waitMs 内观察到了变化。 */
async function waitChanged(tick, waitMs = 900) {
  const t0 = Date.now();
  for (;;) {
    const cur = frameTick();
    if (cur.kind === tick.kind && cur.v !== tick.v) return true;
    if (Date.now() - t0 >= waitMs) return false;
    await sleep(60);
  }
}

async function frameHash() {
  // 必须刷新 SF id：转屏后旧 id 失效，两次 screencap 都失败会让 before/after 都为 null，
  // 于是 changed 变 null、调用方看到 ok=true —— **校验被静默关闭**（监督复核指出的高危项）。
  await refreshSfId();
  if (!state.sfId) return null;
  const capOnce = async () => {
    const r = await adb(['exec-out', 'screencap', '-p', '-d', String(state.sfId)], 20000);
    return r.ok && r.out ? r.out : null;
  };
  let buf = await capOnce();
  // **必须传 true 强制刷新。**
  // refreshSfId() 加了 2 秒 TTL，这里刚刷过就会命中缓存拿到同一个失效 id，
  // 于是两次 capOnce 都失败 → 返回 null → changed=null → ok:true，
  // 注释里说的「校验被静默关闭」又被 TTL 关回去了（对抗审查指出）。
  if (!buf) { await refreshSfId(true); buf = await capOnce(); }
  if (!buf) return null;
  const { createHash } = await import('node:crypto');
  return createHash('sha1').update(buf, 'utf8').digest('hex');
}

/**
 * 定向输入。kind: tap | swipe | text | key | paste
 *
 * 默认会在动作前后各取一次画面哈希：**画面没变就返回 changed:false**，
 * 让调用方知道"这一下没生效"，而不是像以前那样一律 ok:true（实测 一定比例 白点）。
 * 传 verify:false 可跳过校验（省 2 次截图，约 0.3 秒），适合连续点同一个界面时。
 */
/** 把「当前操作方式 + 风控等级」写到浮窗能读到的地方。
 *
 *  浮窗（Java 进程）和插件（Node 进程）是两个进程，
 *  共同能写的地方只有 /data/local/tmp。落一行文本最省事，不用开 socket。
 *
 *  为什么要给用户看：风控等级越高，能用的操作就越朴素（越要拟人化）。
 *  用户看得见当前在哪一档，才知道为什么这一步慢了、为什么不直接点。
 */
export function markOpMode(text) {
  /* 插件跑在 proot 里，没有设备的 /data/local/tmp，只能通过 adb 写。
   * 用 fire-and-forget：这一步只是为了给用户看状态，不能拖慢真正的操作，
   * 所以不 await、失败也不管。 */
  try {
    const t = String(text || '').replace(/["'`$\\]/g, '').slice(0, 60);
    adb(['shell', 'mkdir -p /data/local/tmp/dshframe; echo "' + t + '" > /data/local/tmp/dshframe/opmode'])
      .catch(() => {});
  } catch { /* ignore */ }
}

export async function input(kind, a = {}) {
  try { markOpMode('注入·' + kind); } catch {}
  const s = await start();
  if (!s.ok) return { ok: false, hint: s.hint };
  const d = state.displayId;
  let cmd;
  // 归一化坐标：给 nx/ny（0..1）就按当前屏尺寸换算，省得调用方猜坐标系。
  // 实测白点率 一定比例 的主因不是点不准，是模型不知道屏多大、坐标系对不上。
  // 三种坐标写法，优先级从高到低：
  //   nx/ny（0..1）  —— 最稳，永远对
  //   x/y            —— **按"上一次截图里的像素"理解**，自动放大到显示坐标
  //   都没给         —— (0,0)
  //
  // 为什么要换算 x/y：截图默认是 540 宽，而显示是 720x1280。
  // 实测照图片像素直接传会系统性偏 33%（点放大镜画面零变化）。
  // 先刷新真实尺寸：转屏后 state.width/height 是初始声明值，直接用来算 nx/ny 会点到屏外。
  await refreshRealSize();
  // **交付图可能只是屏幕的一块（region），也可能被裁过（cropPx）。**
  // 之前的实现只按「图宽 / 屏宽」比例换算，完全没算 region 的偏移 ——
  // 于是看过 region 图之后，模型按那张图的像素给 x/y，会点到屏幕左上角那片去。
  // 对抗审查给的算例：720 屏 + region{x:180,y:300,w:360,h:600} + 交付 420 宽，
  // 图内 (100,50) 应该是屏幕 (265.7,342.9)，旧算法给出 (171.4,85.7)，差了一个 region 偏移。
  const regionUsed = state.lastShotRegion;
  const imgW = state.lastShotImgWidth || state.width;

  /*
   * 坐标换算，**四个坐标全部走同一套逻辑**。
   *
   * 上一版在这里连着翻过两次车，都记在下面，免得第三次重犯：
   *
   * ① 有 region 时漏了偏移 → 看过局部图后点按全错。
   * ② 修 ① 的时候把无 region 的基准写成「图宽」而不是「屏宽」：
   *      scale = (region ? region.w : imgW) / imgW
   *    无 region 时恒等于 1，而正确值是 720/540=1.333，
   *    于是默认截图（540 宽）之后按图内像素点按，**系统偏 33%**。
   *    这条比 ① 更险，因为它坏的是最常用的路径，而端到端测试当时只覆盖了 region 算例。
   * ③ swipe 只修了起点 x，起点还读错了字段（读 a.x 而用户给的是 a.x1），
   *    于是 swipe 起点恒为 0，实测会变成从屏幕最左边斜着划，可能触发返回手势把 App 划走。
   *
   * 所以现在：**屏幕像素 = region 偏移 + 图内像素 × (region尺寸 / 图尺寸)**，
   * region 不存在时退化成「屏尺寸 / 图尺寸」。nx/ny 是归一化，按同一基准换算。
   */
  const baseW = regionUsed ? regionUsed.w : state.width;
  const baseH = regionUsed ? regionUsed.h : Math.max(1, state.height - Math.round(Number(a.cropBottom) || 0));
  const offX = regionUsed ? regionUsed.x : 0;
  const offY = regionUsed ? regionUsed.y : 0;
  const scaleX = imgW > 0 ? baseW / imgW : 1;
  // 图高按宽等比推（出图是等比缩放的）；拿不到图高就沿用 x 的比例
  const imgH = (state.lastShotImgHeight && state.lastShotImgHeight > 0)
    ? state.lastShotImgHeight
    : imgW * (state.height / Math.max(1, state.width));
  const scaleY = imgH > 0 ? baseH / imgH : scaleX;

  /** 取某个坐标字段的映射结果；nx 优先，其次像素 */
  const mapX = (nxKey, xKey) => {
    if (a[nxKey] !== undefined && a[nxKey] !== null) return Math.round(offX + Number(a[nxKey]) * baseW);
    if (a[xKey] === undefined || a[xKey] === null) return null;
    return Math.round(offX + Number(a[xKey]) * scaleX);
  };
  const mapY = (nyKey, yKey) => {
    if (a[nyKey] !== undefined && a[nyKey] !== null) return Math.round(offY + Number(a[nyKey]) * baseH);
    if (a[yKey] === undefined || a[yKey] === null) return null;
    return Math.round(offY + Number(a[yKey]) * scaleY);
  };

  const toX = () => mapX('nx', 'x') ?? 0;
  const toY = () => mapY('ny', 'y') ?? 0;


  /*
   * **基准必须在这里采，不能在后面。**
   *
   * 走 scrcpy 控制通道时，事件在「构造命令」阶段就发出去了（下面 tap 分支里
   * sent === bufs.length 就把 cmd 置 null），而原代码把 tick 采样放在 1829 行
   * —— **先注入、后采基准**。
   *
   * 后果：对「只重绘一帧就静止」的控件（复选框、开关、单帧跳转），
   * 基准里已经包含了这次变化 → waitChanged 永远看不到增量 → changed=false
   * → 3 次补轮询也看不到 → ok:false +「这一下可能真的没生效」
   * → 调用方重试 → **重复点击**（购买/发送类操作会出事）。
   *
   * 独立复核指出这是三个最危险的问题之一，修法就是把采样点提前。
   */
  // **verify 必须在这里就声明**：它原来在 1836 行（分派之后），
  // 而 tick 采样要在分派之前，直接用会踩 const 的暂时性死区
  // （ReferenceError: Cannot access 'verify' before initialization，实测踩到）。
  const verify = a.verify !== false;
  const tick = verify ? frameTick() : null;

  if (kind === 'tap') {
    // **优先走 scrcpy 控制通道**：能给真实压力、能插 MOVE、延迟也低。
    // 只有控制通道不可用（老 server / socket 断了）才退回 adb input。
    const inj = await import('./inject.js');
    const useCtl = sendControlRaw() !== null;
    if (useCtl) {
      const sw = state.width; const sh = state.height;
      const { bufs } = inj.buildTap({
        x: toX(), y: toY(), screenW: sw, screenH: sh,
        holdMs: Number(a.holdMs) || (60 + Math.random() * 90),
        moves: 2 + Math.floor(Math.random() * 3),
      });
      let sent = 0;
      for (let k = 0; k < bufs.length; k += 1) {
        if (!sendControl(bufs[k])) break;
        sent += 1;
        if (k < bufs.length - 1) await sleep(8 + Math.random() * 14);
      }
      if (sent === bufs.length) {
        state.lastInjectVia = 'scrcpy-control';
        cmd = null;   // 已经注入完，不再走 adb
      } else {
        cmd = `input -d ${d} tap ${toX()} ${toY()}`;
        state.lastInjectVia = 'adb-input-fallback';
      }
    } else {
      cmd = `input -d ${d} tap ${toX()} ${toY()}`;
      state.lastInjectVia = 'adb-input';
    }
  } else if (kind === 'hold') {
    /*
     * 按住不动（游戏摇杆 / 长按菜单 / 挖方块）。
     *
     * 和 swipe 的区别：起点终点基本相同，重点是**持续**送 60Hz 的 MOVE。
     * 实测固定 14 步在 5 秒长按时会退化成 3Hz，游戏直接当手指没动。
     */
    const hx = a.nx != null ? Number(a.nx) * state.width : Number(a.x);
    const hy = a.ny != null ? Number(a.ny) * state.height : Number(a.y);
    if (!Number.isFinite(hx) || !Number.isFinite(hy)) return { ok: false, hint: 'hold 需要坐标（x/y 或 nx/ny）' };
    const inj = await import('./inject.js');
    if (sendControlRaw() === null) {
      // 控制通道不可用时 hold 没法做（adb input 没有等价的「按住不放」）
      return { ok: false, hint: 'hold 需要 scrcpy 控制通道，当前不可用' };
    }
    const h = inj.buildHold({
      x: hx, y: hy, screenW: state.width, screenH: state.height,
      ms: Number(a.ms) || 1000,
      jitter: a.jitter != null ? Number(a.jitter) : 2,
      driftX: Number(a.driftX) || 0,
      driftY: Number(a.driftY) || 0,
    });
    // 按 buildHold 算出的间隔逐帧送出去
    let sentH = 0;
    for (let k = 0; k < h.bufs.length; k += 1) {
      if (!sendControl(h.bufs[k])) break;
      sentH += 1;
      if (k < h.delays.length) await sleep(h.delays[k]);
    }
    // 和 tap/swipe 一致：直接 return，不设外层变量
    return { ok: sentH > 0, displayId: d, out: `hold ${sentH} 帧（${h.bufs.length - 2} 个 MOVE @60Hz, ${h.totalMs}ms）`, changed: null };
  } else if (kind === 'multitouch') {
    /*
     * 双指手势：一根手指按住不动（摇杆），另一根滑动（转视角）。
     *
     * 游戏双手操作的基础 —— 现在只有单指，走位和转视角不能同时做。
     */
    const p1 = a.p1 || { nx: a.nx1, ny: a.ny1 };
    const p2 = a.p2 || { nx: a.nx2, ny: a.ny2 };
    const f = (q, kx, ky) => ({
      x: q[kx] != null ? Number(q[kx]) * state.width : Number(q.x || 0),
      y: q[ky] != null ? Number(q[ky]) * state.height : Number(q.y || 0),
    });
    const P1 = f(p1, 'nx', 'ny');
    const P2 = f(p2, 'nx', 'ny');
    const P2T = a.p2To ? f(a.p2To, 'nx', 'ny') : P2;
    if (!Number.isFinite(P1.x) || !Number.isFinite(P2.x)) {
      return { ok: false, hint: 'multitouch 需要 p1 和 p2 的坐标（nx/ny 或 x/y）' };
    }
    const inj = await import('./inject.js');
    if (sendControlRaw() === null) {
      return { ok: false, hint: 'multitouch 需要 scrcpy 控制通道（adb input 不支持多指）' };
    }
    const mt = inj.buildMultiTouch({
      p1: P1, p2: P2, p2To: P2T,
      screenW: state.width, screenH: state.height,
      ms: Number(a.ms) || 600,
      p1DriftX: Number(a.driftX) || 0,
      p1DriftY: Number(a.driftY) || 0,
      releaseP1: a.releaseP1 !== false,
    });
    let sent = 0;
    for (let k = 0; k < mt.bufs.length; k += 1) {
      if (!sendControl(mt.bufs[k])) break;
      sent += 1;
      if (k < mt.delays.length) await sleep(mt.delays[k]);
    }
    return { ok: sent > 0, displayId: d, out: `multitouch ${sent} 帧（双指 ${mt.totalMs}ms）`, changed: null };
  } else if (kind === 'swipe') {
    // **四个坐标都要映射，起点也不能漏。** 上一版起点读的是 a.x（用户给的是 x1），
    // 于是恒为 0；另外 y1/x2/y2 只乘比例没加 region 偏移。
    const sx = mapX('nx1', 'x1'); const sy = mapY('ny1', 'y1');
    const ex = mapX('nx2', 'x2'); const ey = mapY('ny2', 'y2');
    if (sx === null || sy === null || ex === null || ey === null) {
      return { ok: false, hint: 'swipe 需要完整坐标：x1/y1/x2/y2（或 nx1/ny1/nx2/ny2）。' +
        ' 拒绝用 0 当默认值 —— 那会从屏幕最左边划出去，在开了手势导航的屏上可能把 App 划走。' };
    }
    // 同上：优先控制通道。**swipe 的收益更大** ——
    // `adb input swipe` 的 MOVE 是严格等距线性的，行为统计一眼能看出来；
    // 走控制通道可以按缓动曲线走、叠加垂直抖动、压力沿轨迹变化。
    const inj2 = await import('./inject.js');
    if (sendControlRaw() !== null) {
      const swp = inj2.buildSwipe({
        x1: sx, y1: sy, x2: ex, y2: ey,
        screenW: state.width, screenH: state.height,
        ms: Number(a.ms) || 300,
        steps: Number(a.steps) || 14,
      });
      let sentAll = true;
      for (let k = 0; k < swp.bufs.length; k += 1) {
        if (!sendControl(swp.bufs[k])) { sentAll = false; break; }
        const wait = k < swp.delays.length ? swp.delays[k] : 8;
        await sleep(wait);
      }
      if (sentAll) {
        state.lastInjectVia = 'scrcpy-control';
        cmd = null;
      }
    }
    // **只有控制通道没发成功才回退到 adb。**
    // 原来这行是无条件执行的，于是控制通道发完之后又被 adb 覆盖了一遍 ——
    // 每次滑动实际滑两下（翻页翻两页）。tap 分支没这个问题，对比上面 tap 的写法。
    //
    // 用显式布尔判断而不是 `cmd !== null`：`let cmd;` 的初值是 undefined，
    // `undefined !== null` 为真，靠这个特性"碰巧对"是脆的，改成看得懂的写法。
    if (cmd === undefined) {
      cmd = `input -d ${d} swipe ${sx} ${sy} ${ex} ${ey} ${Number(a.ms) || 300}`;
    }
  }
  else if (kind === 'text') {
    const txt = String(a.text ?? '');
    // 实测：非 ASCII（中文）走 input text 会让设备侧抛 NPE，而且异常文本会被当输出回填。
    // 别假装支持——直接告诉调用方改用 paste。
    if (/[^\x00-\x7F]/.test(txt)) {
      return { ok: false, hint: 'input text 只支持 ASCII。中文等非 ASCII 字符请改用 kind:"paste"（需先让剪贴板里有内容）。' };
    }
    if (!/^[\w\s.,:/@#%&*()\-+=?!']{0,400}$/.test(txt)) return { ok: false, hint: 'text 含不支持的字符' };
    cmd = `input -d ${d} text "${txt.replace(/["\\$`]/g, '')}"`;
  } else if (kind === 'key') cmd = `input -d ${d} keyevent ${String(a.key || '').replace(/[^A-Z0-9_]/gi, '')}`;
  else if (kind === 'paste') {
    // 两种用法，行为不同：
    //  带 text  → 发 SET_CLIPBOARD(paste=1)，**server 自己会粘一次**，不能再补 keyevent，
    //             否则内容会粘两遍（复核实测：ZQ中文 → ZQ中文ZQ中文）。
    //  不带 text → 发 KEYCODE_PASTE，粘设备剪贴板里现有的内容。
    //
    // 注意：剪贴板是系统全局的，写它就是覆盖用户自己的剪贴板内容。
    if (a.text !== undefined && a.text !== null && String(a.text) !== '') {
      if (!setClipboard(String(a.text))) {
        return { ok: false, hint: '写剪贴板失败（控制通道没连上）。可以改用 kind:"text"（仅 ASCII）。' };
      }
      await sleep(300);   // SET_CLIPBOARD 已经连带粘贴，等它生效即可
      cmd = null;         // 不再补 keyevent
    } else {
      cmd = `input -d ${d} keyevent 279`;   // KEYCODE_PASTE：粘现有剪贴板
    }
  }
  else return { ok: false, hint: `不认识的输入类型：${kind}` };

  // 记下这次点/滑的位置，pickRoi 在没有 bbox 时用它兜底
  state.lastInputAt = {
    x: a.nx != null ? Number(a.nx) * state.width : (Number(a.x) || 0),
    y: a.ny != null ? Number(a.ny) * state.height : (Number(a.y) || 0),
  };

  // verify 已在前面声明（tick 采样需要它）
  /*
   * **优先用视频流包数做校验，不用 screencap 哈希。**
   *
   * 实测：一次滑动让视频流从 102 个包涨到 110 个（画面确实变了），
   * 但 frameHash 前后哈希一样，于是返回 ok:false，调用方以为失败会重试。
   * 而且每次双截图要 286ms。
   *
   * 包数探测是 0ms、免费、而且 25fps 粒度比 screencap 的 143ms 灵敏。
   */
  // tick 已经在分派之前采好了（见上面的注释）
  // SET_CLIPBOARD 那条路 cmd 是 null（server 已经自己粘过，不能再发 keyevent）
  const out = cmd ? await shell(cmd) : '（SET_CLIPBOARD 已连带粘贴）';
  if (!verify) return { ok: true, displayId: d, out: out.trim(), changed: null };

  await sleep(Number(a.settleMs) || 500);
  let changed = null;
  let probe = 'none';
  // **不能只认 'packets'。**
  // frameTick() 现在优先返回 { kind:'frames' }（videoReader 有 frames 字段时），
  // 只认 'packets' 会永远落进下面的 else 分支 → 两次 frameHash 之间没有 sleep
  // → 同帧 → changed 恒为 false → **每一次点击都报「画面没变」**（对抗审查发现的新回归）。
  if (tick && tick.kind !== 'none') {
    changed = await waitChanged(tick, Number(a.settleMs) || 900);
    probe = 'frame-' + tick.kind;
    if (!changed) {
      // 包数没动可能是编码器暂时没吐，再用 screencap 确认一次（贵但准）
      const bh = await frameHash();
      if (bh) {
        const ah = await sleep(300).then(() => frameHash());
        if (bh && ah && bh !== ah) { changed = true; probe = 'screencap-fallback'; }
      }
    }
  } else {
    // 没有视频流：回退到 screencap 哈希
    // **两次之间必须 sleep**，否则截的是同一帧，永远判「没变」。
    const before = await frameHash();
    await sleep(400);
    const after = await frameHash();
    changed = before && after ? before !== after : null;
    probe = 'screencap';
  }

  // 只查一次会误报。实测：给虚拟屏发 KEYCODE_BACK 退掉设置页，
  // 画面确实变了（随后截是纯黑），但 500ms 那个时间点还没变完，
  // 于是返回 changed:false —— AI 会以为没生效、重复操作，造成双击这类事故。
  // 所以没变的时候再轮询几次，任一次变了就算生效。
  if (changed === false) {
    // 再给一点时间：有些操作（BACK 退动画）在 500ms 那个点还没变完
    for (let i = 0; i < 3 && changed === false; i += 1) {
      await sleep(400);
      if (tick && tick.kind !== 'none') {
        const cur = frameTick();
        if (cur.kind === tick.kind && cur.v !== tick.v) changed = true;
      }
    }
  }

  return {
    ok: changed !== false,          // 轮询完还是没变，才算这次操作大概率没生效
    displayId: d,
    changed,
    probe,                          // 用哪条路判断的：video-packets / screencap / screencap-fallback
    hint: changed === false
      ? '画面在 2 秒内一直没有变化，这一下可能真的没生效（坐标偏了 / 控件不可点 / 界面还没加载完）。建议重新截一张图确认位置，不要盲目重复点同一坐标。'
      : undefined,
    out: out.trim(),
  };
}

/**
 * 截虚拟屏。返回本地路径。
 *
 * 带**画面去重**：如果这一帧和上次截的完全一样，直接返回上次那个路径并标 `unchanged:true`，
 * 调用方就不用再 read_image 了。为什么值得做：一张 720x1280 截图约 1.1k tokens
 * 且永久留在上下文里，长任务翻几屏就把上下文吃满了（实测 15 屏 → 上下文 203k→243k）。
 */
export async function shot(dir = '/tmp', { width = 540, format = 'jpeg', cropPx = 0, region = null } = {}) {
  const s = await start();
  if (!s.ok) return { ok: false, hint: s.hint };

  // **截图前先刷新 SF id**：转屏会让 SurfaceFlinger 重建虚拟屏并换新 id，
  // 拿旧 id 去 screencap 会报 "Display Id is not valid"（或静默截到别的屏）。
  await refreshSfId();
  if (!state.sfId) return { ok: false, hint: '没拿到这块屏的 SurfaceFlinger id，无法截图。' };

  // 只截一次：以前先用 exec-out 算哈希、再 screencap 存文件，同一帧截了两次，
  // 复杂画面每张多花约 0.5 秒。现在截一次、哈希从本地文件算。
  const stamp = Date.now();
  const local = `${dir}/vd-${stamp}.png`;
  const remotePng = `/sdcard/dsh-vd-${stamp}.png`;
  const cap = await shell(`screencap -p -d ${state.sfId} ${remotePng}`);
  if (/Failed|invalid/i.test(cap)) {
    // 可能刚好卡在转屏瞬间：强制重新解析（不沿用旧值）再试一次
    const fresh = await resolveScrcpySfId();
    if (fresh) state.sfId = fresh;
    const cap2 = await shell(`screencap -p -d ${state.sfId} ${remotePng}`);
    if (/Failed|invalid/i.test(cap2)) {
      return {
        ok: false,
        hint: `截图失败：${cap2}\n当前缓存的 SF id=${state.sfId}，重新解析${fresh ? '得到 ' + fresh : '失败（没有 scrcpy 屏，或同时存在多块分不清）'}。`
          + '\n可能虚拟屏已被销毁。可以先 vdisplay_status 确认，再 vdisplay_start 重建。',
      };
    }
  }

  const pull = await adb(['pull', remotePng, local], 60000);
  await shell(`rm -f ${remotePng}`);
  if (!pull.ok) return { ok: false, hint: `拉取失败：${pull.err}` };

  const { readFile: readBin } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const pngBytes = await readBin(local);
  const hash = createHash('sha1').update(pngBytes).digest('hex');

  // 从 PNG 的 IHDR 读真实像素尺寸（宽高在字节 16..24，大端 32 位）。
  // 为什么必须做：游戏强制横屏后这块屏会变成 1280x720，
  // 如果坐标换算还按 720x1280 算，nx/ny 和 x/y 全都会错。
  try {
    if (pngBytes.length > 24 && pngBytes.readUInt32BE(12) === 0x49484452 /* 'IHDR' */) {
      const w = pngBytes.readUInt32BE(16);
      const h = pngBytes.readUInt32BE(20);
      if (w > 0 && h > 0 && (w !== state.width || h !== state.height)) {
        state.width = w;
        state.height = h;
        state.lastShotHash = null;    // 尺寸变了，旧的去重基准作废
        state.lastShotPath = null;
        state.lastShotImgWidth = 0;   // 旧的图片宽度也作废，否则坐标换算倍率会错
      }
    }
  } catch { /* 读不出来就沿用旧值 */ }
    // **去重必须带上出图参数**：以前只比 hash，导致「画面没变时改了 width 或 crop，
    // 拿回来还是上一张旧图」—— 实测把 540 改成 720、开了 crop 都没反应，极易误判成
    // 裁剪功能坏了。现在 hash + 参数全一致才复用。
    const regionKey = region ? `${region.x},${region.y},${region.w},${region.h}` : "-";
    const cacheKey = `${hash}|${width}|${format}|${Math.round(cropPx)}|${regionKey}`;
    if (cacheKey === state.lastShotCacheKey && state.lastShotPath && state.lastShotPath !== local) {
      try {
        const { unlink } = await import('node:fs/promises');
        await unlink(local);
        // **命中缓存也要返回完整字段。** 之前只回 path/displayId/unchanged，
        // 缺 width/height/imageWidth/imageHeight/regionUsed —— 调用方（比如 vdisplay_text）
        // 拿不到尺寸就退回 720x1280 的默认值，算出来的坐标全偏。
        return {
          ok: true, path: state.lastShotPath, displayId: state.displayId, unchanged: true,
          // **必须带 hash。**
          // 这条是「画面没变，复用上次截图」的快路 —— 而它恰恰是最该命中 OCR 缓存的时候。
          // 原来这里不返回 hash，调用方拿到 undefined → cacheKey=null → 缓存永远不命中
          // → 每次仍然白跑 1.6 秒 OCR（对抗审查 + OCR 专项审查都指出了这个洞）。
          hash: state.lastShotHash,
          width: state.lastShotW || state.width, height: state.lastShotH || state.height,
          imageWidth: state.lastShotImgWidth || state.width,
          imageHeight: state.lastShotImgHeight || state.height,
          croppedBottom: 0,
          regionUsed: state.lastShotRegion || null,
          hint: '画面和上次截图完全一样，复用上次那张',
        };
      } catch { /* 删不掉就继续用新的 */ }
    }

  // 转成 540 宽 JPEG。**必须用本地 proot 的 ffmpeg**：设备上没有 ffmpeg
  // （实测 `adb shell ffmpeg` → inaccessible or not found）。
  let finalPath = local;
  // 记录**实际**产出的图片宽度：转码失败会退回原始 PNG（720 宽），
  // 这时如果还按 540 报，坐标换算的倍率就错了，33% 偏移会重新出现
  // （复核实测：PATH 去掉 ffmpeg 后返回 720 宽 PNG 却声明 imageWidth 540）。
  let finalImgWidth = state.width;
  // region：只看屏幕的某一块，把那一块按 width 交付。
  // **为什么这样比全屏缩放强**：全屏 720 宽交付到 420 是 0.583x（缩了）；
  // 取 360 宽的局部交付到 420，是 1.167x —— 相对全屏有 2 倍线性分辨率，
  // 而 360x796 面积 286K 刚好卡在地板价上，只要 180 token（全屏要 684）。
  // 也就是说：更少的 token，两倍的细节。这就是"看不清就放大"的正确做法。
  const regionFilter = (() => {
    if (!region || !Number.isFinite(region.w) || region.w <= 0) return '';
    const rx = Math.max(0, Math.round(region.x || 0));
    const ry = Math.max(0, Math.round(region.y || 0));
    const rw = Math.round(region.w);
    const rh = Math.round(region.h || 0);
    if (rw < 8 || rh < 8) return '';
    // 越界必须拦下来：ffmpeg 的 crop 默认 exact=0，会给一个超界的框自动平移进图内
    // （比如 720 宽屏上要 x=700,w=360，实际裁 360..720），结果是看着成功、位置全错。
    // 宁可报错让调用方改，也不静默平移。
    if (state.width && state.height) {
      if (rx + rw > state.width || ry + rh > state.height) {
        region.__oob = `region 超出屏幕范围（屏 ${state.width}x${state.height}，要 ${rx},${ry} ${rw}x${rh}）`;
        return '';
      }
    }
    return `crop=${rw}:${rh}:${rx}:${ry},`;
  })();
  // region 和 crop **互斥**：先 region 再切底部会把 region 里靠下的部分切掉，
  // region 高度 ≤ 裁剪量时 ffmpeg 还会直接报错、退回未裁剪整屏（连 region 都白给）。
  // 有 region 时以 region 为准，忽略 crop。
  // region 越界直接拒绝，不要拿一张位置错的图给模型
  if (region && region.__oob) {
    return { ok: false, hint: region.__oob + '。请改成屏内的坐标，或用 nx/ny 归一化。' };
  }

  const pre = region ? regionFilter : (cropPx > 0 ? `crop=iw:ih-${Math.round(cropPx)}:0:0,` : '');
  if (format === 'jpeg') {
    const jpg = local.replace(/\.png$/, '.jpg');
    // 限制宽高比：region 可能是 100x1000 这种极端形状，按宽缩到 540 会变成 540x5400，
    // 既贵到爆又没法看。按长边限制，同时保证短边不小于 240。
    let targetW = Math.max(240, Math.min(1080, Number(width) || 540));
    if (region && Number(region.w) > 0 && Number(region.h) > 0) {
      const aspect = Number(region.h) / Number(region.w);
      const MAX_H = 2400;
      if (targetW * aspect > MAX_H) targetW = Math.max(240, Math.round(MAX_H / aspect));
    }
      // cropPx > 0 时先裁掉底部（浏览器壳），再缩放。实测 720x1592 → 720x1372，
      // 内容一像素不变，token 从 684 降到 594。裁不动就自动忽略。
      const conv = await new Promise((res) => {
        execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', local, '-vf', `${pre}scale=${targetW}:-1`, '-q:v', '4', jpg],
          (e) => res(!e));
      });
    if (conv) {
      try {
        const { access } = await import('node:fs/promises');
        await access(jpg);
        finalPath = jpg;
        finalImgWidth = targetW;
      } catch { finalPath = local; finalImgWidth = state.width; }
    } else {
      finalPath = local;
      finalImgWidth = state.width;   // 退回 PNG，宽度就是显示宽度
    }
  }
    // PNG 路径也要支持裁剪，否则行为不一致：OCR 走的就是 png，
    // 不带裁剪会多读地址栏里的网址和按钮文字（实测会混进结果里）。
    // PNG 也要支持 region 和 crop，否则行为不一致（OCR 走的就是 png）。
    if (format !== 'jpeg' && (pre || region)) {
      const png2 = local.replace(/\.png$/, '-view.png');
      // 跟 jpeg 分支保持一致：region 和 crop 互斥（region 优先），不要各写一套
      const filt2 = region
        ? `crop=${Math.round(region.w)}:${Math.round(region.h)}:${Math.max(0, Math.round(region.x || 0))}:${Math.max(0, Math.round(region.y || 0))}`
        : (cropPx > 0 ? `crop=iw:ih-${Math.round(cropPx)}:0:0` : '');
      if (filt2) {
        const ok2 = await new Promise((res) => {
          execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', local, '-vf', filt2, png2],
            (e) => res(!e));
        });
        if (ok2) {
          try {
            const { access } = await import('node:fs/promises');
            await access(png2);
            finalPath = png2;
            // PNG 分支只裁不缩，出图宽就是 region 宽（不是屏宽）。写错会让 input 的 scale 错 2 倍。
            finalImgWidth = (region && Number(region.w) > 0) ? Math.round(region.w) : state.width;
          } catch { /* 用原图 */ }
        }
      }
    }
    state.lastShotHash = hash;
    state.lastShotCacheKey = `${hash}|${width}|${format}|${Math.round(cropPx)}|${regionKey}`;
    // 记下这张图是屏幕的哪一块，input 换算坐标时要用（region 没记会导致点歪）
    state.lastShotRegion = region ? { x: Math.max(0, Math.round(region.x||0)), y: Math.max(0, Math.round(region.y||0)), w: Math.round(region.w), h: Math.round(region.h||0) } : null;
  state.lastShotPath = finalPath;
  state.lastShotImgWidth = finalImgWidth;
  state.lastShotW = state.width;
  state.lastShotH = state.height;
  try {
    // 记录实际出图高度，缓存命中时要原样返回
    const { execFileSync } = await import('node:child_process');
    const out2 = execFileSync('ffprobe', ['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','csv=p=0', finalPath], { timeout: 8000 }).toString().trim();
    const parts = out2.split(',').map(Number);
    if (parts.length === 2 && parts[1] > 0) state.lastShotImgHeight = parts[1];
  } catch { state.lastShotImgHeight = state.height; }
  return {
    ok: true, path: finalPath, displayId: state.displayId, unchanged: false,
    hash,   // 必须返回：vdisplay_text 拿它做 OCR 缓存键，不然缓存永远不命中，每次白等 1.6 秒
    // **一定要带尺寸**：之前完全不返回，调用方只能猜坐标系。
    // 注意分清两个尺寸：imageWidth/imageHeight 是**你正在看的这张图**的像素，
    // width/height 是显示的逻辑像素。点 x/y 时按图片像素给就行（插件会自动换算）。
    width: state.width, height: state.height,
    imageWidth: state.lastShotImgWidth || state.width,
    // imageHeight 必须按**实际出图**算：裁剪和 region 都改变了内容区域，
    // 以前直接按整屏比例算，裁剪后返回 1592 而实际只有 1372，谁拿它算坐标就会偏。
    // **分母必须跟 region 一致**：出图高度 = region 高度 × (出图宽 / region 宽)。
    // 之前用 state.width 当分母，region 时算出 464 而实际 929（差 2 倍），
    // 谁拿它算坐标就偏一倍 —— 对抗审查第 S6 条。
    imageHeight: Math.round((() => {
      const outW = state.lastShotImgWidth || state.width;
      const srcW = region && Number(region.w) > 0 ? Number(region.w) : state.width;
      const ratio = srcW > 0 ? outW / srcW : 1;
      let contentH = state.height;
      if (cropPx > 0 && cropPx < state.height) contentH -= cropPx;
      if (region && Number(region.h) > 0) contentH = Number(region.h);
      return contentH * ratio;
    })()),
    // 调用方要拿这两个才能把 nx/ny 算对
    croppedBottom: cropPx > 0 && cropPx < state.height ? cropPx : 0,
    regionUsed: region ? { x: region.x || 0, y: region.y || 0, w: region.w, h: region.h } : null,
    hint: `这张图是 ${state.lastShotImgWidth || state.width} 宽，显示逻辑尺寸 ${state.width}x${state.height}。`
      + '点 x/y 按图片里的像素给即可（插件自动换算），或者直接用 nx/ny（0..1）。',
  };
}

/** 主屏截图（只读，不打扰）。 */
export async function mainShot(dir = '/tmp', { width = 540, format = 'jpeg' } = {}) {
  await mkdir(dir, { recursive: true });
  const stamp = Date.now();
  const remote = `/sdcard/dsh-main-${stamp}.png`;
  await shell(`screencap -p ${remote}`);
  const local = join(dir, `main-${stamp}.png`);
  const pull = await adb(['pull', remote, local], 60000);
  await shell(`rm -f ${remote}`);
  if (!pull.ok) return { ok: false, hint: pull.err };

  // **参数必须真的生效。** tool-spec 承诺"width 默认 540，省约 44% token""format jpeg 默认"，
  // 但实现一直只回原生 PNG（1.1MP+，token 是承诺的 3-5 倍），长任务里很吃上下文。
  // 这里按跟 vd.shot 一样的规则走一次 ffmpeg。
  let finalPath = local;
  let finalW = 0;
  try {
    const { execFileSync } = await import('node:child_process');
    const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', local], { timeout: 8000 }).toString().trim();
    const parts = probe.split(',').map(Number);
    const srcW = parts[0] || 0;
    finalW = srcW;
    const targetW = Math.max(240, Math.min(1080, Number(width) || 540));
    const ext = format === 'png' ? 'png' : 'jpg';
    const out = local.replace(/\.png$/, `-s.${ext}`);
    const vf = format === 'png' ? `scale=${targetW}:-1` : `scale=${targetW}:-1`;
    const args = ['-y', '-loglevel', 'error', '-i', local, '-vf', vf];
    if (format !== 'png') args.push('-q:v', '4');
    args.push(out);
    execFileSync('ffmpeg', args, { timeout: 20000 });
    finalPath = out;
    finalW = targetW;
  } catch { /* ffmpeg 不可用就回原生 PNG，把真实宽度报出去 */ }

  return { ok: true, path: finalPath, imageWidth: finalW };
}

/**
 * 主屏（display 0）当前前台是谁。
 *
 * 不能用 `dumpsys activity activities | grep topResumedActivity` —— 那是**全局**的，
 * 虚拟屏上的 Activity 也会算进来，会误判「主屏被抢」。
 * 也不能用固定行数的 `grep -A40`：有虚拟屏时 display 0 那一段会变长，40 行不够（踩过）。
 * 所以整段解析：找到 "Display: mDisplayId=0" 之后，一直读到下一个 "Display:" 为止。
 *
 * 建屏/销毁的瞬间焦点可能是 null，读一次会拿到空。重试四次，仍空就返回 '' 表示"没测到"，
 * 让调用方区分「没变化」和「没测到」，而不是拿空值当变化（踩过：误判后去 monkey 桌面，把用户屏幕切了）。
 */
export async function mainFocus() {
  for (let i = 0; i < 4; i += 1) {
    const out = await shell('dumpsys window displays 2>/dev/null');
    const lines = out.split('\n');
    let inside = false;
    for (const line of lines) {
      if (/Display:\s*mDisplayId=/.test(line)) {
        inside = /Display:\s*mDisplayId=0\b/.test(line);
        continue;
      }
      if (inside) {
        const m = line.match(/mCurrentFocus=Window\{[0-9a-f]+ u0 ([\w.]+)\/([\w.$]+)\}/);
        if (m) return `${m[1]}/${m[2]}`;
      }
    }
    await sleep(300);
  }
  return '';
}

// **模块加载时恢复上次的屏**，这样新进程不会重复建屏。
try { loadPersistedState(); } catch { /* ignore */ }
