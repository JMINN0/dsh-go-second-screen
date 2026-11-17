/**
 * stream.js — 把虚拟屏的画面以 JPEG 帧的形式，通过本机回环 HTTP 交给原生插件。
 *
 * 为什么不用文件、也不用桥接协议搬帧：
 * - 文件：用户明确说截图占空间。
 * - 桥接协议：只收 JSON 文本帧、每次 ≤32 KiB、限 4 Hz，MJPEG 流塞不进去。
 * 所以走 127.0.0.1 回环：插件取帧（内存）→ 原生侧 fetch → base64 → 面板 image。
 *
 * 实测成本（同一颗 SoC，360x640@2fps）：screencap 133 ms/帧 + ffmpeg 转码 14 ms/帧 ≈ 0.30 核。
 * 帧率才是成本主轴，分辨率不是——screencap 的固定开销约 60 ms（binder/内核拷贝）。
 */
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { adbTarget } from './target.js';

const ADB = process.env.ADB_BIN || 'adb';
const STATE_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugin-screen');
const STATE_FILE = join(STATE_DIR, 'stream.json');

const st = {
  server: null,
  port: 0,
  timer: null,
  latest: null,
  busy: false,
  running: false,
  startedAt: 0,
  fps: 2,
  width: 360,
  sfId: null,
  // **看门狗相关**
  lastFrameFetchAt: 0,   // 上一次有人来取帧（/frame.jpg）
  lastActivityAt: 0,     // 上一次有工具调用（外部调 touch()）
  state: 'idle',         // idle | thinking | looking | acting | done | error
  aspect: 0,             // 真实画面比例 W/H，从 PNG 头读
  doneAt: 0,             // 进入 done 的时刻，用来做「done 后保留 N 秒」
  // **点击标记**：在推流帧上画出「AI 点在哪」，用户能直接看到操作位置
  marks: [],             // [{ nx, ny, at, kind }]，最多留 3 个
  viewers: new Set(),    // MJPEG 长连接的响应对象
  displayId: null,
  focusedApp: '',
  frames: 0,
  errors: 0,
  quality: 7,
};

function runCollect(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    const out = [];
    const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('close', (code) => resolve({ code, out: Buffer.concat(out), err: Buffer.concat(err).toString() }));
    p.on('error', (e) => resolve({ code: -1, out: Buffer.alloc(0), err: String(e.message) }));
  });
}

/**
 * 用 ffmpeg 把 PNG 转成缩放后的 JPEG（走管道，不落盘）。
 *
 * q 越小质量越好、体积越大。实测 360 宽 q7 在彩色桌面上会到 27 KB，
 * base64 后 36 KB —— **超过桥接每次 32 KiB 的硬限，连续 5 次会把插件降级**。
 * 所以调用方要按体积自适应降 q 或缩宽度。
 */
function pngToJpeg(png, width, q = 7) {
  // **点击标记画在缩放之后**，这样坐标直接是输出空间的，不用反算原图尺寸。
  const marks = marksToFilters();
  const vf = marks
    ? `scale=${width}:-1:flags=bilinear,${marks}`
    : `scale=${width}:-1:flags=bilinear`;
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'png_pipe', '-i', 'pipe:0',
      '-vf', vf,
      '-f', 'mjpeg', '-q:v', String(q), 'pipe:1',
    ]);
    const out = [];
    p.stdout.on('data', (d) => out.push(d));
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 && out.length ? Buffer.concat(out) : null));
    p.stdin.on('error', () => {});
    p.stdin.end(png);
  });
}

// base64 占 4/3，还要留 JSON 开销，所以 JPEG 必须 ≤ 22000 字节（与胶囊端 FRAME_MAX 保持一致，否则落在中间区间会出现 stream 认为合格、胶囊每帧丢弃的黑屏）
const JPEG_BUDGET = 22000;

/**
 * 刷新 SurfaceFlinger id。
 *
 * **为什么必须做**：虚拟屏一旦被重建（App 强制横屏就会），SurfaceFlinger 会分配
 * 一个**新的** sfId。还拿旧的去 `screencap -d`，每次都失败，画面冻在最后一帧 ——
 * 用户看到的就是「胶囊一直不动」。
 *
 * 原来 start() 只在开头取一次 sfId，之后永不刷新。这是审代码时发现的真 bug。
 */
async function refreshSfId() {
  try {
    const target = await adbTarget();
    const r = await runCollect(ADB, ['-s', target, 'shell', 'dumpsys SurfaceFlinger --display-id']);
    const txt = String(r.out || '');
    const ids = [...txt.matchAll(/Display\s+(\d{15,})\s*\(\s*Virtual display\)/g)].map(m => m[1]);
    if (!ids.length) return false;
    const next = ids[ids.length - 1];
    if (next === st.sfId) return false;
    st.sfId = next;
    return true;
  } catch { return false; }
}

/** 从 PNG 头读真实宽高（IHDR 在偏移 16/20）。用来算 aspect，不依赖 dumpsys。 */
function pngSize(buf) {
  try {
    if (buf.length < 24) return null;
    // PNG 签名 8 字节 + 长度 4 + "IHDR" 4 = 16，之后是 width/height 各 4 字节
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (w > 0 && h > 0 && w < 10000 && h < 10000) return { w, h };
  } catch { /* 读不出来就算了 */ }
  return null;
}

async function captureAndConvert() {
  // 目标地址现取：adb 插件的 adbd 端口会变，硬编码 5555 会静默抓不到帧。
  const target = await adbTarget();
  const grab = () => runCollect(ADB, ['-s', target, 'exec-out', 'screencap', '-p', '-d', st.sfId]);
  let r = await grab();
  // **失败先怀疑 sfId 失效**（横屏重建、屏被换），刷新后重试一次再报错。
  if (r.code !== 0 || r.out.length === 0) {
    if (await refreshSfId()) r = await grab();
  }
  if (r.code !== 0 || r.out.length === 0) { st.errors += 1; return null; }
  // 读真实尺寸算比例（横竖屏自适应要用）
  const sz = pngSize(r.out);
  if (sz) {
    const a = sz.w / sz.h;
    if (Math.abs(a - st.aspect) > 0.01) { st.aspect = a; writeState(); }
  }

  // 自适应：ffmpeg 的 -q:v 是**数字越大质量越差、文件越小**（2 最好 31 最差）。
  // 之前按 7→4→2 写反了，越调越大，帧反而超标 —— 这里往大的方向调。
  // **从上次成功的 q 开始试，不要每帧都从 7 重跑。**
  // 原来 st.quality 只写不读，导致每帧都从最好质量开始试，转码 14ms 变 30-50ms 还抖动。
  const ladder = [7, 12, 18, 24];
  const startIdx = Math.max(0, ladder.indexOf(st.quality));
  const order = ladder.slice(startIdx).concat(ladder.slice(0, startIdx));
  let last = null;
  for (const q of order) {
    const jpg = await pngToJpeg(r.out, st.width, q);
    if (!jpg) continue;
    last = jpg;
    if (jpg.length <= JPEG_BUDGET) { st.quality = q; return jpg; }
  }
  // 降质量还不够就缩宽度
  const narrower = Math.max(200, Math.round(st.width * 0.7));
  const small = await pngToJpeg(r.out, narrower, 18);
  if (small && (!last || small.length < last.length)) { st.quality = 18; return small; }
  return last;
}

/**
 * 看门狗参数。
 *
 * 之前 tick() 无条件每帧 screencap，不管有没有人看 —— 面板关掉后照样烧 0.3 核。
 * 现在分三档：
 *   - 有人在看（30s 内取过帧）或有工具活动 → 正常抓
 *   - 都没了 → **暂停抓帧**（省 CPU），但保留服务，一有人看立刻恢复
 *   - 长时间（IDLE_SHUTDOWN_MS）彻底没动静 → 自动 shutdown，胶囊消失
 */
const WATCH_MS = 30_000;          // 30s 内取过帧算「有人在看」
const IDLE_PAUSE_MS = 15_000;     // 15s 无活动/无取帧 → 暂停抓帧
const IDLE_SHUTDOWN_MS = 120_000; // 120s 彻底没动静 → 自动关闭
const DONE_KEEP_MS = 30_000;      // done 状态保留 30s 再关（用户要看「完成」）

/** 外部（工具层）在每次操作时调一下，告诉推流「还在干活」。 */
export function touch() {
  st.lastActivityAt = Date.now();
  if (st.state === 'idle' || st.state === 'done') { st.state = 'acting'; st.doneAt = 0; }
  writeState();
}

/** 设置状态：thinking / looking / acting / done / error / idle */
/**
 * 记一次点击位置，推流帧上会画出来。
 *
 * 用户提的需求：实时看到 AI 点在哪、有没有点偏。
 * 成本很低 —— 只是往数组里塞一个归一化坐标，画图由 ffmpeg 的 drawbox 顺手做，
 * 不额外解码、不额外传数据。
 */
export function markTap(nx, ny, kind = 'tap') {
  const x = Number(nx), y = Number(ny);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  st.marks.push({ nx: x, ny: y, at: Date.now(), kind: String(kind).slice(0, 8) });
  if (st.marks.length > 3) st.marks.shift();
  st.lastActivityAt = Date.now();
}

/** 把 marks 变成 ffmpeg 滤镜串（画在缩放之后的坐标系里）。 */
function marksToFilters() {
  const now = Date.now();
  // 只画 5 秒内的，太老的淡出（否则画面上一堆历史点看不清）
  const live = st.marks.filter(m => (now - m.at) < 5000);
  if (!live.length) return '';
  const W = st.width || 360;
  const parts = [];
  for (const m of live) {
    const age = (now - m.at) / 5000;              // 0 = 刚点，1 = 5 秒前
    const alpha = Math.max(0.25, 1 - age).toFixed(2);
    const cx = Math.round(m.nx * W);
    // 高度按 aspect 推（不知道输出高度时用宽度/aspect 估；aspect 没有就按 9:19.5 估）
    const a = (st.aspect > 0.1 && st.aspect < 10) ? st.aspect : 0.5;
    const H = Math.round(W / a);
    const cy = Math.round(m.ny * H);
    const arm = Math.max(6, Math.round(W * 0.022));   // 十字臂长
    const t = Math.max(2, Math.round(W * 0.005));     // 线宽
    // 横线 + 竖线 = 十字
    parts.push(`drawbox=x=${cx - arm}:y=${cy - t}:w=${arm * 2}:h=${t * 2}:color=red@${alpha}:t=fill`);
    parts.push(`drawbox=x=${cx - t}:y=${cy - arm}:w=${t * 2}:h=${arm * 2}:color=red@${alpha}:t=fill`);
    // 外圈空心方块，更容易看见
    const box = arm * 2;
    parts.push(`drawbox=x=${cx - box}:y=${cy - box}:w=${box * 2}:h=${box * 2}:color=red@${alpha}:t=${t}`);
  }
  return parts.join(',');
}

export function setState(state) {
  const next = String(state || 'idle');
  if (next === st.state) return;
  st.state = next;
  st.lastActivityAt = Date.now();
  if (next === 'done') st.doneAt = Date.now();
  else if (next !== 'idle') st.doneAt = 0;
  writeState();
}

async function tick() {
  if (!st.running || st.busy) return;
  const now = Date.now();
  const watching = (now - st.lastFrameFetchAt) < WATCH_MS;
  const active = (now - st.lastActivityAt) < WATCH_MS;

  // ① done 状态保留一段时间后自动关（用户提的「操作完了就不该一直显示」）
  if (st.state === 'done' && st.doneAt && (now - st.doneAt) > DONE_KEEP_MS) {
    await shutdown();
    return;
  }
  // ② 长时间彻底没动静 → 自动关
  if (!watching && !active && (now - Math.max(st.lastFrameFetchAt, st.lastActivityAt, st.startedAt)) > IDLE_SHUTDOWN_MS) {
    await shutdown();
    return;
  }
  // ③ 暂时没人看 → 暂停抓帧，省 CPU
  if (!watching && !active && (now - Math.max(st.lastFrameFetchAt, st.lastActivityAt, st.startedAt)) > IDLE_PAUSE_MS) {
    return;
  }

  st.busy = true;
  try {
    const jpg = await captureAndConvert();
    if (jpg) {
      st.latest = jpg;
      st.frames += 1;
      // **有新帧立刻推给所有长连接** —— 这是消除拍频的关键
      for (const v of st.viewers) writeMjpeg(v, jpg);
      if (st.viewers.size > 0) st.lastFrameFetchAt = Date.now();
    }
  } finally { st.busy = false; }
}

export function setFocusedApp(app) {
  st.focusedApp = String(app || '').slice(0, 200);
  writeState();
}

/** 往一个 MJPEG 长连接写一帧。 */
function writeMjpeg(res, jpg) {
  try {
    res.write('--dshframe\r\n');
    res.write('Content-Type: image/jpeg\r\n');
    res.write('Content-Length: ' + jpg.length + '\r\n\r\n');
    res.write(jpg);
    res.write('\r\n');
  } catch { /* 客户端断了就算了 */ }
}

async function writeState() {
  try {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify({
      port: st.port, running: st.running, startedAt: st.startedAt,
      fps: st.fps, width: st.width, displayId: st.displayId,
      focusedApp: st.focusedApp || '',   // 胶囊靠这个显示"AI 在操作 XX"，以前压根没写
      state: st.state,                   // idle/thinking/looking/acting/done/error
      aspect: st.aspect || 0,            // 真实画面比例，横竖屏自适应用
    }));
  } catch { /* 写不进去不影响推帧 */ }
}

function startServer() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/status') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({
          running: st.running, displayId: st.displayId, fps: st.fps, width: st.width,
          frames: st.frames, errors: st.errors, focusedApp: st.focusedApp,
          // 新增：状态、真实比例、空闲秒数 —— 胶囊靠这些显示「AI 在干什么」
          state: st.state, aspect: st.aspect || 0,
          idleSec: Math.round((Date.now() - Math.max(st.lastFrameFetchAt, st.lastActivityAt, st.startedAt)) / 1000),
        }));
        return;
      }
      if (url.pathname === '/frame.jpg') {
        st.lastFrameFetchAt = Date.now();   // 有人来看 = 有人在看，恢复抓帧
        if (!st.latest) { res.writeHead(503); res.end('no frame yet'); return; }
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
        res.end(st.latest);
        return;
      }
      /**
       * **MJPEG 长连接。**
       *
       * 为什么加：原来客户端每 400ms 轮询一次 /frame.jpg，而服务端 500ms 换帧，
       * 两个周期不同步 → 每约 2 秒会出现一次 810ms 的长停顿（纯算术，可预测）。
       * 用长连接推流就没有这个拍频 —— 一有新帧立刻推。
       */
      if (url.pathname === '/stream.mjpg') {
        st.lastFrameFetchAt = Date.now();
        res.writeHead(200, {
          'content-type': 'multipart/x-mixed-replace; boundary=--dshframe',
          'cache-control': 'no-store',
          'connection': 'keep-alive',
          'pragma': 'no-cache',
        });
        st.viewers.add(res);
        // 先推一帧已有的，别让客户端等
        if (st.latest) writeMjpeg(res, st.latest);
        const cleanup = () => { st.viewers.delete(res); };
        req.on('close', cleanup);
        req.on('error', cleanup);
        res.on('close', cleanup);
        res.on('error', cleanup);
        return;
      }
      res.writeHead(404); res.end('not found');
    });
    // **先试固定端口。** listen(0) 每次重启端口都变，服务一重启悬浮窗就永久失联
    // （它记着旧端口，连不上也不会自己找新的）。
    const FIXED = Number(process.env.DSH_STREAM_PORT || 38801);
    const onListening = () => {
      st.port = srv.address().port;
      st.server = srv;
      resolve(st.port);
    };
    srv.once('error', () => {
      // 固定端口被占 → 退回随机端口（至少能工作，下次启动可能又变）
      try { srv.close(); } catch { /* ignore */ }
      const s2 = createServer(srv.listeners('request')[0]);
      s2.listen(0, '127.0.0.1', () => {
        st.port = s2.address().port;
        st.server = s2;
        resolve(st.port);
      });
    });
    srv.listen(FIXED, '127.0.0.1', onListening);
  });
}

/**
 * 开始推帧。sfId 是 SurfaceFlinger 的 64 位 id（不是 displayId）。
 * fps 默认 2、宽度默认 360——实测这是"长时间看"的推荐档（约 0.30 核、29 KB/s）。
 */
export async function start({ sfId, displayId, fps = 2, width = 360, focusedApp = '' } = {}) {
  if (!sfId) return { ok: false, hint: '缺 SurfaceFlinger id，先 vdisplay_start 建屏。' };
  if (st.running && st.sfId === sfId) {
    // 复用时要更新 App 名：以前直接 return，换 App 后胶囊永远显示推流开始时的那个
    if (focusedApp && focusedApp !== st.focusedApp) { st.focusedApp = String(focusedApp).slice(0, 200); writeState(); }
    return { ok: true, port: st.port, reused: true, focusedApp: st.focusedApp };
  }

  st.sfId = sfId;
  st.displayId = displayId || null;
  // **上限从 4 提到 15。** 原来的 4fps 是桥接协议的遗留限制（JSON 文本帧限 4Hz），
  // 但现在帧走的是 HTTP 回环，那条限制根本不存在 —— 不解开它，所有提帧方案都白搭。
  st.fps = Math.min(Math.max(Number(fps) || 2, 1), 15);
  st.width = Math.min(Math.max(Number(width) || 360, 240), 720);
  st.focusedApp = focusedApp;
  st.latest = null;
  st.frames = 0;
  st.errors = 0;
  st.lastFrameFetchAt = 0;
  st.lastActivityAt = Date.now();
  st.state = 'looking';   // 一开推流就算「在看屏幕」
  st.aspect = 0;
  st.doneAt = 0;
  st.marks = [];

  if (!st.server) await startServer();
  st.running = true;
  st.startedAt = Date.now();

  const interval = Math.round(1000 / st.fps);
  // 换 sfId 时必须先清掉旧定时器：否则两个 tick 叠在一起，抓帧频率翻倍、CPU 也翻倍。
  if (st.timer) { clearInterval(st.timer); st.timer = null; }
  st.timer = setInterval(tick, interval);
  tick();
  await writeState();

  return { ok: true, port: st.port, fps: st.fps, width: st.width };
}

export async function stop() {
  st.running = false;
  if (st.timer) { clearInterval(st.timer); st.timer = null; }
  st.latest = null;
  await writeState();
  return { ok: true };
}

/** 收工：连 HTTP 服务一起关，并删掉状态文件（原生插件就看不到"在操作"了）。 */
export async function shutdown() {
  await stop();
  try { for (const v of st.viewers) { try { v.end(); } catch { } } st.viewers.clear(); } catch { }
  if (st.server) { st.server.close(); st.server = null; }
  st.port = 0;
  try { await rm(STATE_FILE, { force: true }); } catch {}
  return { ok: true };
}

export function info() {
  return {
    running: st.running, port: st.port, fps: st.fps, width: st.width,
    displayId: st.displayId, frames: st.frames, errors: st.errors,
    bytesPerFrame: st.latest?.length || 0,
  };
}

/**
 * reconcileState —— 修掉「状态文件说谎」
 *
 * ## 问题
 *
 * stream.json 记录 `running: true`，但推流是绑在**创建虚拟屏的那个进程**上的。
 * 进程一退，屏没了、端口也没了，可状态文件还写着「在跑」。
 *
 * 结果：DSH Go 的「AI 画面」胶囊读这个文件，以为有画面，实际拿不到 ——
 * 用户看到的就是「胶囊里没有画面」。
 *
 * ## 做法
 *
 * 模块加载时验证一次：文件说在跑，就去连一下端口。
 * 连不上 = 那个进程已经死了，把状态改回 false，别让胶囊再被骗。
 *
 * 用例：
 *   await reconcileStreamState();
 */
export async function reconcileStreamState() {
  try {
    const raw = await readFile(STATE_FILE, 'utf8');
    const st = JSON.parse(raw);
    if (!st.running || !st.port) return { healed: false, reason: '不在运行' };
    // 试着连一下
    const ok = await new Promise((resolve) => {
      const req = request({
        host: '127.0.0.1', port: st.port, path: '/', method: 'GET', timeout: 800,
      }, (res) => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
    if (ok) return { healed: false, reason: '端口还活着' };
    // 死了 —— 改写状态
    await writeFile(STATE_FILE, JSON.stringify({
      port: 0, running: false, startedAt: 0,
      fps: st.fps || 2, width: st.width || 360,
      displayId: null, focusedApp: '',
    }));
    return { healed: true, reason: `端口 ${st.port} 已死，状态已重置` };
  } catch {
    return { healed: false, reason: '没有状态文件' };
  }
}
