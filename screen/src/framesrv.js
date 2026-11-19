/**
 * 常驻取帧服务（ImageReader）的 Node 侧管理 —— **多实例版**。
 *
 * ## 为什么需要
 *
 * `screencap` 每帧要 141ms 的 Surface 回读，加起来 227-243ms/帧 = 2.5fps，
 * 这是 screencap 的工作方式决定的，改不了。`ImageReader` 从合成器直接拿 buffer，
 * 实测 76fps，快 30 倍。
 *
 * ## 为什么是多实例
 *
 * 上一版是**单例**：模块级 `state` 只有一个，`start()` 第一件事是 `await stop()` ——
 * 于是「开第二块屏」会把「第一块屏的推流」停掉，第一个悬浮窗因 `/status` 说
 * running:false 而自己关掉。**多窗口因此永远只剩一个。**
 *
 * 现在按 displayId 分组：
 *
 *   servers: Map<displayId, {port, size, proc, startedAt}>
 *
 * Java 侧本来就接受 `--display=N --port=P` 参数，**一个 displayId 一个 app_process 进程**，
 * 天然可以并存。端口从 38820 往上分配，跳过已占用的。
 *
 * ## 兼容
 *
 * `stop()` / `info()` 不传 displayId 时作用于「全部」/「活动的那一个」，
 * 老调用方不用改。
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
const BASE_PORT = 38820;
const MAX_PORT = 38840;          // 最多 20 块屏，够了

/**
 * displayId → 实例。
 *
 * 用 Map 而不是对象：displayId 是数字，Map 的键类型稳定，
 * 而且能保证 `for (const [id, v] of servers)` 的插入顺序（级联顺序靠它）。
 */
const servers = new Map();

/** 当前「活动」的 displayId（最后一次 start 的那个），给不带参数的调用用。 */
let activeDisplayId = null;

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

/** 推 dex 到设备（内容一样就跳过）。多个实例共用同一个 dex 文件。 */
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

/** 分配一个没被占用的端口。 */
function allocPort() {
  const used = new Set();
  for (const s of servers.values()) used.add(s.port);
  for (let p = BASE_PORT; p < MAX_PORT; p++) {
    if (!used.has(p)) return p;
  }
  return 0;
}

/** 查这块屏的真实尺寸。 */
async function realSize(target, displayId, fallbackW, fallbackH) {
  try {
    const r = await run('adb', ['-s', target, 'shell',
      `dumpsys display 2>/dev/null | grep -A6 "Display ${displayId}:" | grep -oE "real [0-9]+ x [0-9]+" | head -1`],
      { timeout: 8000 });
    const m = String(r.stdout || '').match(/real (\d+) x (\d+)/);
    if (m) return { w: Number(m[1]), h: Number(m[2]) };
  } catch { /* 查不到就用传入值 */ }
  return { w: fallbackW, h: fallbackH };
}

/**
 * 为一块屏启动取帧服务。
 *
 * @param {{displayId:number, width?:number, height?:number, port?:number, mirror?:string}} opt
 * @returns {Promise<{ok:boolean, port?:number, reused?:boolean, why?:string, fps?:number}>}
 */
export async function start({ displayId, width, height, port, mirror } = {}) {
  if (!displayId) return { ok: false, why: '缺 displayId' };

  // 已经在跑这块屏 → 复用（探活确认）
  const cur = servers.get(displayId);
  if (cur) {
    const p = await probe(cur.port);
    if (p.ok) {
      activeDisplayId = displayId;
      return { ok: true, port: cur.port, reused: true, fps: p.info?.fps || 0 };
    }
    // 死了 → 清掉重来
    servers.delete(displayId);
  }

  const target = await adbTarget();
  const pushed = await pushDex(target);
  if (!pushed.ok) return pushed;

  const real = await realSize(target, displayId, width || 720, height || 1592);
  const size = `${real.w}x${real.h}`;

  const usePort = port || allocPort();
  if (!usePort) return { ok: false, why: `端口用完了（${BASE_PORT}-${MAX_PORT}）` };

  // mirror 参数：把这块屏镜像到 dsh-frames 虚拟屏（悬浮窗读它）
  // 不传就让 Java 侧自己建默认的镜像屏
  const mirrorArg = mirror ? ` --mirror=${mirror}` : '';
  const cmd = `CLASSPATH=${REMOTE_DEX} app_process / com.dsh.framesrv.Main`
    + ` --display=${displayId} --port=${usePort} --width=400 --size=${size}${mirrorArg}`;

  try {
    const child = spawn('adb', ['-s', target, 'shell', cmd], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    servers.set(displayId, {
      port: usePort, displayId, size, proc: child, startedAt: Date.now(),
    });
  } catch (e) {
    return { ok: false, why: '启动失败: ' + String(e?.message || e).slice(0, 80) };
  }

  // 等端口起来（最多 8 秒）
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const p = await probe(usePort);
    if (p.ok) {
      activeDisplayId = displayId;
      return { ok: true, port: usePort, fps: p.info?.fps || 0, reused: false };
    }
  }
  // 起不来就清掉，别留死记录
  servers.delete(displayId);
  return { ok: false, why: '启动后 8 秒内端口没起来（看 logcat: app_process 可能崩了）' };
}

/** 请一个实例自己退出。 */
async function quit(port) {
  try {
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
}

/**
 * 停取帧服务。
 * @param {number} [displayId] 只停这一块；省略 = 全停。
 */
export async function stop(displayId) {
  if (displayId != null) {
    const s = servers.get(displayId);
    if (s) {
      await quit(s.port);
      servers.delete(displayId);
      try { s.proc?.kill?.(); } catch { /* ignore */ }
    }
    if (activeDisplayId === displayId) activeDisplayId = firstKey();
    return { ok: true, stopped: displayId ? 1 : 0 };
  }
  // 全停
  const ports = [...servers.values()].map((s) => s.port);
  for (const p of ports) await quit(p);
  for (const s of servers.values()) { try { s.proc?.kill?.(); } catch { /* ignore */ } }
  servers.clear();
  activeDisplayId = null;
  return { ok: true, stopped: ports.length };
}

function firstKey() {
  for (const k of servers.keys()) return k;
  return null;
}

/**
 * 状态。
 * @param {number} [displayId] 查这一块；省略 = 返回活动那块 + 全部列表。
 */
export async function info(displayId) {
  if (displayId != null) {
    const s = servers.get(displayId);
    if (!s) return { running: false, displayId };
    const p = await probe(s.port);
    if (!p.ok) {
      servers.delete(displayId);
      return { running: false, displayId };
    }
    return { running: true, port: s.port, displayId, size: s.size, ...(p.info || {}) };
  }
  // 无参：活动那块（兼容老调用）+ 全部
  const all = [];
  for (const [id, s] of servers) {
    const p = await probe(s.port);
    all.push({ displayId: id, port: s.port, size: s.size, running: p.ok, ...(p.ok ? (p.info || {}) : {}) });
  }
  const act = activeDisplayId != null ? all.find((x) => x.displayId === activeDisplayId) : all[0];
  return {
    running: !!(act && act.running),
    port: act?.port || 0,
    displayId: act?.displayId ?? null,
    size: act?.size || '',
    count: all.length,
    servers: all,
  };
}

/** 把点击位置发给 framesrv，下一帧会画十字。 */
export async function markTap(nx, ny, displayId) {
  // **端口优先用进程内状态，没有就回退到 stream.json。**
  // 实机踩到：模块状态是进程内的，换一个 Node 进程调 input 时 port 是 0
  // → 标记发不出去 → 用户看不到点击位置。
  let port = 0;
  const want = displayId != null ? displayId : activeDisplayId;
  const s = want != null ? servers.get(want) : null;
  if (s) port = s.port;
  if (!port && servers.size === 1) port = [...servers.values()][0].port;
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

/** 活动实例的端口（兼容老调用）。 */
export function currentPort() {
  const s = activeDisplayId != null ? servers.get(activeDisplayId) : null;
  if (s) return s.port;
  if (servers.size === 1) return [...servers.values()][0].port;
  return 0;
}

/** 是否有实例在跑（兼容老调用）。 */
export function isRunning() { return servers.size > 0; }

/** 所有实例（诊断用）。 */
export function listServers() {
  return [...servers.entries()].map(([id, s]) => ({ displayId: id, port: s.port, size: s.size }));
}

/** 指定/活动实例的端口。 */
export function portOf(displayId) {
  const s = displayId != null ? servers.get(displayId) : (activeDisplayId != null ? servers.get(activeDisplayId) : null);
  return s ? s.port : 0;
}

/** 设活动屏（screen_use 切屏时调）。 */
export function setActive(displayId) {
  if (servers.has(displayId)) { activeDisplayId = displayId; return true; }
  return false;
}
