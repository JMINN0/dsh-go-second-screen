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

  const size = `${width}x${height}`;
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

export function currentPort() { return state.port; }
export function isRunning() { return state.running; }
