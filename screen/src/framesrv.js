/**
 * 常驻取帧服务（ImageReader）的 Node 侧管理。
 *
 * ## 为什么需要
 *
 * `screencap` 每帧要 141ms 的 Surface 回读（实测裸截图 141ms、PNG 再 +98ms），
 * 加起来 227-243ms/帧 = 2.5fps，这是 screencap 的工作方式决定的，改不了。
 *
 * `ImageReader` 从合成器直接拿 buffer，实测 76fps。快 30 倍。
 *
 * ## 怎么管
 *
 * 用 `app_process` 跑一个 Java 服务（源码在 `framesrv/`），它自己 serve HTTP。
 * 这里只负责：推 dex、起进程、等端口、健康检查、收工。
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { adbTarget } from './target.js';

const run = promisify(execFile);

const REMOTE_DIR = '/data/local/tmp/dshframe';
const REMOTE_DEX = REMOTE_DIR + '/frame.dex';
const DEFAULT_PORT = 38820;

const state = {
  running: false,
  port: 0,
  displayId: null,
  size: '',
  proc: null,
  startedAt: 0,
};

function pkgRoot() {
  try { return join(dirname(fileURLToPath(import.meta.url)), '..'); }
  catch { return process.cwd(); }
}

/** 找编译好的 dex。没有就返回 null（调用方降级）。 */
function findDex() {
  const root = pkgRoot();
  for (const rel of ['../framesrv/build/classes.dex', '../framesrv/classes.dex']) {
    const p = join(root, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

/** 推 dex 到设备（内容一样就跳过）。 */
async function pushDex(target) {
  const local = findDex();
  if (!local) return { ok: false, why: '没找到 framesrv/build/classes.dex（先编译 framesrv）' };
  try {
    await run('adb', ['-s', target, 'shell', `mkdir -p ${REMOTE_DIR}`], { timeout: 8000 });
    const r = await run('adb', ['-s', target, 'push', local, REMOTE_DEX], { timeout: 20000 });
    const out = String(r.stdout || '') + String(r.stderr || '');
    if (/error|failed/i.test(out) && !/1 file pushed/.test(out)) {
      return { ok: false, why: 'push 失败: ' + out.slice(0, 80) };
    }
    await run('adb', ['-s', target, 'shell', `chmod 644 ${REMOTE_DEX}`], { timeout: 8000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, why: 'push 异常: ' + String(e?.message || e).slice(0, 80) };
  }
}

/** 探活：/status 能通就算活着。 */
async function probe(port) {
  try {
    const { request } = await import('node:http');
    return await new Promise((resolve) => {
      const req = request({
        host: '127.0.0.1', port, path: '/status', method: 'GET', timeout: 700,
      }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          try { resolve({ ok: true, info: JSON.parse(body) }); }
          catch { resolve({ ok: false }); }
        });
      });
      req.on('error', () => resolve({ ok: false }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
      req.end();
    });
  } catch { return { ok: false }; }
}

/**
 * 启动取帧服务。
 *
 * @param {{displayId:number, width:number, height:number, port?:number}} opt
 */
export async function start({ displayId, width, height, port = DEFAULT_PORT } = {}) {
  if (!displayId) return { ok: false, why: '缺 displayId' };
  // 已经在跑同尺寸/同屏 → 复用
  if (state.running && state.displayId === displayId) {
    const p = await probe(state.port);
    if (p.ok) return { ok: true, port: state.port, reused: true };
  }
  await stop();

  const target = await adbTarget();
  const pushed = await pushDex(target);
  if (!pushed.ok) return pushed;

  // **查这块屏的真实尺寸，不要用调用方传的兜底值。**
  // 实机踩到：横屏游戏 1592x720，但 vd.start() 不返回 width/height，
  // 兜底成 720x1592 → 镜像压扁 + 巨大黑边，用户看到的就是「黑边太严重」。
  let realW = width, realH = height;
  try {
    const r = await run('adb', ['-s', target, 'shell',
      `dumpsys display 2>/dev/null | grep -A6 "Display ${displayId}:" | grep -oE "real [0-9]+ x [0-9]+" | head -1`],
      { timeout: 8000 });
    const m = String(r.stdout || '').match(/real (\d+) x (\d+)/);
    if (m) { realW = Number(m[1]); realH = Number(m[2]); }
  } catch { /* 查不到就用传入值 */ }
  const size = `${realW}x${realH}`;
  const cmd = `CLASSPATH=${REMOTE_DEX} app_process / com.dsh.framesrv.Main`
    + ` --display=${displayId} --port=${port} --width=400 --size=${size}`;

  // **用 adb shell 起，不阻塞** —— 用 nohup 风格 + & 让它常驻
  try {
    const child = spawn('adb', ['-s', target, 'shell', cmd], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    state.proc = child;
  } catch (e) {
    return { ok: false, why: '启动失败: ' + String(e?.message || e).slice(0, 80) };
  }

  // 等端口起来（最多 8 秒）
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const p = await probe(port);
    if (p.ok) {
      state.running = true;
      state.port = port;
      state.displayId = displayId;
      state.size = size;
      state.startedAt = Date.now();
      return { ok: true, port, fps: p.info?.fps || 0, reused: false };
    }
  }
  return { ok: false, why: '启动后 8 秒内端口没起来（看 logcat: app_process 可能崩了）' };
}

/** 停服务。 */
export async function stop() {
  const port = state.port || DEFAULT_PORT;
  try {
    // 先请它自己退
    const { request } = await import('node:http');
    await new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/quit', timeout: 500 }, (res) => {
        res.resume(); res.on('end', resolve);
      });
      req.on('error', () => resolve());
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.end();
    });
  } catch { /* ignore */ }
  state.running = false;
  state.port = 0;
  state.displayId = null;
  return { ok: true };
}

/** 状态。 */
export async function info() {
  if (!state.running) return { running: false };
  const p = await probe(state.port);
  return {
    running: p.ok,
    port: state.port,
    displayId: state.displayId,
    size: state.size,
    ...(p.info || {}),
  };
}

/** 把点击位置发给 framesrv，下一帧会画十字。 */
export async function markTap(nx, ny) {
  // **端口优先用进程内状态，没有就回退到 stream.json。**
  // 实机踩到：模块状态是进程内的，换一个 Node 进程调 input 时 state.port 是 0
  // → 标记发不出去 → 用户看不到点击位置。真实插件里是同一个引擎进程，
  // 但进程重启/热重载时状态会丢，所以必须有兜底。
  let port = state.port && state.running ? state.port : 0;
  if (!port) {
    try {
      const { readFile } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const raw = await readFile(join(homedir(), '.dsh', 'plugin-screen', 'stream.json'), 'utf8');
      const j = JSON.parse(raw);
      if (j && j.port && (j.backend === 'imagereader')) port = Number(j.port);
    } catch { /* 读不到就算了 */ }
  }
  if (!port) return;
  try {
    const { request } = await import('node:http');
    const x = Math.max(0, Math.min(1, Number(nx)));
    const y = Math.max(0, Math.min(1, Number(ny)));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    await new Promise((resolve) => {
      const req = request({
        host: '127.0.0.1', port,
        path: `/mark?nx=${x.toFixed(4)}&ny=${y.toFixed(4)}`,
        method: 'GET', timeout: 600,
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', () => resolve());
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.end();
    });
  } catch { /* 画不上就算了 */ }
}

export function currentPort() { return state.port; }
export function isRunning() { return state.running; }
